import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { PluginContext } from "emdash";
import { webhookRoutes } from "../src/routes/webhook";
import { conditionalStore } from "./helpers/conditional-store";

const draft = "a".repeat(32);
const reference = `dc_${draft}`;
const money = (amount: number) => ({ amount, currency: "ZAR" });
function fixture(mode: "test" | "live" = "test") {
	const stores = Object.fromEntries(
		["orders", "order_items", "payments", "payment_attempts", "refunds", "commerce_outbox"].map(
			(n) => [n, conditionalStore(n === "refunds" ? ["providerRefundKey"] : [])],
		),
	) as Record<string, ReturnType<typeof conditionalStore>>;
	const kv = conditionalStore();
	kv.rows.set("settings:paystackTestSecretKey", "sk_test_SYNTHETIC");
	kv.rows.set("settings:paystackLiveSecretKey", "sk_live_SYNTHETIC");
	const responses = new Map<number, any>();
	const calls: string[] = [];
	const ctx = {
		storage: stores,
		kv: { ...kv, set: kv.put },
		site: { name: "Synthetic" },
		log: { info() {}, warn() {}, error() {} },
		http: {
			fetch: async (url: string, init: RequestInit) => {
				calls.push(url);
				expect(init.method).toBe("GET");
				expect(url).toMatch(/^https:\/\/api\.paystack\.co\/refund\/[0-9]+$/);
				const id = Number(url.split("/").at(-1));
				if (!responses.has(id)) throw new Error("Unmocked provider GET");
				return Response.json({ status: true, data: responses.get(id) });
			},
		},
	} as unknown as PluginContext;
	const provider = (id: number, status = "processed", extra: Record<string, unknown> = {}) => {
		responses.set(id, {
			id,
			status,
			domain: mode,
			amount: 100,
			currency: "ZAR",
			transaction: { reference },
			...extra,
		});
	};
	const order = async (finalized = true) => {
		await stores.orders.put("order", {
			id: "order",
			orderNumber: "T-1",
			customerEmail: "buyer@example.test",
			billingAddress: { firstName: "Buyer" },
			status: "processing",
			paymentProvider: "paystack",
			paymentMode: mode,
			paymentReference: `paystack:${mode}:${reference}`,
			currency: "ZAR",
			paidTotal: money(500),
			refundedTotal: money(0),
			refundReservations: {},
		});
		if (finalized)
			await stores.payments.put("order", {
				id: "order",
				status: "finalized",
				paymentKey: `paystack:${mode}:${reference}`,
			});
	};
	const attempt = async () =>
		stores.payment_attempts.put(draft, {
			id: draft,
			orderDraftId: draft,
			reference,
			mode,
			provider: "paystack",
			phase: "initialized",
		});
	const notify = async (id: number, signingMode: "test" | "live" = mode) => {
		const bytes = new TextEncoder().encode(
			JSON.stringify({ event: "refund.processed", data: { id, status: "processed", amount: 999 } }),
		);
		const sig = createHmac("sha512", `sk_${signingMode}_SYNTHETIC`).update(bytes).digest("hex");
		return (webhookRoutes["checkout/paystack-webhook"].handler as any)(
			{
				input: bytes,
				request: new Request("https://example.test/checkout/paystack-webhook", {
					method: "POST",
					headers: { "x-paystack-signature": sig },
					body: bytes,
				}),
			},
			ctx,
		) as Promise<Response>;
	};
	return { stores, ctx, calls, provider, order, attempt, notify };
}

