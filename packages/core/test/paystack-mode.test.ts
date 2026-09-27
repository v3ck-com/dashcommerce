import { describe, expect, it } from "bun:test";
import type { PluginContext } from "emdash";
import { money } from "../src/money";
import { getHostedCheckoutProvider, resolvePaystackKey } from "../src/payment-provider";
import { reconcilePendingAttempts } from "../src/payment-provider/reconcile";
import type { CartState } from "../src/types";
import {
	type PaymentAttempt,
	createPaystackRefund,
	initialize,
	retrievePaystackRefund,
	verify,
	verifySignature,
} from "../src/payment-provider/paystack-test";
import { conditionalStore } from "./helpers/conditional-store";

const testKey = "sk_test_FAKE000";
const liveKey = "sk_live_FAKE000";
const reference = `dc_${"a".repeat(32)}`;
function fixture() {
	const kv = conditionalStore();
	kv.rows.set("settings:paymentProvider", "paystack");
	kv.rows.set("settings:paystackMode", "live");
	kv.rows.set("settings:paystackTestSecretKey", testKey);
	kv.rows.set("settings:paystackLiveSecretKey", liveKey);
	const calls: { url: string; init: RequestInit }[] = [];
	let data: any = {};
	const payment_attempts = conditionalStore();
	const ctx = {
		kv: { ...kv, set: kv.put },
		storage: { payment_attempts },
		log: { error() {}, warn() {}, info() {} },
		http: {
			async fetch(url: string, init: RequestInit) {
				calls.push({ url, init });
				return Response.json({ status: true, data });
			},
		},
	} as unknown as PluginContext;
	return {
		ctx,
		kv,
		payment_attempts,
		calls,
		setData(v: any) {
			data = v;
		},
	};
}
const attempt = {
	id: "a".repeat(32),
	orderDraftId: "a".repeat(32),
	reference,
	mode: "live",
	provider: "paystack",
	amount: 1234,
	currency: "ZAR",
	email: "buyer@example.test",
} as PaymentAttempt;

