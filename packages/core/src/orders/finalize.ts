import type { PluginContext } from "emdash";
import { releaseLock } from "../cart/lock";
import { consumeAndAccountCoupon } from "../coupons/reservations";
import { cartKey } from "../cart/store";
import { InventoryError, finalizeOrderInventory } from "../inventory";
import { zero } from "../money";
import type {
	CartState,
	Coupon,
	CouponUsage,
	Customer,
	Order,
	OrderItem,
	PaymentRecord,
} from "../types";
import { collection, digest, insertOnce, mutate } from "../util/conditional";
import { isUniqueViolation } from "../util/storage";
import { ensureOrderGrants } from "./grants";
import { enqueueReceipt } from "./outbox";

export interface FinalizePaymentInput {
	provider: "stripe" | "paystack";
	mode: "test" | "live";
	reference: string;
	orderDraftId: string;
	cartSnapshot: CartState;
	inventoryReservationId?: string;
	stripe?: { paymentIntentId: string; customerId?: string; chargeId?: string };
	paymentMethodType?: string;
}
function cartIntent(cart: CartState) {
	return {
		sessionId: cart.sessionId,
		createdAt: cart.createdAt,
		currency: cart.currency,
		customerEmail: cart.customerEmail,
		billingAddress: cart.billingAddress,
		shippingAddress: cart.shippingAddress,
		shippingMethodId: cart.shippingMethod?.id,
		coupons: cart.coupons.map((coupon) => coupon.code),
		notes: cart.notes,
		items: cart.items.map((line) => ({
			lineId: line.lineId,
			productId: line.productId,
			variantId: line.variantId,
			quantity: line.quantity,
			customisation: line.customisation,
		})),
	};
}
export async function clearPurchasedCart(ctx: PluginContext, purchased: CartState) {
	const key = cartKey(purchased.sessionId);
	const current = await ctx.kv.getVersioned<CartState>(key);
	if (
		current &&
		(await digest(cartIntent(current.value))) === (await digest(cartIntent(purchased)))
	)
		await ctx.kv.compareAndDelete(key, current.revision);
}
async function nextOrderNumber(ctx: PluginContext, test: boolean) {
	for (let i = 0; i < 30; i++) {
		const key = test ? "state:testOrderNumberCounter" : "state:orderNumberCounter";
		const previous = await ctx.kv.getVersioned<number>(key);
		const next = (previous?.value ?? 1000) + 1;
		if ((await ctx.kv.compareAndSet(key, previous?.revision ?? null, next)).applied) {
			const prefix = test ? "TEST-" : ((await ctx.kv.get<string>("state:orderNumberPrefix")) ?? "");
			return `${prefix}${next}`;
		}
	}
	throw new Error("Order number contention; retry");
}
/** CAS counter prevents current races; retry also repairs a stale/missing migrated KV counter. */
async function insertOrder(ctx: PluginContext, candidate: Order): Promise<Order> {
	const orders = collection<Order>(ctx, "orders");
	const payments = collection<PaymentRecord>(ctx, "payments");
	let order = candidate;
	for (let i = 0; i < 20; i++) {
		try {
			return await insertOnce(orders, order.id, order);
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			const collision = (
				await orders.query({ where: { orderNumber: order.orderNumber }, limit: 1 })
			).items[0];
			if (!collision || collision.id === order.id) throw error;
			const fresh = await nextOrderNumber(ctx, order.paymentMode === "test");
			const claim = await mutate(payments, order.id, (p) =>
				p.orderNumber === order.orderNumber ? { ...p, orderNumber: fresh } : p,
			);
			if (!claim.orderNumber) throw new Error("Order number missing");
			order = { ...order, orderNumber: claim.orderNumber };
		}
	}
	throw new Error("Order number collisions; reconcile counter and retry");
}
async function ensureCustomer(ctx: PluginContext, email: string, cart: CartState, now: string) {
	const store = collection<Customer>(ctx, "customers");
	const existing = (await store.query({ where: { email }, limit: 1 })).items[0];
	if (existing) return existing.id;
	const id = `customer_${await digest(email)}`;
	try {
		await insertOnce(store, id, {
			id,
			email,
			firstName: cart.billingAddress?.firstName,
			lastName: cart.billingAddress?.lastName,
			phone: cart.billingAddress?.phone,
			ordersCount: 0,
			totalSpent: {},
			acceptsMarketing: false,
			createdAt: now,
			updatedAt: now,
		});
		return id;
	} catch (err) {
		if (!isUniqueViolation(err)) throw err;
		const winner = (await store.query({ where: { email }, limit: 1 })).items[0];
		if (!winner) throw err;
		return winner.id;
	}
}
async function accountCustomer(ctx: PluginContext, order: Order) {
	if (order.paymentMode === "test") return;
	await mutate(collection<Customer>(ctx, "customers"), order.customerId, (c) => {
		if (c.accountedOrderIds?.[order.id]) return c;
		const total = (c.totalSpent[order.currency] ?? 0) + order.total.amount;
		if (!Number.isSafeInteger(total))
			throw new Error("Customer total exceeds safe integer accounting");
		return {
			...c,
			ordersCount: c.ordersCount + 1,
			totalSpent: { ...c.totalSpent, [order.currency]: total },
			accountedOrderIds: { ...c.accountedOrderIds, [order.id]: true as const },
			updatedAt: new Date().toISOString(),
		};
	});
}
async function accountCoupons(
	ctx: PluginContext,
	order: Order,
	cart: CartState,
	draftId: string,
): Promise<string | undefined> {
	// Test orders never consume live promotional limits or financial aggregates.
	if (order.paymentMode === "test") return;
	type AccountedCoupon = Coupon & { accountedOrderIds?: Record<string, true> };
	const coupons = collection<AccountedCoupon>(ctx, "coupons");
	for (const applied of cart.coupons) {
		const stored = applied.couponId ? await coupons.get(applied.couponId) : null;
		const row = applied.couponId
			? null
			: (await coupons.query({ where: { code: applied.code.toUpperCase() }, limit: 1 })).items[0];
		const coupon =
			stored && applied.couponId
				? { ...stored, id: applied.couponId }
				: row
					? { ...row.data, id: row.id }
					: null;
		if (!coupon) return `coupon_record_missing:${applied.code}`;
		if (
			!(await consumeAndAccountCoupon(
				ctx,
				coupon,
				draftId,
				order.id,
				order.customerId,
				applied.discountAmount,
				order.createdAt,
			))
		)
			return `coupon_quota_lost:${coupon.code}`;
	}
	return undefined;
}
/** One recoverable path for authenticated provider payments. Callers must verify
 * provider amount/currency/mode before entering. All monetary effects have their
 * dedup key in the SAME CAS record as the counter; marker commits LAST. */
