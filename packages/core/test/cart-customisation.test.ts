import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import type { CartState, OrderItem } from "../src/types";
import { cartRoutes } from "../src/routes/cart";
import { getCart } from "../src/cart/store";
import { createOrderFromPaymentIntent, loadOrderItems } from "../src/orders/create";

const definition = {
	fields: [
		{ key: "name", maxLength: 20, required: true },
		{ key: "style", maxLength: 12 },
	],
};

function fixture(customisable = true, withVariant = true) {
	const data = new Map<string, string>();
	const kvRevisions = new Map<string, number>();
	const rows = new Map<string, Map<string, unknown>>();
	const collection = (name: string) => {
		if (!rows.has(name)) rows.set(name, new Map());
		const store = rows.get(name)!;
		const revisions = new Map<string, number>();
		return {
			async get(id: string) {
				const value = store.get(id);
				return value === undefined ? null : structuredClone(value);
			},
			async getVersioned(id: string) {
				const value = store.get(id);
				return value === undefined
					? null
					: { value: structuredClone(value), revision: String(revisions.get(id) ?? 0) };
			},
			async put(id: string, value: unknown) {
				store.set(id, structuredClone(value));
				revisions.set(id, (revisions.get(id) ?? 0) + 1);
			},
			async compareAndSet(id: string, expected: string | null, value: unknown) {
				const revision = store.has(id) ? String(revisions.get(id) ?? 0) : null;
				if (revision !== expected) return { applied: false };
				store.set(id, structuredClone(value));
				revisions.set(id, (revisions.get(id) ?? 0) + 1);
				return { applied: true, revision: String(revisions.get(id)) };
			},
			async putMany(entries: Array<{ id: string; data: unknown }>) {
				for (const entry of entries) store.set(entry.id, structuredClone(entry.data));
			},
			async query(opts: { where?: Record<string, unknown>; limit?: number }) {
				return {
					items: [...store]
						.filter(([, value]) =>
							Object.entries(opts.where ?? {}).every(
								([k, v]) => (value as Record<string, unknown>)[k] === v,
							),
						)
						.slice(0, opts.limit)
						.map(([id, value]) => ({ id, data: structuredClone(value) })),
				};
			},
		};
	};
	collection("product_variants");
	if (withVariant)
		rows.get("product_variants")!.set("v1", {
			id: "v1",
			productId: "p1",
			sku: "ENGRAVED-1",
			// Empty native price map deliberately inherits the parent price.
			prices: {},
			stockQuantity: null,
			weightGrams: null,
			attributes: {},
			isActive: true,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		});
	const ctx = {
		kv: {
			async get(key: string) {
				const value = data.get(key);
				return value === undefined ? null : JSON.parse(value);
			},
			async getVersioned(key: string) {
				const value = data.get(key);
				return value === undefined
					? null
					: { value: JSON.parse(value), revision: String(kvRevisions.get(key) ?? 0) };
			},
			async set(key: string, value: unknown) {
				data.set(key, JSON.stringify(value));
				kvRevisions.set(key, (kvRevisions.get(key) ?? 0) + 1);
			},
			async compareAndSet(key: string, expected: string | null, value: unknown) {
				const revision = data.has(key) ? String(kvRevisions.get(key) ?? 0) : null;
				if (revision !== expected) return { applied: false };
				data.set(key, JSON.stringify(value));
				kvRevisions.set(key, (kvRevisions.get(key) ?? 0) + 1);
				return { applied: true, revision: String(kvRevisions.get(key)) };
			},
			async compareAndDelete(key: string, expected: string) {
				if (!data.has(key) || String(kvRevisions.get(key) ?? 0) !== expected)
					return { applied: false };
				data.delete(key);
				kvRevisions.set(key, (kvRevisions.get(key) ?? 0) + 1);
				return { applied: true };
			},
			async delete(key: string) {
				data.delete(key);
				kvRevisions.set(key, (kvRevisions.get(key) ?? 0) + 1);
			},
		},
		content: {
			async get(_collection: string, id: string) {
				return id === "p1"
					? {
							id,
							status: "published",
							data: {
								title: "Engraved item",
								prices: { USD: { amount: 2500 } },
								...(customisable ? { customisation_definition: JSON.stringify(definition) } : {}),
							},
						}
					: null;
			},
		},
		site: { name: "Test shop", url: "https://shop.test" },
		storage: {
			orders: collection("orders"),
			order_items: collection("order_items"),
			customers: collection("customers"),
			payments: collection("payments"),
			commerce_outbox: collection("commerce_outbox"),
			coupons: collection("coupons"),
			coupon_usage: collection("coupon_usage"),
			product_variants: collection("product_variants"),
		},
		log: { info() {}, debug() {}, warn() {}, error() {} },
	} as unknown as PluginContext;
	return { ctx, data };
}

async function call(ctx: PluginContext, path: string, input: unknown, method = "POST") {
	const routeCtx = {
		input,
		request: new Request(`http://test/${path}`, {
			method,
			headers: { cookie: "dashcommerce_sid=test-session" },
		}),
	} as RouteContext;
	const key = path.split("?")[0] as "cart/items";
	const response = await cartRoutes[key].handler(routeCtx, ctx);
	return {
		status: response.status,
		body: (await response.json()) as { cart?: CartState; error?: string },
	};
}