describe("Paystack bound mode and refund transport (fake HTTP only)", () => {
	it("bounded scheduled recovery verifies without webhook/return and records pending", async () => {
		const f = fixture();
		await f.payment_attempts.put(attempt.id, {
			...attempt,
			phase: "initializing",
			inventoryLines: [],
			createdAt: "2025-01-01",
		});
		f.setData({
			reference,
			amount: 1234,
			currency: "ZAR",
			domain: "live",
			status: "pending",
			customer: { email: "buyer@example.test" },
			metadata: { orderDraftId: attempt.id, provider: "paystack", mode: "live" },
		});
		expect(await reconcilePendingAttempts(f.ctx, 1)).toMatchObject({
			examined: 1,
			verified: 0,
			errors: 0,
		});
		expect((await f.payment_attempts.get(attempt.id)).outcome).toBe("pending");
		expect(f.calls.map((c) => c.init.method)).toEqual(["GET"]);
	});
	it("initializes live with stored mode metadata, permits coupons, and sends one synthetic POST", async () => {
		const f = fixture();
		const address = {
			firstName: "Synthetic",
			lastName: "Buyer",
			line1: "1 Test",
			city: "Cape Town",
			region: "WC",
			postalCode: "8000",
			country: "ZA",
		};
		const cart = {
			currency: "ZAR",
			total: money("ZAR", 1234),
			customerEmail: "buyer@example.test",
			billingAddress: address,
			shippingAddress: address,
			coupons: ["WELCOME"],
			items: [{ quantity: 1, unitPrice: money("ZAR", 1234), lineSubtotal: money("ZAR", 1234) }],
		} as CartState;
		f.setData({
			authorization_url: "https://checkout.paystack.com/fake",
			access_code: "fake",
			reference,
		});
		const result = await initialize(f.ctx, liveKey, {
			orderDraftId: attempt.id,
			cart,
			callbackUrl: "https://shop.test/thank-you",
			mode: "live",
			provider: "paystack",
		});
		expect(result.mode).toBe("live");
		expect(result.provider).toBe("paystack");
		const posted = JSON.parse(f.calls[0]?.init.body as string);
		expect(posted.metadata).toEqual({
			orderDraftId: attempt.id,
			provider: "paystack",
			mode: "live",
		});
		expect(posted.currency).toBe("ZAR");
		expect(f.calls.length).toBe(1);
	});
	it("selects keys per stored mode; alias forces test even when UI is live", async () => {
		const f = fixture();
		expect(await getHostedCheckoutProvider(f.ctx)).toEqual({
			id: "paystack",
			mode: "live",
			secretKey: liveKey,
		});
		f.kv.rows.set("settings:paymentProvider", "paystack-test");
		expect(await getHostedCheckoutProvider(f.ctx)).toEqual({
			id: "paystack-test",
			mode: "test",
			secretKey: testKey,
		});
		expect(await resolvePaystackKey(f.ctx, attempt)).toBe(liveKey);
		expect(await resolvePaystackKey(f.ctx, { ...attempt, mode: undefined })).toBe(testKey);
		f.kv.rows.delete("settings:paystackLiveSecretKey");
		await expect(resolvePaystackKey(f.ctx, attempt)).rejects.toThrow("live secret");
	});
	it("verifies independent live-domain transaction, ignores current selector, rejects metadata/domain drift", async () => {
		const f = fixture();
		const data = {
			reference,
			amount: 1234,
			currency: "ZAR",
			domain: "live",
			status: "success",
			customer: { email: "buyer@example.test" },
			metadata: { orderDraftId: attempt.id, provider: "paystack", mode: "live" },
		};
		f.setData(data);
		expect(await verify(f.ctx, liveKey, attempt)).toBe("verified");
		f.setData({ ...data, domain: "test" });
		await expect(verify(f.ctx, liveKey, attempt)).rejects.toThrow("mismatch");
		f.setData({ ...data, metadata: { ...data.metadata, mode: "test" } });
		await expect(verify(f.ctx, liveKey, attempt)).rejects.toThrow("mismatch");
		expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
	});
	it("checks raw signed bytes against the stored mode secret", async () => {
		const raw = new TextEncoder().encode('{ "event":"charge.success" }');
		const imported = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(liveKey),
			{ name: "HMAC", hash: "SHA-512" },
			false,
			["sign"],
		);
		const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", imported, raw))]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		await verifySignature(raw, signature, liveKey, "live");
		await expect(verifySignature(raw, signature, testKey, "test")).rejects.toThrow("signature");
	});
	it("posts refund once with official schema, reads by id, validates mode/reference/amount", async () => {
		const f = fixture();
		const input = { reference, amount: 200, currency: "ZAR", customerNote: "Customer request" };
		const created = {
			id: 123,
			amount: 200,
			currency: "ZAR",
			domain: "live",
			status: "pending",
			transaction: { reference, domain: "live" },
		};
		f.setData(created);
		expect((await createPaystackRefund(f.ctx, liveKey, input, "live")).id).toBe(123);
		expect(f.calls[0]?.url).toBe("https://api.paystack.co/refund");
		expect(f.calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(f.calls[0]?.init.body as string)).toEqual({
			transaction: reference,
			amount: 200,
			currency: "ZAR",
			customer_note: "Customer request",
		});
		f.setData({
			id: 123,
			amount: 200,
			currency: "ZAR",
			domain: "live",
			status: "processed",
			transaction: 111,
			transaction_reference: reference,
		});
		expect((await retrievePaystackRefund(f.ctx, liveKey, 123, "live")).status).toBe("processed");
		expect(f.calls[1]?.url).toBe("https://api.paystack.co/refund/123");
		f.setData({ ...created, domain: "test" });
		await expect(createPaystackRefund(f.ctx, liveKey, input, "live")).rejects.toThrow("mismatch");
		f.setData({ ...created, amount: 300 });
		await expect(createPaystackRefund(f.ctx, liveKey, input, "live")).rejects.toThrow("mismatch");
	});
});
