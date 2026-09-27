import { describe, expect, it } from "bun:test";
import type { PluginContext } from "emdash";
import { createHmac } from "node:crypto";
import { reserveCouponClaims } from "../src/coupons/reservations";
import { ordersPublicRoutes } from "../src/routes/orders-public";
import { webhookRoutes } from "../src/routes/webhook";
import { conditionalStore } from "./helpers/conditional-store";

const draft = "a".repeat(32);
function setup() {
	const stores = Object.fromEntries(
		[
			"orders",
			"order_items",
			"payments",
			"payment_attempts",
			"refunds",
			"stripe_events",
			"commerce_outbox",
			"coupons",
			"customers",
			"coupon_usage",
		].map((n) => [n, conditionalStore()]),
	);
	const kv = conditionalStore();
	const warnings: unknown[] = [];
	const ctx = {
		storage: stores,
		site: { name: "Synthetic" },
		kv: { ...kv, set: kv.put },
		log: {
			info() {},
			warn(...v: unknown[]) {
				warnings.push(v);
			},
			error(...v: unknown[]) {
				warnings.push(v);
			},
		},
		http: {
			fetch: async () => {
				throw new Error("No HTTP expected");
			},
		},
	} as unknown as PluginContext;
	const lookup = async () =>
		(
			await (ordersPublicRoutes["orders/by-draft"].handler as any)(
				{ request: new Request(`https://example.test/orders/by-draft?id=${draft}`) },
				ctx,
			)
		).json();
	const stripe = async (event: unknown) => {
		const payload = JSON.stringify(event);
		const timestamp = Math.floor(Date.now() / 1000);
		const signature = createHmac("sha256", "whsec_SYNTHETIC")
			.update(`${timestamp}.${payload}`)
			.digest("hex");
		const bytes = new TextEncoder().encode(payload);
		return (webhookRoutes["checkout/webhook"].handler as any)(
			{
				request: new Request("https://example.test/checkout/webhook", {
					method: "POST",
					headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
					body: bytes,
				}),
				input: bytes,
			},
			ctx,
		) as Promise<Response>;
	};
	const paystack = async (event: unknown, key = "sk_test_SYNTHETIC") => {
		const bytes = new TextEncoder().encode(JSON.stringify(event));
		const sig = createHmac("sha512", key).update(bytes).digest("hex");
		return (webhookRoutes["checkout/paystack-webhook"].handler as any)(
			{
				request: new Request("https://example.test/checkout/paystack-webhook", {
					method: "POST",
					headers: { "x-paystack-signature": sig },
					body: bytes,
				}),
				input: bytes,
			},
			ctx,
		) as Promise<Response>;
	};
	return { ctx, stores, kv, warnings, lookup, paystack, stripe };
}
describe("public settlement boundaries", () => {
	it("Stripe card declines keep coupon capacity; only terminal cancellation releases it", async () => {
		const h = setup();
		h.kv.rows.set("settings:stripeWebhookSecret", "whsec_SYNTHETIC");
		await h.stores.coupons.put("coupon", {
			id: "coupon",
			code: "SAVE",
			usageCount: 0,
			usageLimit: 1,
		});
		const cart = {
			customerEmail: "buyer@example.test",
			items: [],
			coupons: [{ code: "SAVE", couponId: "coupon" }],
		} as any;
		await reserveCouponClaims(h.ctx, draft, cart, "live");
		await h.kv.put(`draft:${draft}`, { cart, mode: "live" });
		const event = (type: string, status: string) => ({
			id: `evt_${status}`,
			type,
			data: { object: { id: "pi_example", status, metadata: { orderDraftId: draft } } },
		});
		expect(
			(await h.stripe(event("payment_intent.payment_failed", "requires_payment_method"))).status,
		).toBe(200);
		expect((await h.stores.coupons.get("coupon"))._quotaClaims[draft].status).toBe("pending");
		expect((await h.kv.get(`draft:${draft}`)).failed).not.toBe(true);
		expect((await h.stripe(event("payment_intent.canceled", "canceled"))).status).toBe(200);
		expect((await h.stores.coupons.get("coupon"))._quotaClaims[draft].status).toBe("released");
		expect((await h.kv.get(`draft:${draft}`)).failed).toBe(true);
	});
	it("keeps a partially written Stripe order pending; legacy rows remain visible", async () => {
		const h = setup();
		const order = {
			id: "order",
			metadata: { orderDraftId: draft },
			paymentReference: "stripe:test:pi_a",
		};
		await h.stores.orders.put("order", order);
		expect((await h.lookup()).status).toBe("pending");
		await h.stores.payments.put("order", { status: "verified" });
		expect((await h.lookup()).status).toBe("pending");
		await h.stores.payments.put("order", { status: "finalized" });
		expect((await h.lookup()).status).toBe("ready");
		await h.stores.orders.put("order", { ...order, paymentReference: "paystack-test:dc_legacy" });
		await h.stores.payments.put("order", { status: "finalized_test" });
		expect((await h.lookup()).status).toBe("ready");
		await h.stores.payments.delete("order");
		await h.stores.orders.put("order", { ...order, paymentReference: undefined });
		expect((await h.lookup()).status).toBe("ready");
	});
	it("already verified Paystack lookup does not need a current provider key", async () => {
		const h = setup();
		await h.stores.payment_attempts.put(draft, {
			id: draft,
			reference: `dc_${draft}`,
			orderDraftId: draft,
			outcome: "verified",
			mode: "test",
			cart: {},
		});
		// The finalizer sees the verified attempt, not a key error: a missing cart is a deferred finalization.
		expect(await h.lookup()).toMatchObject({ status: "pending", retryable: true });
		expect(h.warnings.flat().join(" ")).not.toContain("secret key required");
	});
	it("signed hosted sessions do not pay on completion while async payment is pending", async () => {
		const h = setup();
		h.kv.rows.set("settings:stripeWebhookSecret", "whsec_SYNTHETIC");
		const session = {
			id: "cs_1",
			mode: "payment",
			payment_status: "unpaid",
			payment_intent: "pi_1",
			metadata: { orderDraftId: draft },
		};
		const result = await h.stripe({
			id: "evt_1",
			type: "checkout.session.completed",
			data: { object: session },
		});
		expect(await result.json()).toMatchObject({ awaitingPayment: true });
		expect(h.stores.stripe_events.rows.size).toBe(0); // never preclaim a recoverable payment event
		expect(h.stores.orders.rows.size).toBe(0);
	});
	it("rejects mismatched native fixed tax and Stripe Tax totals before finalization", async () => {
		const h = setup();
		h.kv.rows.set("settings:stripeWebhookSecret", "whsec_SYNTHETIC");
		h.kv.rows.set("settings:stripeSecretKey", "sk_test_SYNTHETIC");
		h.ctx.http!.fetch = async () =>
			Response.json({
				id: "pi_1",
				status: "succeeded",
				amount: 112,
				amount_received: 112,
				currency: "zar",
			});
		const cash = (amount: number) => ({ amount, currency: "ZAR" });
		const quote = {
			currency: "ZAR",
			subtotal: cash(100),
			discountTotal: cash(0),
			shippingTotal: cash(10),
			taxTotal: cash(5),
			total: cash(115),
			items: [],
			billingAddress: { country: "ZA" },
			shippingAddress: { country: "ZA" },
			customerEmail: "a@b.test",
		};
		h.kv.rows.set(`draft:${draft}`, { cart: quote });
		const session = {
			id: "cs_1",
			mode: "payment",
			payment_status: "paid",
			payment_intent: "pi_1",
			currency: "zar",
			amount_total: 112,
			metadata: { orderDraftId: draft },
			customer_details: { email: "a@b.test", address: { country: "ZA" } },
		};
		expect(
			await (
				await h.stripe({
					id: "evt_native",
					type: "checkout.session.completed",
					data: { object: session },
				})
			).json(),
		).toMatchObject({ error: expect.stringContaining("tax/total") });
		h.kv.rows.set(`draft:${draft}`, { cart: { ...quote, taxTotal: cash(0), total: cash(110) } });
		expect(
			await (
				await h.stripe({
					id: "evt_tax",
					type: "checkout.session.completed",
					data: {
						object: {
							...session,
							automatic_tax: { enabled: true, status: "complete" },
							total_details: { amount_tax: 3 },
						},
					},
				})
			).json(),
		).toMatchObject({ error: expect.stringContaining("tax/total") });
		// Native fixed tax = 100 + 10 + 5. It must pass the quote/PI
		// assertion (this deliberately minimal harness fails later in finalization).
		h.ctx.http!.fetch = async () =>
			Response.json({
				id: "pi_1",
				status: "succeeded",
				amount: 115,
				amount_received: 115,
				currency: "zar",
			});
		h.kv.rows.set(`draft:${draft}`, { cart: quote });
		const native = await h.stripe({
			id: "evt_native_valid",
			type: "checkout.session.completed",
			data: { object: { ...session, amount_total: 115 } },
		});
		expect((await native.json()).error).not.toContain("tax/total");
		expect(h.stores.stripe_events.rows.size).toBe(0);
		expect(h.stores.orders.rows.size).toBe(0);
	});
	it("authenticates refund notifications, never guesses unknown IDs", async () => {
		const h = setup();
		h.kv.rows.set("settings:paystackTestSecretKey", "sk_test_SYNTHETIC");
		// A valid unknown ID is now independently retrieved, not guessed or silently ACKed.
		h.ctx.http!.fetch = async () =>
			Response.json({
				status: true,
				data: {
					id: 123,
					amount: 1,
					currency: "ZAR",
					domain: "test",
					status: "processed",
					transaction: { reference: "dc_" + "b".repeat(32) },
				},
			});
		const response = await h.paystack({
			event: "refund.processed",
			data: { id: 123, amount: 1, status: "processed" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ignored: true });
		expect(
			(await h.paystack({ event: "refund.processed", data: { id: 123 } }, "sk_live_SYNTHETIC"))
				.status,
		).toBe(400);
	});
	it("binds known Paystack refund signature to mode; independently checks GET amount and ignores duplicate delivery", async () => {
		const h = setup();
		h.kv.rows.set("settings:paystackTestSecretKey", "sk_test_SYNTHETIC");
		h.kv.rows.set("settings:paystackLiveSecretKey", "sk_live_SYNTHETIC");
		const cash = (amount: number) => ({ amount, currency: "ZAR" });
		await h.stores.orders.put("order", {
			id: "order",
			orderNumber: "TEST-1",
			customerEmail: "a@b.test",
			billingAddress: { firstName: "Buyer" },
			status: "processing",
			paymentProvider: "paystack",
			paymentMode: "test",
			paymentReference: `paystack:test:dc_${draft}`,
			currency: "ZAR",
			paidTotal: cash(500),
			refundedTotal: cash(0),
			refundReservations: { refund: { amount: 100, status: "pending", restockQuantities: {} } },
		});
		await h.stores.payments.put("order", {
			status: "finalized",
			paymentKey: `paystack:test:dc_${draft}`,
		});
		await h.stores.refunds.put("refund", {
			id: "refund",
			requestId: "refund",
			orderId: "order",
			paymentProvider: "paystack",
			paymentMode: "test",
			providerRefundId: "123",
			providerRefundKey: "paystack:test:123",
			amount: cash(100),
			status: "pending",
			restocked: false,
			restockRequested: false,
		});
		const notice = {
			event: "refund.processed",
			data: { id: 123, amount: 100, status: "processed" },
		};
		expect((await h.paystack(notice, "sk_live_SYNTHETIC")).status).toBe(400);
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(0);
		let gets = 0;
		h.ctx.http!.fetch = async (_url: string, init: RequestInit) => {
			gets++;
			expect(init.method).toBe("GET");
			return Response.json({
				status: true,
				data: {
					id: 123,
					amount: 999,
					currency: "ZAR",
					domain: "test",
					status: "processed",
					transaction: { reference: `dc_${draft}` },
				},
			});
		};
		await expect(h.paystack(notice)).rejects.toThrow("identity conflict");
		await expect(h.paystack(notice)).rejects.toThrow("identity conflict");
		expect(gets).toBe(2);
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(0);
		h.ctx.http!.fetch = async () => {
			gets++;
			return Response.json({
				status: true,
				data: {
					id: 123,
					amount: 100,
					currency: "ZAR",
					domain: "test",
					status: "processed",
					transaction: { reference: `dc_${draft}` },
				},
			});
		};
		expect((await h.paystack(notice)).status).toBe(200);
		expect((await h.paystack(notice)).status).toBe(200);
		expect(gets).toBe(5); // independent GET on each delivery; pending reconciliation verifies again
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(100);
		expect(h.stores.commerce_outbox.rows.size).toBe(1);
	});
});