describe("server-declared cart customisation", () => {
	it("keeps different names separate; merges canonical equal options and persists through GET and order items", async () => {
		const { ctx, data } = fixture();
		const alice = { name: "Alice", style: "bold" };
		expect(
			(await call(ctx, "cart/items", { productId: "p1", variantId: "v1", customisation: alice }))
				.status,
		).toBe(200);
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "v1",
					customisation: { style: "bold", name: "Alice" },
					quantity: 2,
				})
			).status,
		).toBe(200);
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "v1",
					customisation: { name: "Bob", style: "bold" },
				})
			).status,
		).toBe(200);
		const snapshot = await getCart(ctx, "test-session");
		expect(snapshot?.items.map((i) => i.quantity)).toEqual([3, 1]);
		expect(snapshot?.items.map((i) => i.customisation?.name)).toEqual(["Alice", "Bob"]);
		expect(snapshot?.items.map((i) => i.unitPrice.amount)).toEqual([2500, 2500]);
		expect(snapshot?.subtotal.amount).toBe(10000);
		expect(data.has("cart:test-session")).toBe(true);
		const fetched = await call(ctx, "cart", {}, "GET");
		expect(fetched.body.cart?.items).toEqual(snapshot?.items);
		const lineId = snapshot!.items[0]!.lineId;
		const patched = await call(ctx, `cart/item?lineId=${lineId}`, { quantity: 4 }, "PATCH");
		expect(patched.body.cart?.items[0]?.customisation).toEqual(snapshot?.items[0]?.customisation);
		const persisted = await getCart(ctx, "test-session");
		expect(persisted?.items[0]?.quantity).toBe(4);
		const address = {
			firstName: "Test",
			lastName: "Buyer",
			line1: "Example",
			city: "Town",
			region: "",
			postalCode: "12345",
			country: "US",
		};
		const result = await createOrderFromPaymentIntent(ctx, {
			paymentIntent: {
				id: "pi_test",
				livemode: false,
				receipt_email: "test@example.invalid",
				status: "succeeded",
				amount_received: 12_500,
				currency: "usd",
			} as never,
			cartSnapshot: {
				...persisted!,
				billingAddress: address,
				shippingAddress: address,
				customerEmail: "test@example.invalid",
			},
			orderDraftId: "draft-test",
		});
		expect(result.duplicate).toBe(false);
		const items: OrderItem[] = await loadOrderItems(ctx, result.order.id);
		expect(items.map((i) => i.customisation?.name)).toEqual(["Alice", "Bob"]);
		expect(items.map((i) => i.quantity)).toEqual([4, 1]);
		expect(items.map((i) => i.unitPrice.amount)).toEqual([2500, 2500]);
	});

	it("rejects undeclared fields, invalid types and length without persisting a line or accepting a price", async () => {
		const { ctx } = fixture();
		for (const input of [
			{ name: "A", price: "0" },
			{ name: 42 },
			{ name: "x".repeat(21) },
			{ name: "  " },
			{},
			["Alice"],
			{ name: "Alice", style: { value: "bold" } },
		]) {
			expect(
				(await call(ctx, "cart/items", { productId: "p1", variantId: "v1", customisation: input }))
					.status,
			).toBe(400);
		}
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "v1",
					customisation: { name: "Alice" },
					price: 1,
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "v1",
					quantity: "2",
					customisation: { name: "Alice" },
				})
			).status,
		).toBe(400);
		expect((await getCart(ctx, "test-session"))?.items).toEqual([]);
	});

	it("rejects forged variants and unsafe quantities before persisting a cart line", async () => {
		const { ctx } = fixture();
		expect(
			(await call(ctx, "cart/items", { productId: "p1", customisation: { name: "Alice" } })).status,
		).toBe(409);
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "other",
					customisation: { name: "Alice" },
				})
			).status,
		).toBe(409);
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "v1",
					quantity: 1.5,
					customisation: { name: "Alice" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "v1",
					quantity: 1001,
					customisation: { name: "Alice" },
				})
			).status,
		).toBe(400);
		await (
			ctx.storage as unknown as {
				product_variants: { put(id: string, value: unknown): Promise<void> };
			}
		).product_variants.put("v1", {
			id: "v1",
			productId: "p1",
			stockQuantity: null,
			isActive: false,
		});
		expect(
			(
				await call(ctx, "cart/items", {
					productId: "p1",
					variantId: "v1",
					customisation: { name: "Alice" },
				})
			).status,
		).toBe(409);
		expect((await getCart(ctx, "test-session"))?.items).toEqual([]);
	});

	it("unchanged products still merge; unconfigured customisation is refused", async () => {
		const { ctx } = fixture(false, false);
		expect(
			(await call(ctx, "cart/items", { productId: "p1", customisation: { name: "A" } })).status,
		).toBe(400);
		await call(ctx, "cart/items", { productId: "p1" });
		await call(ctx, "cart/items", { productId: "p1" });
		expect((await getCart(ctx, "test-session"))?.items.map((i) => i.quantity)).toEqual([2]);
	});
});
