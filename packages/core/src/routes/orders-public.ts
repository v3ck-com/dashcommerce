/**
 * Public order-lookup routes.
 *
 *   GET /orders/by-draft?id={orderDraftId}
 *     - Polled by the thank-you page after Stripe confirmPayment()
 *       returns. Stripe's webhook + our order-create step can race with
 *       the redirect; the page retries every ~500ms until this returns
 *       `{ status: "ready", order, items }`.
 *     - Returns `{ status: "pending" }` while we're still waiting for
 *       the webhook to land.
 *     - Returns `{ status: "failed" }` if the draft snapshot is gone and
 *       no order was created (Stripe webhook never arrived / PI failed).
 *
 * We don't leak arbitrary orders — access is keyed on `orderDraftId`
 * which only the session that created the PI knows.
 *
 * Why a query string instead of `/orders/by-draft/:id`? emdash's
 * PluginRouteRegistry does an exact-string lookup on the route key — it
 * does NOT parse `:param` placeholders. A literal `:orderDraftId` in the
 * route key would never match a real draft id and every poll would 404.
 */

import type { PluginContext, RouteContext, StorageCollection } from "emdash";
import { finalizePaystack } from "../orders/paystack";
import { resolvePaystackKey } from "../payment-provider";
import { attemptForDraft, attemptMode, reconcileAttempt } from "../payment-provider/paystack-test";
import type { Order, OrderItem, PaymentRecord } from "../types";
import { draftKey } from "./checkout";

type OrdersStore = StorageCollection<Order>;
type OrderItemsStore = StorageCollection<OrderItem>;

function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}

function orderItemsStore(ctx: PluginContext): OrderItemsStore {
	return (ctx.storage as unknown as { order_items: OrderItemsStore }).order_items;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
	});
}

function parseDraftId(req: Request): string | null {
	const url = new URL(req.url);
	// Preferred: ?id=xxx (what the thank-you island sends).
	const qs = url.searchParams.get("id");
	if (qs) return qs;
	// Legacy fallback: older builds (or direct links) may still use the
	// path-param shape /orders/by-draft/xxx. This won't route here on
	// emdash (no `:param` matching) but the check is cheap and keeps the
	// helper robust for tests / future matchers.
	const parts = url.pathname.split("/").filter(Boolean);
	const idx = parts.lastIndexOf("by-draft");
	return idx === -1 ? null : (parts[idx + 1] ?? null);
}

export const ordersPublicRoutes = {
	"orders/by-draft": {
		public: true,
		handler: async (routeCtx: RouteContext, _c?: PluginContext) => {
			const ctx = (_c ?? (routeCtx as unknown as PluginContext)) as PluginContext;
			const orderDraftId = parseDraftId(routeCtx.request);
			if (!orderDraftId || !/^[a-f0-9]{32}$/.test(orderDraftId))
				return json({ error: "Invalid orderDraftId" }, 400);

			// The draft id is a capability, never a provider-supplied redirect status.
			const attempt = await attemptForDraft(ctx, orderDraftId);
			if (attempt) {
				let current = attempt;
				try {
					if (current.outcome !== "verified") {
						const key = await resolvePaystackKey(ctx, attempt);
						current = await reconcileAttempt(ctx, key, attempt);
					}
					if (current.outcome === "verified") {
						const { order } = await finalizePaystack(ctx, current);
						const items = (
							await orderItemsStore(ctx).query({ where: { orderId: order.id }, limit: 100 })
						).items.map((r) => ({ ...r.data, id: r.id }));
						return json({
							status: "ready",
							order,
							items,
							testMode: attemptMode(current) === "test",
							manualReview:
								order.metadata?.inventoryStatus === "manual_review" ||
								order.metadata?.couponStatus === "manual_review",
						});
					}
					return json({
						status:
							current.outcome === "failed"
								? "failed"
								: current.outcome === "manual_review"
									? "manual_review"
									: "pending",
						testMode: attemptMode(current) === "test",
					});
				} catch (err) {
					ctx.log.warn("Payment verification/finalization deferred", {
						error: err instanceof Error ? err.message : String(err),
					});
					return json({
						status: "pending",
						retryable: true,
						testMode: attemptMode(attempt) === "test",
					});
				}
			}
			// New shared payments have an indexed draft identity. Receipts must
			// keep working after the order leaves the recent-order window.
			const journal = await (
				ctx.storage as unknown as { payments: StorageCollection<PaymentRecord> }
			).payments.query({ where: { orderDraftId }, limit: 2 });
			if (journal.items.length > 1) return json({ status: "manual_review" });
			const payment = journal.items[0]?.data;
			if (payment) {
				if (payment.status !== "finalized" && payment.status !== "finalized_test")
					return json({ status: "pending" });
				const order = await ordersStore(ctx).get(payment.orderId);
				if (!order || order.metadata?.orderDraftId !== orderDraftId)
					return json({ status: "manual_review" });
				const items = (
					await orderItemsStore(ctx).query({ where: { orderId: order.id }, limit: 200 })
				).items.map((row) => ({ ...row.data, id: row.id }));
				return json({
					status: "ready",
					order,
					items,
					...(payment.mode ? { mode: payment.mode, testMode: payment.mode === "test" } : {}),
					manualReview:
						order.metadata?.inventoryStatus === "manual_review" ||
						order.metadata?.couponStatus === "manual_review",
				});
			}
			// Read-only compatibility for old, journal-less orders. Historical
			// stores need an explicit migration rather than an unbounded scan.
			const recent = await ordersStore(ctx).query({
				orderBy: { createdAt: "desc" },
				limit: 200,
			});
			const match = recent.items.find((r) => {
				const meta = (r.data as Order).metadata as { orderDraftId?: string } | undefined;
				return meta?.orderDraftId === orderDraftId;
			});
			if (match) {
				const order = { ...(match.data as Order), id: match.id };
				// New orders become visible only after the shared finalizer commits its
				// last marker. Pre-journal legacy orders remain readable.
				if (order.paymentReference) {
					const payment = await (
						ctx.storage as unknown as {
							payments: StorageCollection<PaymentRecord>;
						}
					).payments.get(order.id);
					if (
						payment?.status !== "finalized" &&
						!(
							payment?.status === "finalized_test" &&
							order.paymentReference.startsWith("paystack-test:")
						)
					)
						return json({ status: "pending" });
				}
				const items = (
					await orderItemsStore(ctx).query({
						where: { orderId: order.id },
						limit: 200,
					})
				).items.map((r) => ({ ...(r.data as OrderItem), id: r.id }));
				return json({ status: "ready", order, items });
			}

			// No order yet — is the draft snapshot still around?
			const snapshot = await ctx.kv.get<{ failed?: boolean }>(draftKey(orderDraftId));
			if (!snapshot || snapshot.failed === true) {
				return json({ status: "failed" });
			}
			return json({ status: "pending" });
		},
	},
};
