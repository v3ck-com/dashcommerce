import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { adminApiRoutes } from "../src/routes/admin-api";
import {
	CouponQuotaConflict,
	reserveCouponClaims,
	readCouponCustomerUsage,
	releaseCouponClaims,
	consumeAndAccountCoupon,
} from "../src/coupons/reservations";
import type { CartState, Coupon } from "../src/types";

function fixture(options: { perCustomer?: number; auditFails?: boolean } = {}) {
	const kv = new Map<string, { value: any; revision: string }>();
	let rev = 0;
	const rows = new Map<string, Map<string, any>>();
	let failAudit = options.auditFails ?? false;
	const store = (name: string) => {
		if (!rows.has(name)) rows.set(name, new Map());
		const data = rows.get(name)!;
		return {
			async query({ where = {}, limit = 100 }: any = {}) {
				const matched = [...data.values()].filter((r) =>
					Object.entries(where).every(([k, v]) => r[k] === v),
				);
				return {
					items: matched.slice(0, limit).map((value) => ({ id: value.id, data: value })),
					hasMore: matched.length > limit,
				};
			},
			async get(id: string) {
				return data.get(id) ?? null;
			},
			async getVersioned(id: string) {
				const value = data.get(id);
				return value ? { value: structuredClone(value), revision: String(value.__rev) } : null;
			},
			async compareAndSet(id: string, expected: string | null, value: any) {
				const current = data.get(id);
				if ((current ? String(current.__rev) : null) !== expected) return { applied: false };
				const saved = structuredClone(value);
				saved.__rev = ++rev;
				data.set(id, saved);
				return { applied: true, revision: String(saved.__rev) };
			},
			async put(id: string, value: any) {
				data.set(id, structuredClone(value));
			},
		};
	};
	const coupon: Coupon = {
		id: "coupon1",
		code: "SAVE",
		discountType: "percent_cart",
		discountValue: 10,
		status: "active",
		excludeSaleItems: false,
		usageCount: 0,
		usageLimit: 1,
		...(options.perCustomer ? { usageLimitPerCustomer: options.perCustomer } : {}),
		individualUse: false,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
	const cs = store("coupons"),
		customers = store("customers"),
		audit = store("coupon_usage");
	cs.put(coupon.id, coupon);
	customers.put("customer_a", { id: "customer_a", email: "a@example.com" });
	const auditStore = {
		...audit,
		async compareAndSet(id: string, expected: string | null, value: any) {
			if (failAudit) throw new Error("audit unavailable");
			return audit.compareAndSet(id, expected, value);
		},
	};
	const ctx = {
		kv: {
			async getVersioned(key: string) {
				const v = kv.get(key);
				return v ? structuredClone(v) : null;
			},
			async compareAndSet(key: string, expected: string | null, value: any) {
				if ((kv.get(key)?.revision ?? null) !== expected) return { applied: false };
				const revision = String(++rev);
				kv.set(key, { value: structuredClone(value), revision });
				return { applied: true, revision };
			},
		},
		storage: { coupons: cs, customers, coupon_usage: auditStore },
	} as unknown as PluginContext;
	const cart = {
		sessionId: "session-a",
		customerEmail: "a@example.com",
		items: [],
		coupons: [
			{ code: "SAVE", discountAmount: { amount: 1, currency: "USD" }, freeShipping: false },
		],
		total: { amount: 10, currency: "USD" },
	} as CartState;
	return {
		ctx,
		cart,
		coupon,
		rows,
		cs,
		audit,
		setAuditFailure(value: boolean) {
			failAudit = value;
		},
	};
}
const amount = { amount: 1, currency: "USD" } as const;

describe("coupon quota reservations", () => {
	it("renamed coupon eligibility includes legacy aliases and stable usage identities", async () => {
		const f = fixture();
		await f.audit.put("old", { id: "old", couponCode: "SAVE", customerId: "customer_a" });
		await f.audit.put("stable", {
			id: "stable",
			couponCode: "ANOTHER_OLD_CODE",
			couponId: "coupon1",
			customerId: "customer_a",
		});
		expect(
			await readCouponCustomerUsage(
				f.ctx,
				{ ...f.coupon, code: "NEW", historicalCodes: ["SAVE"] },
				" A@EXAMPLE.COM ",
			),
		).toBe(2);
	});
	it("eligibility sees accounting committed before an interrupted audit insert", async () => {
		const f = fixture({ auditFails: true });
		await reserveCouponClaims(f.ctx, "draft", f.cart, "live");
		await expect(
			consumeAndAccountCoupon(f.ctx, f.coupon, "draft", "order", "customer_a", amount, "now"),
		).rejects.toThrow("audit unavailable");
		(f.ctx.storage as any).coupon_usage.query = async () => {
			throw new Error("history unavailable");
		};
		expect(await readCouponCustomerUsage(f.ctx, await f.cs.get("coupon1"), "a@example.com")).toBe(
			1,
		);
	});
	it("admits one of two live drafts for the last use and retries idempotently", async () => {
		const { ctx, cart } = fixture();
		await reserveCouponClaims(ctx, "draft-a", cart, "live");
		await reserveCouponClaims(ctx, "draft-a", cart, "live");
		await expect(reserveCouponClaims(ctx, "draft-b", cart, "live")).rejects.toBeInstanceOf(
			CouponQuotaConflict,
		);
	});
	it("test mode has no live quota changes and TTL is bounded", async () => {
		const { ctx, cart, cs } = fixture();
		const before = await cs.get("coupon1");
		await reserveCouponClaims(ctx, "test", cart, "test");
		expect(await cs.get("coupon1")).toEqual(before);
		await expect(reserveCouponClaims(ctx, "bad", cart, "live", { ttlMs: 0 })).rejects.toThrow(
			/TTL/,
		);
		await reserveCouponClaims(ctx, "draft", cart, "live");
	});
	it("rejects changed cart/customer snapshot on duplicate preparation", async () => {
		const { ctx, cart } = fixture();
		await reserveCouponClaims(ctx, "draft", cart, "live");
		await expect(
			reserveCouponClaims(
				ctx,
				"draft",
				{ ...cart, total: { amount: 9, currency: "USD" } } as CartState,
				"live",
			),
		).rejects.toThrow(/identity\/cart conflict/);
	});
	it("accounts unlimited purchases so limit -> unlimited use -> limit cannot over-admit", async () => {
		const { ctx, cart, coupon, cs } = fixture();
		await reserveCouponClaims(ctx, "first", cart, "live");
		await consumeAndAccountCoupon(ctx, coupon, "first", "order1", "customer_a", amount, "now");
		const row = await cs.get("coupon1");
		await cs.put("coupon1", { ...row, usageLimit: undefined, usageLimitPerCustomer: undefined });
		await consumeAndAccountCoupon(
			ctx,
			{ ...row, usageLimit: undefined, usageLimitPerCustomer: undefined },
			"unlimited",
			"order2",
			"customer_a",
			amount,
			"now",
		);
		await cs.put("coupon1", { ...(await cs.get("coupon1")), usageLimit: 2 });
		await expect(reserveCouponClaims(ctx, "third", cart, "live")).rejects.toBeInstanceOf(
			CouponQuotaConflict,
		);
	});
	it("enforces per-customer capacity within a concurrent reservation cycle", async () => {
		const { ctx, cart } = fixture({ perCustomer: 1 });
		const results = await Promise.allSettled([
			reserveCouponClaims(ctx, "a", cart, "live"),
			reserveCouponClaims(ctx, "b", cart, "live"),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	});
	it("commits accounting before audit; retry repairs audit without double counting", async () => {
		const f = fixture({ auditFails: true });
		await reserveCouponClaims(f.ctx, "draft", f.cart, "live");
		await expect(
			consumeAndAccountCoupon(f.ctx, f.coupon, "draft", "order", "customer_a", amount, "now"),
		).rejects.toThrow("audit unavailable");
		const after = await f.cs.get("coupon1");
		expect(after.usageCount).toBe(1);
		f.setAuditFailure(false);
		// Store adapter's failure flag is captured by fixture; install a functioning audit collection after the simulated crash.
		const audit = f.audit as any;
		(f.ctx.storage as any).coupon_usage = {
			...audit,
			async compareAndSet(...args: any[]) {
				return audit.compareAndSet(...args);
			},
		};
		await consumeAndAccountCoupon(f.ctx, f.coupon, "draft", "order", "customer_a", amount, "now");
		expect((await f.cs.get("coupon1")).usageCount).toBe(1);
		expect((await f.audit.query({})).items).toHaveLength(1);
	});
	it("global quota works before hosted checkout collects email; empty/unlimited carts need no identity", async () => {
		const f = fixture();
		const anonymous = { ...f.cart, customerEmail: undefined };
		await reserveCouponClaims(f.ctx, "empty", { ...anonymous, coupons: [] }, "live");
		await reserveCouponClaims(f.ctx, "global", anonymous, "live");
		expect(
			await consumeAndAccountCoupon(
				f.ctx,
				f.coupon,
				"global",
				"order",
				"customer_a",
				amount,
				"now",
			),
		).toBe(true);
		expect((await f.cs.get("coupon1")).usageCount).toBe(1);
	});
	it("per-customer capacity is independent of a larger global limit", async () => {
		const f = fixture({ perCustomer: 1 });
		await f.cs.put("coupon1", { ...f.coupon, usageLimit: 10 });
		await reserveCouponClaims(f.ctx, "first", f.cart, "live");
		await expect(reserveCouponClaims(f.ctx, "same", f.cart, "live")).rejects.toBeInstanceOf(
			CouponQuotaConflict,
		);
		await reserveCouponClaims(
			f.ctx,
			"different",
			{ ...f.cart, customerEmail: "b@example.com" },
			"live",
		);
	});
	it("unlimited accounting hydrates legacy history before a customer limit is enabled", async () => {
		const f = fixture();
		const unlimited = { ...f.coupon, usageCount: 3, usageLimit: undefined };
		await f.cs.put("coupon1", unlimited);
		for (let i = 0; i < 3; i++)
			await f.audit.put(`old${i}`, { id: `old${i}`, couponCode: "SAVE", customerId: "customer_a" });
		expect(
			await consumeAndAccountCoupon(
				f.ctx,
				unlimited,
				"unlimited",
				"order",
				"customer_a",
				amount,
				"now",
			),
		).toBe(true);
		await f.cs.put("coupon1", { ...(await f.cs.get("coupon1")), usageLimitPerCustomer: 4 });
		await expect(reserveCouponClaims(f.ctx, "later", f.cart, "live")).rejects.toBeInstanceOf(
			CouponQuotaConflict,
		);
	});
	it("a failed consumption CAS cannot carry an accepted decision into a rejected retry", async () => {
		const f = fixture();
		await reserveCouponClaims(f.ctx, "draft", f.cart, "live");
		const cas = f.cs.compareAndSet;
		let raced = false;
		f.cs.compareAndSet = async (id, revision, value) => {
			if (!raced) {
				raced = true;
				await f.cs.put(id, { ...(await f.cs.get(id)), _quotaClaims: {} });
				return { applied: false };
			}
			return cas(id, revision, value);
		};
		expect(
			await consumeAndAccountCoupon(f.ctx, f.coupon, "draft", "order", "customer_a", amount, "now"),
		).toBe(false);
		expect((await f.cs.get("coupon1")).usageCount).toBe(0);
		expect((await f.audit.query({})).items).toHaveLength(0);
	});
	it("a changed hosted customer cannot consume another customer's limited claim", async () => {
		const f = fixture({ perCustomer: 1 });
		f.rows.get("customers")!.set("customer_b", { id: "customer_b", email: "b@example.com" });
		await reserveCouponClaims(f.ctx, "draft", f.cart, "live");
		expect(
			await consumeAndAccountCoupon(f.ctx, f.coupon, "draft", "order", "customer_b", amount, "now"),
		).toBe(false);
		expect((await f.cs.get("coupon1")).usageCount).toBe(0);
	});
	it("stable coupon identity survives code renaming and released preflight retry", async () => {
		const f = fixture();
		f.cart.coupons[0]!.couponId = "coupon1";
		await reserveCouponClaims(f.ctx, "draft", f.cart, "live");
		await f.cs.put("coupon1", {
			...(await f.cs.get("coupon1")),
			code: "RENAMED",
			historicalCodes: ["SAVE"],
		});
		await releaseCouponClaims(f.ctx, "draft", f.cart, "live");
		await reserveCouponClaims(f.ctx, "draft", f.cart, "live");
		expect(
			await consumeAndAccountCoupon(
				f.ctx,
				await f.cs.get("coupon1"),
				"draft",
				"order",
				"customer_a",
				amount,
				"now",
			),
		).toBe(true);
		expect((await f.audit.query({})).items[0].data.couponId).toBe("coupon1");
	});
	it("coupon edits preserve concurrent accounting and GET never modifies a coupon", async () => {
		const f = fixture();
		const handler = adminApiRoutes["admin/coupons/item"]!.handler;
		const before = structuredClone(await f.cs.get("coupon1"));
		const get = (await handler(
			{
				request: new Request("https://shop.test/admin/coupons/item?id=coupon1"),
				input: { id: "coupon1" },
			} as RouteContext,
			f.ctx,
		)) as Response;
		expect(get.status).toBe(200);
		expect(await f.cs.get("coupon1")).toEqual(before);
		const cas = f.cs.compareAndSet;
		let raced = false;
		f.cs.compareAndSet = async (id, revision, value) => {
			if (!raced) {
				raced = true;
				await cas(id, revision, {
					...(await f.cs.get(id)),
					usageCount: 7,
					accountedOrderIds: { paid: true },
				});
				return { applied: false };
			}
			return cas(id, revision, value);
		};
		const response = (await handler(
			{
				request: new Request("https://shop.test/admin/coupons/item?id=coupon1", { method: "POST" }),
				input: {
					...f.coupon,
					code: "NEW",
					usageCount: 999,
					usageLimit: 10,
					includedCategorySlugs: ["category"],
				},
			} as RouteContext,
			f.ctx,
		)) as Response;
		expect(response.status).toBe(200);
		const row = await f.cs.get("coupon1");
		expect(row.usageCount).toBe(7);
		expect(row.accountedOrderIds).toEqual({ paid: true });
		expect(row.historicalCodes).toContain("SAVE");
		expect(row.includedCategorySlugs).toEqual(["category"]);
	});
	it("release only frees pending claims and preserves consumed capacity", async () => {
		const { ctx, cart, coupon } = fixture();
		await reserveCouponClaims(ctx, "draft", cart, "live");
		await consumeAndAccountCoupon(ctx, coupon, "draft", "order", "customer_a", amount, "now");
		await releaseCouponClaims(ctx, "draft", cart, "live");
		await expect(reserveCouponClaims(ctx, "other", cart, "live")).rejects.toBeInstanceOf(
			CouponQuotaConflict,
		);
	});
});
