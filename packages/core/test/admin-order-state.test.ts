import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { adminApiRoutes } from "../src/routes/admin-api";
import { conditionalStore } from "./helpers/conditional-store";

function fixture() {
	const orders = conditionalStore();
	orders.rows.set("fixture", {
		id: "fixture",
		status: "processing",
		paymentStatus: "paid",
		paymentMode: "test",
		paidTotal: { amount: 2000, currency: "ZAR" },
		refundedTotal: { amount: 0, currency: "ZAR" },
		metadata: { testMode: true },
	});
	let mailCalls = 0;
	const ctx = {
		storage: { orders },
		kv: {
			async get() {
				return true;
			},
		},
		email: {
			async send() {
				mailCalls++;
			},
		},
		log: { warn() {} },
	} as unknown as PluginContext;
	const request = {
		request: new Request("https://shop.test/admin/orders/status?id=fixture", { method: "POST" }),
		input: { status: "completed" },
	} as RouteContext;
	const run = () =>
		adminApiRoutes["admin/orders/status"]!.handler(request, ctx) as Promise<Response>;
	return { orders, run, mailCalls: () => mailCalls };
}

describe("admin order state preserves payment effects", () => {
	it("does not overwrite a concurrently committed refund", async () => {
		const f = fixture();
		const original = f.orders.compareAndSet;
		let raced = false;
		f.orders.compareAndSet = async (id, revision, value) => {
			if (!raced) {
				raced = true;
				await f.orders.put(id, {
					...(await f.orders.get(id)),
					refundedTotal: { amount: 500, currency: "ZAR" },
					paymentStatus: "partially-refunded",
				});
				return { applied: false };
			}
			return original(id, revision, value);
		};
		const response = await f.run();
		expect(response.status).toBe(200);
		const order = (await response.json()).order;
		expect(order.refundedTotal.amount).toBe(500);
		expect(order.paymentStatus).toBe("partially-refunded");
		expect(order.status).toBe("completed");
	});
	it("never sends fulfilment/review email for a test order", async () => {
		const f = fixture();
		expect((await f.run()).status).toBe(200);
		expect(f.mailCalls()).toBe(0);
	});
	it("fails visibly on persistent contention instead of blind overwriting", async () => {
		const f = fixture();
		f.orders.compareAndSet = async () => ({ applied: false });
		expect((await f.run()).status).toBe(409);
		expect((await f.orders.get("fixture")).status).toBe("processing");
	});
});
