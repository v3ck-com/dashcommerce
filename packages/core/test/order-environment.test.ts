import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { isTestOrder } from "../src/util/order-environment";
import { adminApiRoutes } from "../src/routes/admin-api";
import { conditionalStore } from "./helpers/conditional-store";

describe("payment environment classification", () => {
	it("recognizes both gateway test modes and legacy markers without relabelling unknown history", () => {
		expect(isTestOrder({ paymentProvider: "stripe", paymentMode: "test" })).toBe(true);
		expect(isTestOrder({ paymentProvider: "paystack", paymentMode: "test" })).toBe(true);
		expect(isTestOrder({ paymentProvider: "paystack-test" })).toBe(true);
		expect(isTestOrder({ metadata: { testMode: true } })).toBe(true);
		expect(isTestOrder({ paymentMode: "live" })).toBe(false);
		expect(isTestOrder({})).toBe(false);
	});
	it("keeps known test transactions out of live revenue widgets and reports", async () => {
		const orders = conditionalStore();
		const date = new Date().toISOString();
		for (const [id, fields] of Object.entries({
			live: { paymentMode: "live" },
			legacy: {},
			test: { paymentMode: "test" },
			oldTest: { paymentProvider: "paystack-test" },
		})) {
			orders.rows.set(id, {
				id,
				...fields,
				paymentStatus: "paid",
				currency: "ZAR",
				createdAt: date,
				paidTotal: { amount: 1000, currency: "ZAR" },
			});
		}
		const ctx = { storage: { orders } } as unknown as PluginContext;
		const route = { request: new Request("https://shop.test/reports") } as RouteContext;
		const widget = (await adminApiRoutes["admin/widgets/revenue-snapshot"]!.handler(
			route,
			ctx,
		)) as Response;
		expect((await widget.json()).sevenDay.ZAR).toBe(2000);
		const report = (await adminApiRoutes["admin/reports/revenue"]!.handler(route, ctx)) as Response;
		expect((await report.json()).series[0].currencies.ZAR).toBe(2000);
	});
});
