import type { PluginContext } from "emdash";
import { restoreOrderInventory } from "../inventory";
import { CurrencyMismatchError, type Money } from "../money";
import { resolvePaystackKey } from "../payment-provider";
import {
	type PaystackRefund,
	type PaystackMode,
	attemptForReference,
	attemptMode,
	attemptProvider,
	createPaystackRefund,
	retrievePaystackRefund,
} from "../payment-provider/paystack-test";
import type { StripeClientOptions } from "../stripe/client";
import { type StripeRefund, createRefund, retrieveRefund } from "../stripe/refunds";
import type { Order, PaymentRecord, Refund } from "../types";
import { collection, digest, insertOnce, mutate } from "../util/conditional";
import { loadOrder, loadOrderItems, refundsStore } from "./create";
import { enqueueReceipt, isTestOrder } from "./outbox";
import { derivePaymentStatus } from "./status";

export class RefundRecoveryRequired extends Error {
	constructor(
		readonly refund: Refund,
		cause: unknown,
	) {
		super(
			`${cause instanceof Error ? cause.message : "Refund interrupted"}; retain this request for reconciliation`,
			{ cause },
		);
		this.name = "RefundRecoveryRequired";
	}
}

export interface LineItemRefund {
	orderItemId: string;
	quantity: number;
	amount: Money;
}
export interface RefundOrderInput {
	orderId: string;
	amount: Money;
	reason?: string;
	lineItemRefunds?: LineItemRefund[];
	restock?: boolean;
	createdByUserId?: string;
	/** Existing Stripe callers keep their signature; Paystack requires no Stripe credentials. */
	client?: StripeClientOptions;
	/** Stable per deliberate merchant request, reused after timeout/reload. */
	idempotencyKey: string;
}
async function requireFinalizedPayment(ctx: PluginContext, order: Order) {
	if (!order.paymentReference) return; // Settled legacy orders predate the journal.
	const marker = await collection<PaymentRecord>(ctx, "payments").get(order.id);
	if (
		marker?.status !== "finalized" &&
		!(order.paymentProvider === "paystack-test" && marker?.status === "finalized_test")
	)
		throw new Error("Payment finalization is incomplete; recover it before refunding");
}
function providerOf(order: Order): "stripe" | "paystack" {
	if (order.paymentProvider === "paystack" || order.paymentProvider === "paystack-test")
		return "paystack";
	if ((!order.paymentProvider || order.paymentProvider === "stripe") && order.stripePaymentIntentId)
		return "stripe";
	throw new Error("Order has no supported persisted payment provider");
}
function modeOf(order: Order): "test" | "live" {
	return isTestOrder(order) ? "test" : (order.paymentMode ?? "live");
}
function paystackReference(order: Order) {
	const prefix =
		order.paymentProvider === "paystack-test" ? "paystack-test:" : `paystack:${modeOf(order)}:`;
	if (!order.paymentReference?.startsWith(prefix))
		throw new Error("Persisted Paystack reference/mode missing");
	return order.paymentReference.slice(prefix.length);
}
function validateStripeClient(
	order: Order,
	client?: StripeClientOptions,
): asserts client is StripeClientOptions {
	if (!client || !new RegExp(`^(sk|rk)_${modeOf(order)}_`).test(client.secretKey))
		throw new Error("Stripe credential mode does not match persisted order");
}
async function validateLines(ctx: PluginContext, order: Order, input: RefundOrderInput) {
	if (input.restock && order.metadata?.inventoryStatus === "manual_review")
		throw new Error(
			"Inventory requires manual review; refund without automatic restock and reconcile stock separately",
		);
	if (input.restock && typeof order.metadata?.inventoryReservationId !== "string")
		throw new Error(
			"Automatic restock requires a recorded inventory reservation; refund without restock and reconcile legacy stock separately",
		);
	if (input.restock && !input.lineItemRefunds?.length)
		throw new Error("Restock requires explicit line quantities");
	const items = new Map((await loadOrderItems(ctx, order.id)).map((i) => [i.id, i]));
	const seen = new Set<string>();
	let total = 0;
	for (const line of input.lineItemRefunds ?? []) {
		const item = items.get(line.orderItemId);
		if (
			!item ||
			seen.has(item.id) ||
			!Number.isSafeInteger(line.quantity) ||
			line.quantity <= 0 ||
			line.quantity > item.quantity ||
			line.amount.currency !== order.currency ||
			!Number.isSafeInteger(line.amount.amount) ||
			line.amount.amount < 0
		)
			throw new Error("Invalid refund line/quantity/amount");
		seen.add(item.id);
		total += line.amount.amount;
	}
	if (total > input.amount.amount) throw new Error("Refund lines exceed requested refund amount");
}
function restockQuantities(refund: Refund, items: Map<string, { quantity: number }>) {
	const quantities: Record<string, number> = {};
	// Monetary/line allocations alone never imply a stock movement.
	if (!refund.restockRequested && !refund.restocked) return quantities;
	if (!refund.lineItemRefunds?.length) throw new Error("Restock requires explicit line quantities");
	for (const line of refund.lineItemRefunds) {
		const item = items.get(line.orderItemId);
		if (
			!item ||
			Object.hasOwn(quantities, line.orderItemId) ||
			!Number.isSafeInteger(line.quantity) ||
			line.quantity <= 0 ||
			line.quantity > item.quantity
		)
			throw new Error("Invalid refund restock quantity");
		Object.defineProperty(quantities, line.orderItemId, {
			value: line.quantity,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return quantities;
}
/** Money AND per-line stock budgets share one order CAS, before any provider POST.
 * Pending (including uncertain) and succeeded restocks hold units; only failed
 * reservations release units. Provider confirmation claims its SQL unique key
 * before finishEffects changes accounting or inventory. */
async function reserveAmount(ctx: PluginContext, refund: Refund) {
	const orders = collection<Order>(ctx, "orders");
	const items = new Map((await loadOrderItems(ctx, refund.orderId)).map((i) => [i.id, i]));
	const requested = restockQuantities(refund, items);
	// Additive migration: never treat an old missing quantity field as zero.
	// Refund intent is immutable; hydrate from durable rows, not current stock.
	const snapshot = await orders.get(refund.orderId);
	if (!snapshot) throw new Error("Order not found");
	const legacy = new Map<string, Record<string, number>>();
	for (const [id, reservation] of Object.entries(snapshot.refundReservations ?? {})) {
		if (reservation.restockQuantities !== undefined) continue;
		const prior = id === refund.id ? refund : await refundsStore(ctx).get(id);
		if (!prior || prior.orderId !== refund.orderId || prior.amount.amount !== reservation.amount)
			throw new Error("Legacy refund reservation requires reconciliation");
		legacy.set(id, restockQuantities(prior, items));
	}
	return mutate(orders, refund.orderId, (order) => {
		const reservations = { ...order.refundReservations };
		for (const [id, reservation] of Object.entries(reservations)) {
			if (reservation.restockQuantities !== undefined) continue;
			const quantities = legacy.get(id);
			if (!quantities) throw new Error("Legacy refund reservation changed; retry reconciliation");
			reservations[id] = { ...reservation, restockQuantities: quantities };
		}
		const existing = reservations[refund.id];
		if (existing) {
			const held = existing.restockQuantities;
			if (!held) throw new Error("Refund quantity reservation missing");
			if (
				existing.amount !== refund.amount.amount ||
				Object.keys(held).length !== Object.keys(requested).length ||
				Object.entries(requested).some(([id, quantity]) => held[id] !== quantity)
			)
				throw new Error("Refund reservation conflict");
		} else {
			const pending = Object.values(reservations)
				.filter((r) => r.status === "pending")
				.reduce((sum, r) => sum + r.amount, 0);
			if (refund.amount.amount > order.paidTotal.amount - order.refundedTotal.amount - pending)
				throw new Error("Refund exceeds remaining refundable amount (including pending requests)");
			reservations[refund.id] = {
				amount: refund.amount.amount,
				status: "pending",
				restockQuantities: requested,
			};
		}
		const held = new Map<string, number>();
		for (const reservation of Object.values(reservations)) {
			if (reservation.status === "failed") continue;
			for (const [id, quantity] of Object.entries(reservation.restockQuantities ?? {})) {
				const total = (held.get(id) ?? 0) + quantity;
				if (!Number.isSafeInteger(total) || total > (items.get(id)?.quantity ?? 0))
					throw new Error("Refund exceeds remaining restock quantity for order line");
				held.set(id, total);
			}
		}
		if (existing && legacy.size === 0) return order;
		return { ...order, refundReservations: reservations };
	});
}
async function finishEffects(ctx: PluginContext, persistedRefund: Refund): Promise<Refund> {
	let refund = persistedRefund;
	const order = await mutate(collection<Order>(ctx, "orders"), refund.orderId, (order) => {
		const reservation = order.refundReservations?.[refund.id];
		if (!reservation) throw new Error("Refund reservation missing");
		if (reservation.status === refund.status || refund.status === "pending") return order;
		if (reservation.status !== "pending") throw new Error("Conflicting terminal refund outcome");
		const refunded =
			order.refundedTotal.amount + (refund.status === "succeeded" ? refund.amount.amount : 0);
		if (refunded > order.paidTotal.amount) throw new Error("Refund accounting exceeds paid total");
		return {
			...order,
			refundedTotal: { ...order.refundedTotal, amount: refunded },
			paymentStatus: derivePaymentStatus(order.paidTotal.amount, refunded),
			// Preserve merchant fulfilment/cancellation decisions; paymentStatus carries partial accounting.
			status:
				refunded === order.paidTotal.amount &&
				!["cancelled", "failed", "on-hold"].includes(order.status)
					? "refunded"
					: order.status,
			refundReservations: {
				...order.refundReservations,
				[refund.id]: {
					...reservation,
					status: refund.status,
					providerRefundId: refund.providerRefundId,
				},
			},
			updatedAt: new Date().toISOString(),
		};
	});
	if (refund.status === "pending") return refund;
	if (refund.status === "failed")
		return mutate(refundsStore(ctx), refund.id, (r) => ({ ...r, effectsFinalized: true }));
	if (refund.restockRequested && !refund.restocked) {
		const items = new Map((await loadOrderItems(ctx, order.id)).map((i) => [i.id, i]));
		for (const line of refund.lineItemRefunds ?? []) {
			const item = items.get(line.orderItemId);
			if (!item) throw new Error("Refund item missing; stock recovery required");
			await restoreOrderInventory(ctx, {
				orderItem: item,
				quantity: line.quantity,
				refundId: refund.id,
				mode: modeOf(order),
			});
		}
		refund = await mutate(refundsStore(ctx), refund.id, (r) => ({ ...r, restocked: true }));
	}
	await enqueueReceipt(ctx, order, [], refund);
	return mutate(refundsStore(ctx), refund.id, (r) => ({ ...r, effectsFinalized: true }));
}
async function acceptOutcome(
	ctx: PluginContext,
	refund: Refund,
	providerId: string,
	status: Refund["status"],
): Promise<Refund> {
	const updated = await mutate(refundsStore(ctx), refund.id, (r) => {
		if (r.providerRefundId && r.providerRefundId !== providerId)
			throw new Error("Provider refund identity conflict");
		if (r.status !== "pending" && r.status !== status) {
			// Never regress a terminal confirmation to an earlier pending webhook.
			if (status === "pending") return r;
			throw new Error("Conflicting terminal refund outcome");
		}
		return {
			...r,
			status,
			providerRefundId: providerId,
			providerRefundKey: `${r.paymentProvider}:${r.paymentMode}:${providerId}`,
			...(r.paymentProvider === "stripe" ? { stripeRefundId: providerId } : {}),
			transportState: "confirmed" as const,
		};
	});
	return finishEffects(ctx, updated);
}
function validatePaystackOutcome(
	order: Order,
	refund: Refund,
	response: PaystackRefund,
): Refund["status"] {
	const reference =
		typeof response.transaction === "object"
			? response.transaction.reference
			: response.transaction_reference;
	if (
		response.domain !== refund.paymentMode ||
		reference !== paystackReference(order) ||
		response.amount !== refund.amount.amount ||
		response.currency.toUpperCase() !== refund.amount.currency
	)
		throw new Error("Paystack refund confirmation does not match request");
	return response.status === "processed"
		? "succeeded"
		: response.status === "failed"
			? "failed"
			: "pending";
}
function validateStripeOutcome(
	order: Order,
	refund: Refund,
	response: StripeRefund,
): Refund["status"] {
	if (
		response.amount !== refund.amount.amount ||
		response.currency.toUpperCase() !== refund.amount.currency ||
		(response.payment_intent
			? response.payment_intent !== order.stripePaymentIntentId
			: !order.stripeChargeId || response.charge !== order.stripeChargeId)
	)
		throw new Error("Stripe refund confirmation mismatch");
	return response.status === "succeeded"
		? "succeeded"
		: response.status === "failed" || response.status === "canceled"
			? "failed"
			: "pending";
}
export async function refundOrder(ctx: PluginContext, input: RefundOrderInput): Promise<Refund> {
	const order = await loadOrder(ctx, input.orderId);
	if (!order) throw new Error(`Order ${input.orderId} not found`);
	await requireFinalizedPayment(ctx, order);
	const provider = providerOf(order);
	const mode = modeOf(order);
	if (order.currency !== input.amount.currency)
		throw new CurrencyMismatchError(order.currency, input.amount.currency);
	if (!Number.isSafeInteger(input.amount.amount) || input.amount.amount <= 0)
		throw new Error("Refund amount must be a positive safe integer");
	if (!input.idempotencyKey || input.idempotencyKey.length > 200)
		throw new Error("Stable refund request ID required");
	await validateLines(ctx, order, input);
	const id = `refund_${await digest([order.id, input.idempotencyKey])}`;
	const requestHash = await digest({
		orderId: order.id,
		provider,
		mode,
		amount: input.amount,
		reason: input.reason,
		lines: input.lineItemRefunds,
		restock: Boolean(input.restock),
	});
	const refund = await insertOnce(refundsStore(ctx), id, {
		id,
		orderId: order.id,
		amount: input.amount,
		paymentProvider: provider,
		paymentMode: mode,
		requestId: id,
		clientRequestId: input.idempotencyKey,
		requestHash,
		status: "pending",
		transportState: "prepared",
		...(input.reason ? { reason: input.reason } : {}),
		...(input.lineItemRefunds ? { lineItemRefunds: input.lineItemRefunds } : {}),
		restocked: false,
		restockRequested: Boolean(input.restock),
		createdAt: new Date().toISOString(),
		...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
	});
	if (refund.requestHash !== requestHash)
		throw new Error("Refund request ID reused with different parameters");
	await reserveAmount(ctx, refund);
	if (refund.status !== "pending") return finishEffects(ctx, refund);
	if (refund.providerRefundId) {
		if (provider === "paystack") {
			const response = await retrievePaystackRefund(
				ctx,
				await resolvePaystackKey(ctx, mode),
				Number(refund.providerRefundId),
				mode,
			);
			return acceptOutcome(
				ctx,
				refund,
				String(response.id),
				validatePaystackOutcome(order, refund, response),
			);
		}
		validateStripeClient(order, input.client);
		const response = await retrieveRefund(ctx, refund.providerRefundId, input.client);
		return acceptOutcome(ctx, refund, response.id, validateStripeOutcome(order, refund, response));
	}
	// Resolve credentials before claiming a financial POST; misconfiguration is safely retryable.
	let paystackKey: string | undefined;
	if (provider === "stripe") validateStripeClient(order, input.client);
	else {
		paystackReference(order);
		paystackKey = await resolvePaystackKey(ctx, mode);
	}
	const current = await refundsStore(ctx).getVersioned(id);
	if (!current) throw new Error("Refund request vanished");
	if (current.value.transportState !== "prepared") {
		// No lease expiry: cannot distinguish a crash before POST from one after provider acceptance.
		// Stripe's idempotency also expires, so do not replay unknown writes automatically there either.
		return current.value;
	}
	if (
		!(
			await refundsStore(ctx).compareAndSet(id, current.revision, {
				...current.value,
				transportState: "submitting",
			})
		).applied
	) {
		const winner = await refundsStore(ctx).get(id);
		if (!winner) throw new Error("Refund request vanished");
		return winner;
	}
	try {
		if (provider === "paystack") {
			if (!paystackKey) throw new Error("Paystack credentials missing");
			const response = await createPaystackRefund(
				ctx,
				paystackKey,
				{
					reference: paystackReference(order),
					amount: refund.amount.amount,
					currency: refund.amount.currency,
					customerNote: refund.reason,
					merchantNote: `DashCommerce request ${id}`,
				},
				mode,
			);
			return await acceptOutcome(
				ctx,
				refund,
				String(response.id),
				validatePaystackOutcome(order, refund, response),
			);
		}
		validateStripeClient(order, input.client);
		if (!order.stripePaymentIntentId) throw new Error("Stripe payment identity missing");
		const reason =
			input.reason === "fraudulent" || input.reason === "duplicate"
				? input.reason
				: "requested_by_customer";
		const response = await createRefund(
			ctx,
			{
				paymentIntent: order.stripePaymentIntentId,
				amount: input.amount.amount,
				reason,
				metadata: { orderId: order.id, orderNumber: order.orderNumber, refundRequestId: id },
			},
			input.client,
			id,
		);
		return await acceptOutcome(
			ctx,
			refund,
			response.id,
			validateStripeOutcome(order, refund, response),
		);
	} catch (error) {
		let recoverable: Refund = { ...refund, transportState: "uncertain" };
		try {
			recoverable = await mutate(refundsStore(ctx), id, (r) =>
				r.transportState === "confirmed" ? r : { ...r, transportState: "uncertain" as const },
			);
		} catch {
			// The submitting claim already exists. Never repeat a financial POST
			// merely because persisting the uncertain outcome also failed.
		}
		throw new RefundRecoveryRequired(recoverable, error);
	}
}
/** Explicit operator recovery for a POST whose response was lost. Read-only GET;
 * validates persisted provider, mode, reference and amount before accounting.
 * The operator must identify the corresponding provider refund, never create another. */
export async function reconcileRefund(
	ctx: PluginContext,
	refundId: string,
	providerRefundId: string,
	client?: StripeClientOptions,
): Promise<Refund> {
	const refund = await refundsStore(ctx).get(refundId);
	if (!refund) throw new Error("Refund request not found");
	const order = await loadOrder(ctx, refund.orderId);
	if (!order) throw new Error("Order not found");
	await reserveAmount(ctx, refund);
	if (
		refund.requestId &&
		refund.transportState === "confirmed" &&
		refund.status !== "pending" &&
		refund.providerRefundId === providerRefundId
	)
		return finishEffects(ctx, refund);
	if (providerOf(order) === "paystack") {
		const response = await retrievePaystackRefund(
			ctx,
			await resolvePaystackKey(ctx, modeOf(order)),
			Number(providerRefundId),
			modeOf(order),
		);
		return acceptOutcome(
			ctx,
			refund,
			String(response.id),
			validatePaystackOutcome(order, refund, response),
		);
	}
	validateStripeClient(order, client);
	const response = await retrieveRefund(ctx, providerRefundId, client);
	return acceptOutcome(ctx, refund, response.id, validateStripeOutcome(order, refund, response));
}
/** Import an independently retrieved Paystack refund. The signed notification is only a hint;
 * the GET, persisted payment identity, and the native unique refund key are authoritative.
 * No monetary POST or inferred stock movement occurs on this path. */
export async function syncPaystackRefund(
	ctx: PluginContext,
	response: PaystackRefund,
	mode: PaystackMode,
): Promise<{ refund?: Refund; ignored?: true; reconciliationRequired?: true }> {
	if (
		response.domain !== mode ||
		!Number.isSafeInteger(response.amount) ||
		response.amount <= 0 ||
		!Number.isSafeInteger(response.id) ||
		response.id <= 0 ||
		!["processed", "failed", "pending", "processing"].includes(response.status)
	)
		throw new Error("Paystack refund GET identity/status mismatch");
	const reference =
		typeof response.transaction === "object"
			? response.transaction.reference
			: response.transaction_reference;
	if (typeof reference !== "string") throw new Error("Paystack refund GET reference missing");
	const attempt = await attemptForReference(ctx, reference);
	const keys = [`paystack:${mode}:${reference}`];
	if (mode === "test") keys.push(`paystack-test:${reference}`);
	const orders = collection<Order>(ctx, "orders");
	const found: Order[] = [];
	for (const key of keys) {
		const rows = (await orders.query({ where: { paymentReference: key }, limit: 2 })).items;
		found.push(...rows.map((r) => ({ ...r.data, id: r.id })));
	}
	if (found.length > 1) throw new Error("Paystack refund order identity conflict");
	if (
		attempt &&
		(attemptMode(attempt) !== mode ||
			(attemptProvider(attempt) === "paystack-test" && mode !== "test"))
	)
		throw new Error("Paystack refund payment attempt mode conflict");
	const order = found[0];
	if (!order) {
		// An initialized checkout can be refunded before its finalized order is visible.
		if (attempt) throw new Error("Paystack refund order not finalized yet; retry notification");
		return { ignored: true };
	}
	if (
		providerOf(order) !== "paystack" ||
		modeOf(order) !== mode ||
		paystackReference(order) !== reference ||
		(order.paymentProvider === "paystack-test" && mode !== "test")
	)
		throw new Error("Paystack refund order/mode conflict");
	await requireFinalizedPayment(ctx, order);
	const payment = await collection<PaymentRecord>(ctx, "payments").get(order.id);
	if (
		payment &&
		((payment.paymentKey && payment.paymentKey !== order.paymentReference) ||
			(payment.mode && payment.mode !== mode) ||
			(payment.provider && payment.provider !== order.paymentProvider))
	)
		throw new Error("Paystack refund finalized payment identity conflict");
	if (
		order.currency !== response.currency ||
		order.paidTotal.currency !== response.currency ||
		order.refundedTotal.currency !== response.currency
	)
		throw new Error("Paystack refund currency conflict");
	const key = `paystack:${mode}:${response.id}`;
	const store = refundsStore(ctx);
	const matching = (await store.query({ where: { providerRefundKey: key }, limit: 2 })).items;
	if (matching.length > 1) throw new Error("Duplicate Paystack refund identity");
	let refund = matching[0] ? { ...matching[0].data, id: matching[0].id } : undefined;
	const note = response.merchant_note;
	const requestId =
		typeof note === "string" && /^DashCommerce request refund_[a-f0-9]{64}$/.test(note)
			? note.slice("DashCommerce request ".length)
			: undefined;
	if (typeof note === "string" && note.startsWith("DashCommerce request ") && !requestId)
		return { reconciliationRequired: true };
	if (requestId) {
		const correlated = await store.get(requestId);
		if (correlated) {
			if (
				correlated.id !== requestId ||
				correlated.requestId !== requestId ||
				!correlated.requestHash ||
				correlated.orderId !== order.id ||
				correlated.paymentProvider !== "paystack" ||
				correlated.paymentMode !== mode ||
				correlated.amount.amount !== response.amount ||
				correlated.amount.currency !== response.currency ||
				correlated.transportState === "prepared" ||
				(correlated.providerRefundId && correlated.providerRefundId !== String(response.id)) ||
				(refund && refund.id !== correlated.id)
			)
				throw new Error("Paystack refund merchant note identity conflict");
			refund = correlated;
		} else {
			// An exact local request marker without its row is not an external refund.
			return { reconciliationRequired: true };
		}
	}
	if (refund) {
		if (
			refund.orderId !== order.id ||
			refund.paymentProvider !== "paystack" ||
			refund.paymentMode !== mode ||
			refund.amount.amount !== response.amount ||
			refund.amount.currency !== response.currency ||
			(refund.providerRefundId && refund.providerRefundId !== String(response.id)) ||
			(refund.providerRefundKey && refund.providerRefundKey !== key)
		)
			throw new Error("Paystack refund identity conflict");
		if (!refund.requestId) return { reconciliationRequired: true }; // pre-journal accounting
		const outcome =
			response.status === "processed"
				? "succeeded"
				: response.status === "failed"
					? "failed"
					: "pending";
		if (refund.status !== "pending" && outcome !== "pending" && refund.status !== outcome)
			throw new Error("Conflicting terminal refund outcome");
		return { refund: await reconcileRefund(ctx, refund.id, String(response.id)) };
	}
	const id = `paystack_external_${mode}_${response.id}`;
	try {
		refund = await insertOnce(store, id, {
			id,
			orderId: order.id,
			amount: { amount: response.amount, currency: order.currency },
			paymentProvider: "paystack",
			paymentMode: mode,
			providerRefundId: String(response.id),
			providerRefundKey: key,
			requestId: id,
			status: "pending",
			transportState: "confirmed",
			restocked: false,
			restockRequested: false,
			createdAt: new Date().toISOString(),
		});
	} catch (error) {
		// Unique-index loser: resolve by the provider key, never create a second claim.
		const winner = (await store.query({ where: { providerRefundKey: key }, limit: 2 })).items;
		if (winner.length !== 1) throw error;
		refund = { ...winner[0]!.data, id: winner[0]!.id };
	}
	if (
		refund.orderId !== order.id ||
		refund.amount.amount !== response.amount ||
		refund.amount.currency !== response.currency ||
		refund.providerRefundKey !== key ||
		refund.paymentProvider !== "paystack" ||
		refund.paymentMode !== mode ||
		refund.providerRefundId !== String(response.id)
	)
		throw new Error("Paystack external refund identity conflict");
	try {
		await reserveAmount(ctx, refund);
	} catch (error) {
		if (error instanceof Error && error.message.includes("exceeds remaining refundable amount"))
			return { reconciliationRequired: true }; // preserve other pending reservations
		throw error;
	}
	return { refund: await reconcileRefund(ctx, refund.id, String(response.id)) };
}
/** Stripe webhook interface retained, with provider separation and CAS accounting. */
export async function recordRefundFromWebhook(
	ctx: PluginContext,
	suppliedOrder: Order,
	stripeRefund: StripeRefund,
): Promise<Refund | null> {
	const order = await loadOrder(ctx, suppliedOrder.id);
	if (!order || providerOf(order) !== "stripe")
		throw new Error("Stripe refund webhook cannot mutate another provider's order");
	await requireFinalizedPayment(ctx, order);
	if (
		stripeRefund.currency.toUpperCase() !== order.currency ||
		!Number.isSafeInteger(stripeRefund.amount) ||
		stripeRefund.amount <= 0
	)
		return null;
	let refund: Refund | null = null;
	if (stripeRefund.metadata?.refundRequestId)
		refund = await refundsStore(ctx).get(stripeRefund.metadata.refundRequestId);
	if (!refund) {
		const row = (
			await refundsStore(ctx).query({ where: { stripeRefundId: stripeRefund.id }, limit: 1 })
		).items[0];
		if (row) refund = { ...row.data, id: row.id };
	}
	if (!refund) {
		const id = `stripe_refund_${stripeRefund.id}`;
		refund = await insertOnce(refundsStore(ctx), id, {
			id,
			orderId: order.id,
			amount: { amount: stripeRefund.amount, currency: order.currency },
			status: "pending",
			paymentProvider: "stripe",
			paymentMode: modeOf(order),
			requestId: id,
			restocked: false,
			createdAt: new Date().toISOString(),
		});
	}
	if (
		refund.orderId !== order.id ||
		(refund.paymentProvider && refund.paymentProvider !== "stripe")
	)
		throw new Error("Refund webhook identity conflict");
	if (!refund.requestId) {
		// Legacy row was already accounted outside the CAS journal. Never double-count it.
		return refund;
	}
	await reserveAmount(ctx, refund);
	return acceptOutcome(
		ctx,
		refund,
		stripeRefund.id,
		validateStripeOutcome(order, refund, stripeRefund),
	);
}
