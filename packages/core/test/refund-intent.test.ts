import { describe, expect, it } from "bun:test";
import {
	finishRefundIntent,
	refundIntentKey,
	settleRefundIntent,
} from "../src/admin/refund-intent";

function storage() {
	const rows = new Map<string, string>();
	return {
		rows,
		getItem: (key: string) => rows.get(key) ?? null,
		setItem: (key: string, value: string) => {
			rows.set(key, value);
		},
		removeItem: (key: string) => {
			rows.delete(key);
		},
	};
}

describe("administrator refund intent", () => {
	it("reuses the same key after a lost response and across component reloads", async () => {
		const saved = storage();
		const payload = { amount: 1000, currency: "ZAR", reason: "Fixture refund" };
		const first = await refundIntentKey(saved, "order-fixture", payload);
		expect(await refundIntentKey(saved, "order-fixture", structuredClone(payload))).toBe(first);
		expect([...saved.rows.values()][0]).not.toContain("Fixture refund");
	});
	it("does not turn an unresolved refund into a different monetary request", async () => {
		const saved = storage();
		await refundIntentKey(saved, "order-fixture", { amount: 1000 });
		await expect(refundIntentKey(saved, "order-fixture", { amount: 2000 })).rejects.toThrow(
			"unresolved",
		);
	});
	it("clears a matching completed request found in history, never an unrelated or pending one", async () => {
		const saved = storage();
		const payload = { amount: 1000 };
		const key = await refundIntentKey(saved, "order-fixture", payload);
		settleRefundIntent(saved, "order-fixture", [
			{ requestId: "other", status: "succeeded" },
			{ requestId: key, status: "pending" },
		]);
		expect(await refundIntentKey(saved, "order-fixture", payload)).toBe(key);
		settleRefundIntent(saved, "order-fixture", [{ requestId: key, status: "succeeded" }]);
		expect(await refundIntentKey(saved, "order-fixture", payload)).not.toBe(key);
	});
	it("permits a new intent only after confirmed completion and isolates orders", async () => {
		const saved = storage();
		const payload = { amount: 1000 };
		const first = await refundIntentKey(saved, "order-fixture", payload);
		expect(await refundIntentKey(saved, "other-order", payload)).not.toBe(first);
		finishRefundIntent(saved, "order-fixture");
		expect(await refundIntentKey(saved, "order-fixture", payload)).not.toBe(first);
	});
});
