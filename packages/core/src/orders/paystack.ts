import type { PluginContext } from "emdash";
import type { CartState, Customer, Order, OrderItem, PaymentRecord } from "../types";
import { cartKey } from "../cart/store";
import { attempts, type PaymentAttempt } from "../payment-provider/paystack-test";
import { zero } from "../money";
import { isUniqueViolation } from "../util/storage";
import { consumeInventoryReservation, InventoryError } from "../inventory";
import { collection, digest, insertOnce, mutate } from "../util/conditional";

// Compare shopper intent, not cached prices/totals that checkout repriced.
function cartIntent(cart: CartState) {
	return {
		sessionId: cart.sessionId,
		createdAt: cart.createdAt,
		currency: cart.currency,
		customerEmail: cart.customerEmail,
		billingAddress: cart.billingAddress,
		shippingAddress: cart.shippingAddress,
		shippingMethodId: cart.shippingMethod?.id,
		coupons: cart.coupons,
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
async function clearPurchasedCart(ctx: PluginContext, purchased: CartState) {
	const key = cartKey(purchased.sessionId);
	const current = await ctx.kv.getVersioned<CartState>(key);
	if (
		current &&
		(await digest(cartIntent(current.value))) === (await digest(cartIntent(purchased)))
	) {
		// A newer tab/cart mutation between comparison and deletion must survive.
		await ctx.kv.compareAndDelete(key, current.revision);
	}
}

/** Every effect is insert-only or CAS-monotonic. No lease, put/UPSERT claim,
 * email delivery, or legacy CMS decrement. Marker is written LAST. */
export async function finalizePaystackTest(
	ctx: PluginContext,
	attempt: PaymentAttempt,
): Promise<{ order: Order; duplicate: boolean }> {
	const durable = await attempts(ctx).get(attempt.id);
	if (durable?.outcome !== "verified") throw new Error("Durable verified test payment required");
	attempt = durable;
	const cart = durable.cart;
	if (
		cart.total.amount !== attempt.amount ||
		cart.currency !== attempt.currency ||
		cart.customerEmail?.toLowerCase() !== attempt.email.toLowerCase() ||
		!cart.billingAddress ||
		!cart.shippingAddress
	)
		throw new Error("Checkout snapshot does not match verified attempt");
	const id = `test_${attempt.orderDraftId}`;
	const orders = collection<Order>(ctx, "orders");
	const payments = collection<PaymentRecord>(ctx, "payments");
	const paymentKey = `paystack-test:${attempt.reference}`;
	let claim =
		(await payments.get(id)) ??
		(await insertOnce(payments, id, {
			id,
			paymentKey,
			provider: "paystack-test",
			orderDraftId: attempt.id,
			amount: cart.total,
			status: "verified_test",
			orderId: id,
			verifiedAt: new Date().toISOString(),
		}));
	if (
		claim.paymentKey !== paymentKey ||
		claim.amount.amount !== attempt.amount ||
		claim.amount.currency !== attempt.currency
	)
		throw new Error("Payment claim conflict");
	if (claim.status === "finalized_test") {
		const order = await orders.get(id);
		if (!order) throw new Error("Finalized order missing; manual recovery required");
		return { order, duplicate: true };
	}
	if (!claim.inventoryStatus) {
		let inventoryStatus: NonNullable<PaymentRecord["inventoryStatus"]> = "not_required";
		let inventoryReason: string | undefined;
		if (attempt.inventoryLines.length) {
			try {
				await consumeInventoryReservation(ctx, attempt.id);
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
	const customers = collection<Customer>(ctx, "customers");
	const email = attempt.email.toLowerCase();
	let customerId = (await customers.query({ where: { email }, limit: 1 })).items[0]?.id;
	const now = claim.verifiedAt;
	if (!customerId) {
		customerId = `test_${await digest(email)}`;
		try {
			await insertOnce(customers, customerId, {
				id: customerId,
				email,
				ordersCount: 0,
				totalSpent: {},
				acceptsMarketing: false,
				createdAt: now,
				updatedAt: now,
			});
		} catch (err) {
			if (!isUniqueViolation(err)) throw err;
			customerId = (await customers.query({ where: { email }, limit: 1 })).items[0]?.id;
			if (!customerId) throw err;
		}
	}
	const prior = await orders.get(id);
	const order = await insertOnce(orders, id, {
		id,
		orderNumber: `TEST-${attempt.orderDraftId}`,
		status: "on-hold",
		paymentStatus: "paid",
		customerId,
		customerEmail: attempt.email,
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
		couponCodes: [],
		paymentProvider: "paystack-test",
		paymentReference: paymentKey,
		metadata: {
			orderDraftId: attempt.id,
			testMode: true,
			fulfillment: "manual-review-required",
			receipt: "preview-only",
			inventoryStatus: claim.inventoryStatus,
			...(claim.inventoryReason ? { inventoryReason: claim.inventoryReason } : {}),
		},
		createdAt: now,
		updatedAt: now,
		paidAt: now,
	});
	if (order.paymentReference !== paymentKey) throw new Error("Order identity conflict");
	for (const [index, line] of cart.items.entries()) {
		const itemId = `${id}_${index}`;
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
			discountAmount: zero(cart.currency),
			taxAmount: zero(cart.currency),
			total: line.lineSubtotal,
			isDigital: line.isDigital,
		});
	}
	if (typeof ctx.kv.compareAndSet !== "function")
		throw new Error("Conditional KV required for receipt preview");
	const outboxKey = `receipt-preview:${id}`;
	const preview = {
		id,
		orderId: id,
		paymentKey,
		status: "preview_only",
		testMode: true,
		delivery: "disabled",
		recipient: email,
		subject: `TEST ONLY — ${order.orderNumber}`,
		total: cart.total,
		items: cart.items,
		inventoryStatus: claim.inventoryStatus,
		createdAt: now,
	};
	if (!(await ctx.kv.compareAndSet(outboxKey, null, preview)).applied) {
		const existing = await ctx.kv.get<{ paymentKey: string }>(outboxKey);
		if (existing?.paymentKey !== paymentKey) throw new Error("Receipt preview conflict");
	}
	await clearPurchasedCart(ctx, cart);
	await mutate(payments, id, (p) =>
		p.status === "finalized_test" ? p : { ...p, status: "finalized_test" as const },
	);
	return { order, duplicate: Boolean(prior) };
}
