import { describe, expect, it } from "bun:test";
import { runPaymentOperationsCron } from "../src/hooks/cron";
import { paymentOperationsRoutes } from "../src/routes/payment-operations";

function route(name: string) {
	return paymentOperationsRoutes[name as keyof typeof paymentOperationsRoutes] as {
		methods: string[];
		public?: boolean;
		request?: { maxBytes: number };
		handler: (ctx: any, plugin?: any) => Promise<Response>;
	};
}
function ctx(storage: Record<string, unknown>) {
	return { storage, kv: { get: async () => undefined }, log: { error() {}, warn() {} } };
}

describe("private payment operations routes", () => {
	it("declares admin operations private with bounded JSON mutations", () => {
		for (const name of [
			"admin/payment-operations/attempts",
			"admin/payment-operations/refunds",
			"admin/payment-operations/outbox",
			"admin/payment-operations/inventory",
		]) {
			expect(route(name).public).toBeUndefined();
			expect(route(name).methods).toEqual(["GET"]);
		}
		for (const name of [
			"admin/payment-operations/reconcile-attempt",
			"admin/payment-operations/reconcile-refund",
		]) {
			expect(route(name).public).toBeUndefined();
			expect(route(name).methods).toEqual(["POST"]);
			expect(route(name).request?.maxBytes).toBe(4096);
		}
	});
	it("bounds page limits and cursor length", async () => {
		const handler = route("admin/payment-operations/attempts").handler;
		const storage = {
			payment_attempts: {
				query: async () => ({ items: [], hasMore: false }),
				get: async () => undefined,
			},
		};
		for (const query of ["?limit=0", "?limit=101", `?cursor=${"x".repeat(513)}`]) {
			const response = await handler(
				{ request: new Request(`https://admin.test/${query}`) } as any,
				ctx(storage),
			);
			expect(response.status).toBe(400);
		}
	});
	it("omits receipt-capability fields and private customer data", async () => {
		const handler = route("admin/payment-operations/attempts").handler;
		const response = await handler(
			{ request: new Request("https://admin.test/?limit=10") } as any,
			ctx({
				payment_attempts: {
					query: async () => ({
						items: [
							{
								id: "a",
								data: {
									id: "a",
									reference: "ref",
									orderDraftId: "draft",
									cart: { secret: "cart" },
									email: "buyer@example.test",
									amount: 4,
									currency: "ZAR",
									phase: "initialized",
									outcome: "pending",
									createdAt: "now",
								},
							},
						],
						hasMore: false,
					}),
				},
			}),
		);
		const body = await response.json();
		expect(JSON.stringify(body)).not.toContain("buyer@example.test");
		expect(JSON.stringify(body)).not.toContain("secret");
		expect(body.items[0].amount).toBe(4);
		expect(body.items[0]).not.toHaveProperty("reference");
		expect(body.items[0]).not.toHaveProperty("orderDraftId");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});
	it("uses EmDash validated input without rereading request.text", async () => {
		const request = {
			text: () => {
				throw new Error("request body was reread");
			},
		};
		const attempt = route("admin/payment-operations/reconcile-attempt").handler;
		const result = await attempt(
			{ input: { attemptId: "missing" }, request } as any,
			ctx({ payment_attempts: { get: async () => undefined } }),
		);
		expect(result.status).toBe(404);
		const refund = route("admin/payment-operations/reconcile-refund").handler;
		const invalid = await refund(
			{ input: { refundId: "r", providerRefundId: " " }, request } as any,
			ctx({}),
		);
		expect(invalid.status).toBe(400);
	});

	it("runs bounded scheduled pages and suppresses delivery when the opt-in is off", async () => {
		const limits: number[] = [];
		let sent = 0;
		const collection = {
			query: async (options: { limit: number }) => {
				limits.push(options.limit);
				return { items: [], hasMore: false };
			},
		};
		const fake = {
			storage: { payment_attempts: collection, refunds: collection, commerce_outbox: collection },
			kv: { get: async () => false, set: async () => {} },
			email: {
				send: async () => {
					sent++;
				},
			},
			log: { error() {}, warn() {} },
		};
		const result = await runPaymentOperationsCron(fake as any);
		expect(result.attempts).toBe(0);
		expect(limits).toEqual([20, 20, 20]);
		expect(sent).toBe(0);
	});
});