describe("Paystack dashboard refund synchronization (GET-only synthetic provider)", () => {
	it("imports once, progresses pending to processed, ignores stale pending delivery and suppresses test receipts", async () => {
		const h = fixture();
		await h.order();
		h.provider(1, "pending");
		expect((await (await h.notify(1)).json()).status).toBe("pending");
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(0);
		h.provider(1);
		await h.notify(1);
		await h.notify(1);
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(100);
		expect(h.stores.orders.rows.get("order").paymentStatus).toBe("partially-refunded");
		expect(h.stores.refunds.rows.size).toBe(1);
		expect(h.stores.refunds.rows.get("paystack_external_test_1")).toMatchObject({
			status: "succeeded",
			effectsFinalized: true,
			restockRequested: false,
		});
		expect([...h.stores.commerce_outbox.rows.values()][0]).toMatchObject({
			status: "suppressed",
			testMode: true,
		});
		h.provider(1, "pending");
		await h.notify(1);
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(100);
		expect(h.calls.length).toBeGreaterThanOrEqual(4);
	});
	it("releases failed reservation without counting money, then rejects contradictory terminal outcome", async () => {
		const h = fixture();
		await h.order();
		h.provider(2, "pending");
		await h.notify(2);
		h.provider(2, "failed");
		await h.notify(2);
		await h.notify(2);
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(0);
		expect(h.stores.refunds.rows.get("paystack_external_test_2")).toMatchObject({
			status: "failed",
			effectsFinalized: true,
		});
		h.provider(2);
		await expect(h.notify(2)).rejects.toThrow("Conflicting terminal");
	});
	it("recovers the exact lost POST response via merchant_note, not a similar pending request", async () => {
		const h = fixture();
		await h.order();
		const id = `refund_${"a".repeat(64)}`;
		await h.stores.refunds.put(id, {
			id,
			requestId: id,
			requestHash: "hash",
			orderId: "order",
			paymentProvider: "paystack",
			paymentMode: "test",
			amount: money(100),
			status: "pending",
			transportState: "uncertain",
			restocked: false,
		});
		await h.stores.orders.put("order", {
			...h.stores.orders.rows.get("order"),
			refundReservations: { [id]: { amount: 100, status: "pending", restockQuantities: {} } },
		});
		h.provider(3, "processed", { merchant_note: `DashCommerce request ${id}` });
		const response = await h.notify(3);
		expect((await response.json()).refundId).toBe(id);
		expect(h.stores.refunds.rows.size).toBe(1);
		expect(h.stores.refunds.rows.get(id)).toMatchObject({
			providerRefundKey: "paystack:test:3",
			effectsFinalized: true,
		});
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(100);
	});
	it("never guesses among pending requests; preserves ceiling and reports operator reconciliation", async () => {
		const h = fixture();
		await h.order();
		await h.stores.orders.put("order", {
			...h.stores.orders.rows.get("order"),
			refundReservations: { unknown: { amount: 450, status: "pending", restockQuantities: {} } },
		});
		h.provider(4);
		expect(await (await h.notify(4)).json()).toMatchObject({ reconciliationRequired: true });
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(0);
		expect(h.stores.orders.rows.get("order").refundReservations.unknown.status).toBe("pending");
	});
	it("rejects wrong mode, amount, currency and correlated order conflicts", async () => {
		const h = fixture();
		await h.order();
		h.provider(5);
		expect((await h.notify(5, "live")).status).toBe(409);
		h.provider(5, "processed", { amount: 600 });
		expect(await (await h.notify(5)).json()).toMatchObject({ reconciliationRequired: true });
		h.provider(5, "processed", { currency: "NGN" });
		await expect(h.notify(5)).rejects.toThrow("currency conflict");
		const id = `refund_${"b".repeat(64)}`;
		await h.stores.refunds.put(id, {
			id,
			requestId: id,
			requestHash: "hash",
			orderId: "other",
			paymentProvider: "paystack",
			paymentMode: "test",
			amount: money(100),
			status: "pending",
			transportState: "uncertain",
			restocked: false,
		});
		h.provider(5, "processed", { merchant_note: `DashCommerce request ${id}` });
		await expect(h.notify(5)).rejects.toThrow("merchant note identity conflict");
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(0);
	});
	it("accepts only the test-mode legacy paystack-test reference alias", async () => {
		const h = fixture();
		await h.order();
		await h.stores.orders.put("order", {
			...h.stores.orders.rows.get("order"),
			paymentProvider: "paystack-test",
			paymentReference: `paystack-test:${reference}`,
		});
		await h.stores.payments.put("order", {
			status: "finalized_test",
			paymentKey: `paystack-test:${reference}`,
			provider: "paystack-test",
			mode: "test",
		});
		h.provider(7);
		expect((await (await h.notify(7)).json()).status).toBe("succeeded");
		expect(h.stores.orders.rows.get("order").refundedTotal.amount).toBe(100);
		expect([...h.stores.commerce_outbox.rows.values()][0].status).toBe("suppressed");
	});
	it("retries notifications for initialized attempts until both order and final marker exist", async () => {
		const h = fixture();
		await h.attempt();
		h.provider(6);
		await expect(h.notify(6)).rejects.toThrow("not finalized yet");
		await h.order(false);
		await expect(h.notify(6)).rejects.toThrow("finalization is incomplete");
		await h.stores.payments.put("order", { status: "finalized" });
		expect((await (await h.notify(6)).json()).status).toBe("succeeded");
	});
});
