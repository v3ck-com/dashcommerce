import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { cartRoutes } from "../src/routes/cart";
import { getCart } from "../src/cart/store";
import { checkoutRoutes } from "../src/routes/checkout";
import { defineProductsCollection } from "../src/seed/products-collection";
import { conditionalStore } from "./helpers/conditional-store";

function fixture(stock: number) {
	const values = new Map<string, string>();
	const product = {
		title: "Personalised planner",
		prices: { ZAR: { amount: 25000 } },
		manage_stock: true,
		stock_quantity: stock,
		stock_status: "instock",
		backorders: "no",
		is_virtual: true,
		customisation_definition: { fields: [{ key: "name", maxLength: 30, required: true }] },
	};
	values.set("settings:defaultCurrency", JSON.stringify("ZAR"));
	values.set("settings:paymentProvider", JSON.stringify("paystack-test"));
	values.set("settings:paystackSecretKey", JSON.stringify("sk_test_FAKE000"));
	const ctx = {
		kv: {
			async get(key: string) {
				return values.has(key) ? JSON.parse(values.get(key)!) : null;
			},
			async set(key: string, value: unknown) {
				values.set(key, JSON.stringify(value));
			},
			async delete(key: string) {
				return values.delete(key);
			},
			async list(prefix: string) {
				return [...values]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, value]) => ({ key, value: JSON.parse(value) }));
			},
			async getVersioned(key: string) {
				return values.has(key)
					? { value: JSON.parse(values.get(key)!), revision: values.get(`${key}:revision`) ?? "0" }
					: null;
			},
			async compareAndSet(key: string, expected: string | null, value: unknown) {
				const revision = values.has(key) ? (values.get(`${key}:revision`) ?? "0") : null;
				if (revision !== expected) return { applied: false as const };
				const next = String(Number(revision ?? "0") + 1);
				values.set(key, JSON.stringify(value));
				values.set(`${key}:revision`, next);
				return { applied: true as const, revision: next };
			},
			async compareAndDelete(key: string, expected: string) {
				if ((values.get(`${key}:revision`) ?? "0") !== expected) return { applied: false };
				values.delete(key);
				values.delete(`${key}:revision`);
				return { applied: true };
			},
		},
		content: {
			async get(_collection: string, id: string) {
				return id === "planner"
					? { id, status: "published", data: structuredClone(product) }
					: null;
			},
		},
		storage: {
			product_variants: {
				async get() {
					return null;
				},
				async query() {
					return { items: [], hasMore: false };
				},
			},
			payment_attempts: conditionalStore(),
		},
		site: { url: "https://shop.test", name: "Isolated spike" },
		url: (path: string) => `https://shop.test${path}`,
		http: {
			fetch: async (_url: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { reference: string };
				return Response.json({
					status: true,
					data: {
						authorization_url: "https://checkout.paystack.com/test",
						access_code: "access",
						reference: body.reference,
					},
				});
			},
		},
		log: { info() {}, warn() {}, error() {}, debug() {} },
	} as unknown as PluginContext;
	const route = (input: unknown) =>
		({
			input,
			request: new Request("http://localhost:4799/spike", {
				method: "POST",
				headers: { cookie: "dashcommerce_sid=personalised" },
			}),
		}) as RouteContext;
	const add = async (name: string) => {
		const response = await cartRoutes["cart/items"].handler(
			route({ productId: "planner", customisation: { name } }),
			ctx,
		);
		expect(response.status).toBe(200);
	};
	const checkout = async () => {
		const cart = await getCart(ctx, "personalised");
		const address = {
			firstName: "Test",
			lastName: "Buyer",
			line1: "1 Main",
			city: "Cape Town",
			region: "WC",
			postalCode: "8000",
			country: "ZA",
		};
		await ctx.kv.set("cart:personalised", {
			...cart!,
			customerEmail: "buyer@example.invalid",
			billingAddress: address,
			shippingAddress: address,
		});
		return checkoutRoutes["checkout/create-session"].handler(
			route({ customerEmail: "buyer@example.invalid" }),
			ctx,
		);
	};
	return { ctx, values, product, add, checkout, route };
}

describe("personalisation + provider integration (lead regression checks)", () => {
	it("declares the server-owned customisation schema in the CMS seed", () => {
		const fields = defineProductsCollection().fields as Array<Record<string, unknown>>;
		expect(fields.find((field) => field.slug === "customisation_definition")?.type).toBe("json");
	});

	it("rejects two separately personalised lines competing for the last unit", async () => {
		const f = fixture(1);
		await f.add("Alice");
		await f.add("Bob");
		const response = await f.checkout();
		expect(response.status).toBe(409);
		expect(
			[...f.values.keys()].some((key) => key.startsWith("draft:") || key.startsWith("lock:")),
		).toBe(false);
	});

	it("preserves both names in the ZAR payment draft when combined stock is sufficient", async () => {
		const f = fixture(2);
		await f.add("Alice");
		await f.add("Bob");
		const response = await f.checkout();
		expect(response.status).toBe(200);
		const result = (await response.json()) as { total: unknown; orderDraftId: string };
		expect(result.total).toEqual({ currency: "ZAR", amount: 50000 });
		const draft = JSON.parse(f.values.get(`draft:${result.orderDraftId}`)!);
		expect(
			draft.cart.items.map((line: { customisation: { name: string } }) => line.customisation.name),
		).toEqual(["Alice", "Bob"]);
	});

	it("revalidates options against current published CMS rules at checkout", async () => {
		const f = fixture(2);
		await f.add("Alice");
		f.product.customisation_definition.fields[0]!.maxLength = 2;
		expect((await f.checkout()).status).toBe(409);
	});

	it("fails closed for an unknown provider instead of falling back to Stripe", async () => {
		const f = fixture(2);
		await f.add("Alice");
		await f.ctx.kv.set("settings:paymentProvider", "paystack-typo");
		expect((await f.checkout()).status).toBe(503);
	});

	it("rejects the embedded Stripe intent route when Paystack mock is selected", async () => {
		const f = fixture(2);
		await f.add("Alice");
		const response = await checkoutRoutes["checkout/create-intent"].handler(f.route({}), f.ctx);
		expect(response.status).toBe(501);
	});

	it("does not silently omit Stripe-calculated tax on the Paystack path", async () => {
		const f = fixture(2);
		await f.add("Alice");
		await f.ctx.kv.set("settings:taxMode", "stripe_tax");
		expect((await f.checkout()).status).toBe(501);
		expect(
			[...f.values.keys()].some((key) => key.startsWith("draft:") || key.startsWith("lock:")),
		).toBe(false);
	});
});
