import type { PluginContext } from "emdash";
import type { Order, OrderItem, PaymentRecord, Refund } from "../types";
import { collection, insertOnce, mutate } from "../util/conditional";
import { isTestOrder } from "../util/order-environment";
import { composeOrderReceipt, composeRefundReceipt } from "./receipt";

export interface CommerceNotification {
	id: string;
	orderId: string;
	status: "pending" | "suppressed" | "sending" | "sent" | "uncertain";
	testMode: boolean;
	to: string;
	subject: string;
	text: string;
	html: string;
	createdAt: string;
}
export { isTestOrder };
export async function enqueueReceipt(
	ctx: PluginContext,
	order: Order,
	items: OrderItem[],
	refund?: Refund,
) {
	const testMode = isTestOrder(order);
	const message = refund
		? composeRefundReceipt({ order, refund, siteName: ctx.site.name })
		: composeOrderReceipt({ order, items, siteName: ctx.site.name });
	if (testMode) {
		message.subject = `TEST ONLY — ${message.subject}`;
		// Keep native totals/layout, but never promise real payment or delivery.
		message.text = `TEST PREVIEW — No real payment, refund, delivery or fulfilment.\n\n${message.text}`;
		message.html = `<p><strong>TEST PREVIEW — No real payment, refund, delivery or fulfilment.</strong></p>${message.html}`;
		for (const key of ["text", "html"] as const) {
			message[key] = message[key]
				.replaceAll(
					"Payment received — we'll email again when it ships.",
					"Test payment simulated. Nothing will ship.",
				)
				.replaceAll(
					"has been received — we'll email again when it ships.",
					"is simulated. Nothing will ship.",
				)
				.replaceAll("We've issued a refund of", "We've simulated a test refund of")
				.replaceAll(
					"Depending on your bank, funds typically arrive within",
					"Simulation only; no funds will arrive. Live refunds normally take",
				);
		}
	}
	return insertOnce(
		collection<CommerceNotification>(ctx, "commerce_outbox"),
		refund ? `refund:${refund.id}` : `order:${order.id}`,
		{
			id: refund ? `refund:${refund.id}` : `order:${order.id}`,
			orderId: order.id,
			status: testMode ? "suppressed" : "pending",
			testMode,
			to: order.customerEmail,
			...message,
			createdAt: new Date().toISOString(),
		},
	);
}
/** Explicit opt-in handoff to native EmDash email. Default is preview/no delivery.
 * Email has no idempotency API: crash/timeout after claim is uncertain, NOT auto-resend.
 * A sending/uncertain entry requires operator inspection to avoid duplicate mail. */
export async function dispatchCommerceNotification(
	ctx: PluginContext,
	id: string,
	options: { allowDelivery?: boolean } = {},
) {
	if (
		!options.allowDelivery ||
		!ctx.email ||
		(await ctx.kv.get<boolean>("settings:receiptEmailEnabled")) !== true
	)
		return;
	const store = collection<CommerceNotification>(ctx, "commerce_outbox");
	const current = await store.getVersioned(id);
	if (!current || current.value.testMode || current.value.status !== "pending") return;
	if (
		id.startsWith("order:") &&
		(await collection<PaymentRecord>(ctx, "payments").get(current.value.orderId))?.status !==
			"finalized"
	)
		return;
	if (
		!(await store.compareAndSet(id, current.revision, { ...current.value, status: "sending" }))
			.applied
	)
		return;
	try {
		const { to, subject, text, html } = current.value;
		await ctx.email.send({ to, subject, text, html });
		await mutate(store, id, (v) => ({ ...v, status: "sent" as const }));
	} catch (err) {
		await mutate(store, id, (v) => ({ ...v, status: "uncertain" as const }));
		throw err;
	}
}