export async function finalizePayment(
	ctx: PluginContext,
	input: FinalizePaymentInput,
): Promise<{ order: Order; duplicate: boolean }> {
	const cart = input.cartSnapshot;
	if (!cart.billingAddress || !cart.shippingAddress || !cart.customerEmail?.includes("@"))
		throw new Error("Incomplete purchased cart");
	if (
		!Number.isSafeInteger(cart.total.amount) ||
		cart.total.amount <= 0 ||
		cart.total.currency !== cart.currency
	)
		throw new Error("Invalid paid total");
	if (input.provider !== "stripe" && input.stripe)
		throw new Error("Stripe identity on non-Stripe payment");
	const id = `order_${await digest(input.orderDraftId)}`;
	const paymentKey = `${input.provider}:${input.mode}:${input.reference}`;
	const payments = collection<PaymentRecord>(ctx, "payments");
	const orders = collection<Order>(ctx, "orders");
	const snapshotHash = await digest({
		cart,
		mode: input.mode,
		provider: input.provider,
		reference: input.reference,
	});
	let claim = await insertOnce(payments, id, {
		id,
		paymentKey,
		provider: input.provider,
		mode: input.mode,
		orderDraftId: input.orderDraftId,
		amount: cart.total,
		status: "verified",
		orderId: id,
		snapshotHash,
		verifiedAt: new Date().toISOString(),
	});
	if (claim.paymentKey !== paymentKey || claim.snapshotHash !== snapshotHash)
		throw new Error("Payment/snapshot claim conflict");
	if (claim.status === "finalized") {
		const order = await orders.get(id);
		if (!order) throw new Error("Finalized order missing; manual recovery required");
		return { order, duplicate: true };
	}
	if (!claim.orderNumber) {
		const orderNumber = await nextOrderNumber(ctx, input.mode === "test");
		claim = await mutate(payments, id, (p) => (p.orderNumber ? p : { ...p, orderNumber }));
	}
	if (!claim.orderNumber) throw new Error("Order number allocation missing");
	const now = claim.verifiedAt;
	const customerId = await ensureCustomer(ctx, cart.customerEmail.toLowerCase(), cart, now);
	const prior = await orders.get(id);
	let order = await insertOrder(ctx, {
		id,
		orderNumber: claim.orderNumber,
		status: "processing",
		paymentStatus: "paid",
		customerId,
		customerEmail: cart.customerEmail.toLowerCase(),
		currency: cart.currency,
		billingAddress: cart.billingAddress,
		shippingAddress: cart.shippingAddress,
		...(cart.shippingMethod
			? { shippingMethodId: cart.shippingMethod.id, shippingMethodLabel: cart.shippingMethod.label }
			: {}),
		subtotal: cart.subtotal,
		discountTotal: cart.discountTotal,
		shippingTotal: cart.shippingTotal,
		taxTotal: cart.taxTotal,
		total: cart.total,
		paidTotal: cart.total,
		refundedTotal: zero(cart.currency),
		taxLines: cart.taxLines,
		couponCodes: cart.coupons.map((c) => c.code),
		paymentProvider: input.provider,
		paymentMode: input.mode,
		paymentReference: paymentKey,
		...(input.stripe
			? {
					stripePaymentIntentId: input.stripe.paymentIntentId,
					...(input.stripe.customerId ? { stripeCustomerId: input.stripe.customerId } : {}),
					...(input.stripe.chargeId ? { stripeChargeId: input.stripe.chargeId } : {}),
				}
			: {}),
		...(input.paymentMethodType ? { paymentMethodType: input.paymentMethodType } : {}),
		...(cart.notes ? { customerNote: cart.notes } : {}),
		metadata: {
			orderDraftId: input.orderDraftId,
			inventoryReservationId: input.inventoryReservationId ?? input.orderDraftId,
			testMode: input.mode === "test",
			fulfillment: input.mode === "test" ? "suppressed-test" : "normal",
			receipt: input.mode === "test" ? "preview-only" : "outbox",
		},
		createdAt: now,
		updatedAt: now,
		paidAt: now,
	});
	if (order.paymentReference !== paymentKey) throw new Error("Order payment identity conflict");
	const items: OrderItem[] = [];
	for (const [index, line] of cart.items.entries()) {
		const itemId = `${id}:${index}`;
		items.push(
			await insertOnce(collection<OrderItem>(ctx, "order_items"), itemId, {
				id: itemId,
				orderId: id,
				productId: line.productId,
				...(line.variantId ? { variantId: line.variantId } : {}),
				sku: "",
				name: line.title,
				...(line.customisation ? { customisation: line.customisation } : {}),
				quantity: line.quantity,
				unitPrice: line.unitPrice,
				lineSubtotal: line.lineSubtotal,
				discountAmount: line.discountAmount ?? zero(cart.currency),
				taxAmount: line.taxAmount ?? zero(cart.currency),
				total: {
					currency: cart.currency,
					amount: Math.max(
						0,
						line.lineSubtotal.amount -
							(line.discountAmount?.amount ?? 0) +
							(line.taxAmount?.amount ?? 0),
					),
				},
				isDigital: line.isDigital,
				...(line.vendorId ? { vendorId: line.vendorId } : {}),
				...(line.subscriptionConfig ? { subscriptionConfig: line.subscriptionConfig } : {}),
			}),
		);
	}
	if (!claim.inventoryStatus) {
		let inventoryStatus: PaymentRecord["inventoryStatus"] = "not_required";
		let inventoryReason: string | undefined;
		if (items.length) {
			try {
				await finalizeOrderInventory(ctx, {
					orderId: id,
					orderDraftId: input.orderDraftId,
					items,
					reservationId: input.inventoryReservationId,
					mode: input.mode,
				});
				inventoryStatus = "consumed";
			} catch (err) {
				if (
					!(err instanceof InventoryError) ||
					![
						"reservation_not_found",
						"reservation_expired",
						"reservation_inactive",
						"catalogue_changed",
					].includes(err.code)
				)
					throw err;
				inventoryStatus = "manual_review";
				inventoryReason = err.code;
			}
		}
		claim = await mutate(payments, id, (p) =>
			p.inventoryStatus
				? p
				: { ...p, inventoryStatus, ...(inventoryReason ? { inventoryReason } : {}) },
		);
	}
	order = await mutate(orders, id, (o) =>
		o.metadata?.inventoryStatus
			? o
			: {
					...o,
					// Never reset a cancellation/completion/refund or another merchant decision on replay.
					status:
						claim.inventoryStatus === "manual_review" && o.status === "processing"
							? "on-hold"
							: o.status,
					metadata: {
						...o.metadata,
						inventoryStatus: claim.inventoryStatus,
						...(claim.inventoryReason ? { inventoryReason: claim.inventoryReason } : {}),
					},
				},
	);
	await accountCustomer(ctx, order);
	const couponReviewReason = await accountCoupons(ctx, order, cart, input.orderDraftId);
	if (couponReviewReason) {
		order = await mutate(orders, id, (o) => ({
			...o,
			status: o.status === "processing" ? "on-hold" : o.status,
			metadata: { ...o.metadata, couponStatus: "manual_review", couponReason: couponReviewReason },
		}));
	}
	if (
		!couponReviewReason &&
		claim.inventoryStatus !== "manual_review" &&
		!["cancelled", "failed", "refunded", "on-hold"].includes(order.status)
	)
		await ensureOrderGrants(ctx, order, items);
	await enqueueReceipt(ctx, order, items);
	await releaseLock(ctx, input.orderDraftId);
	await clearPurchasedCart(ctx, cart);
	await mutate(payments, id, (p) =>
		p.status === "finalized" ? p : { ...p, status: "finalized" as const },
	);
	const finalizedOrder = await orders.get(id);
	if (!finalizedOrder) throw new Error("Finalized order missing; manual recovery required");
	return { order: finalizedOrder, duplicate: Boolean(prior) };
}
