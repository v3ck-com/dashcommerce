import type { PluginContext } from "emdash";
import { type PaymentAttempt, attempts } from "../payment-provider/paystack-test";
import type { Order, PaymentRecord } from "../types";
import { collection } from "../util/conditional";
import { finalizePayment } from "./finalize";

/** Only a durable, server-verified payment may enter the common lifecycle. */
export async function finalizePaystack(ctx: PluginContext, attempt: PaymentAttempt) {
	const durable = await attempts(ctx).get(attempt.id);
	if (durable?.outcome !== "verified") throw new Error("Durable verified payment required");
	const cart = durable.cart;
	if (
		cart.total.amount !== durable.amount ||
		cart.currency !== durable.currency ||
		cart.customerEmail?.toLowerCase() !== durable.email.toLowerCase()
	)
		throw new Error("Checkout snapshot does not match verified attempt");
	// Preserve pre-migration settled records and merchant decisions. Their effects
	// lack the new journal, so a partial legacy write needs explicit migration,
	// never creation of a second order under a newly derived identity.
	if ((durable.mode ?? "test") === "test") {
		const legacyId = `test_${durable.orderDraftId}`;
		const legacy = await collection<PaymentRecord>(ctx, "payments").get(legacyId);
		if (legacy) {
			if (
				legacy.paymentKey !== `paystack-test:${durable.reference}` ||
				legacy.status !== "finalized_test"
			)
				throw new Error("Legacy partial payment requires operator reconciliation");
			const order = await collection<Order>(ctx, "orders").get(legacyId);
			if (!order) throw new Error("Legacy finalized order missing");
			return { order, duplicate: true };
		}
	}
	return finalizePayment(ctx, {
		provider: "paystack",
		mode: durable.mode ?? "test",
		reference: durable.reference,
		orderDraftId: durable.orderDraftId,
		cartSnapshot: cart,
		inventoryReservationId: durable.id,
	});
}
/** Legacy compatibility alias, not a separate test-shop lifecycle. */
export const finalizePaystackTest = finalizePaystack;
