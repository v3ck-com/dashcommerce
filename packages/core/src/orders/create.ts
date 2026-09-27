import type { PluginContext } from "emdash";
import type { StripePaymentIntent } from "../stripe/payment-intents";
import type { CartState, Order, OrderItem, Refund } from "../types";
import { collection } from "../util/conditional";
import { finalizePayment } from "./finalize";

export interface CreateOrderInput {
	paymentIntent: StripePaymentIntent;
	cartSnapshot: CartState;
	orderDraftId: string;
}
/** Compatibility wrapper. Provider-authenticated payment data enters the exact
 * same recoverable lifecycle as Paystack; never fabricates provider identities. */
export async function createOrderFromPaymentIntent(
	ctx: PluginContext,
	input: CreateOrderInput,
): Promise<{ order: Order; duplicate: boolean }> {
	const pi = input.paymentIntent;
	const cart = input.cartSnapshot;
	if (
		pi.status !== "succeeded" ||
		(pi.amount_received ?? pi.amount) !== cart.total.amount ||
		pi.currency.toUpperCase() !== cart.currency
	)
		throw new Error("Stripe payment does not match purchased cart");
	const existing = await findOrderByPaymentIntent(ctx, pi.id);
	// Pre-migration orders have no replay journal. Do not blindly reapply effects
	// already performed by the legacy implementation; operator reconciliation required.
	if (existing && !existing.paymentReference) return { order: existing, duplicate: true };
	const livemode = (pi as StripePaymentIntent & { livemode?: boolean }).livemode;
	if (
		typeof livemode !== "boolean" ||
		(existing?.paymentMode && existing.paymentMode !== (livemode ? "live" : "test"))
	)
		throw new Error("Stripe payment environment is missing or inconsistent");
	const mode = livemode ? "live" : "test";
	return finalizePayment(ctx, {
		provider: "stripe",
		mode,
		reference: pi.id,
		orderDraftId: input.orderDraftId,
		cartSnapshot: { ...cart, customerEmail: cart.customerEmail ?? pi.receipt_email },
		stripe: { paymentIntentId: pi.id, customerId: pi.customer, chargeId: pi.latest_charge },
		paymentMethodType: pi.payment_method_types?.[0],
	});
}
export async function findOrderByPaymentIntent(
	ctx: PluginContext,
	paymentIntentId: string,
): Promise<Order | null> {
	const result = await collection<Order>(ctx, "orders").query({
		where: { stripePaymentIntentId: paymentIntentId },
		limit: 1,
	});
	const row = result.items[0];
	return row ? { ...row.data, id: row.id } : null;
}
export async function loadOrder(ctx: PluginContext, orderId: string): Promise<Order | null> {
	const raw = await collection<Order>(ctx, "orders").get(orderId);
	return raw ? { ...raw, id: orderId } : null;
}
export async function loadOrderItems(ctx: PluginContext, orderId: string): Promise<OrderItem[]> {
	const result = await collection<OrderItem>(ctx, "order_items").query({
		where: { orderId },
		limit: 200,
	});
	return result.items.map((r) => ({ ...r.data, id: r.id }));
}
export function refundsStore(ctx: PluginContext) {
	return collection<Refund>(ctx, "refunds");
}
