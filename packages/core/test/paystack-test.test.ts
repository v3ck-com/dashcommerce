import { describe, it, expect } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { money } from "../src/money";
import { cartKey } from "../src/cart/store";
import { checkoutRoutes } from "../src/routes/checkout";
import { cartRoutes } from "../src/routes/cart";
import { webhookRoutes } from "../src/routes/webhook";
import { ordersPublicRoutes } from "../src/routes/orders-public";
import type { CartState } from "../src/types";
import { initialize } from "../src/payment-provider/paystack-test";
import { getInventoryReservation } from "../src/inventory";
import { conditionalStore } from "./helpers/conditional-store";
import { validateSettingsKey } from "../src/settings/schema";
import { refundOrder } from "../src/orders/refund";

const key = "sk_test_FAKE000";
const address = {
	firstName: "Test",
	lastName: "Buyer",
	line1: "1 Main",
	city: "Cape Town",
	region: "WC",
	postalCode: "8000",
	country: "ZA",
};
function setup(physical = false) {
	const cart: CartState = {
		sessionId: "session",
		currency: "ZAR",
		items: [
			{
				lineId: "line",
				productId: "product",
				quantity: 1,
				unitPrice: money("ZAR", 9999),
				lineSubtotal: money("ZAR", 9999),
				title: "Client price",
				isDigital: !physical,
			},
		],
		coupons: [],
		billingAddress: address,
		shippingAddress: address,
		taxLines: [],
		subtotal: money("ZAR", 9999),
		discountTotal: money("ZAR", 0),
		shippingTotal: money("ZAR", 0),
		taxTotal: money("ZAR", 0),
		total: money("ZAR", 9999),
		customerEmail: "buyer@example.test",
		createdAt: "2025-01-01",
		updatedAt: "2025-01-01",
		...(physical
			? { shippingMethod: { id: "flat", label: "Delivery", amount: money("ZAR", 500) } }
			: {}),
	};
	const kv = conditionalStore();
	kv.rows.set("settings:paymentProvider", "paystack-test");
	kv.rows.set("settings:paystackSecretKey", key);
	kv.rows.set(cartKey("session"), cart);
	const storage = {
		payment_attempts: conditionalStore(["reference", "orderDraftId"]),
		payments: conditionalStore(["paymentKey"]),
		orders: conditionalStore(["paymentReference", "orderNumber"]),
		order_items: conditionalStore(),
		customers: conditionalStore(["email"]),
		product_variants: conditionalStore(),
		shipping_zones: conditionalStore(),
		shipping_methods: conditionalStore(),
	};
	storage.shipping_zones.rows.set("za", {
		id: "za",
		name: "ZA",
		order: 1,
		locations: [{ country: "ZA" }],
	});
	storage.shipping_methods.rows.set("flat", {
		id: "flat",
		zoneId: "za",
		title: "Delivery",
		type: "flat_rate",
		enabled: true,
		config: { type: "flat_rate", amount: money("ZAR", 500) },
	});
	const product = {
		title: "Actual price",
		type: "simple",
		prices: { ZAR: { amount: 2000 } },
		manage_stock: true,
		stock_quantity: 20,
		is_virtual: !physical,
		stock_status: "instock",
		backorders: "no",
	};
	let verified: any = {};
	let failVerify = false;
	let loseInitialize = false;
	const calls: string[] = [];
	const ctx = {
		storage,
		kv: { ...kv, set: kv.put },
		site: { url: "https://shop.test", name: "Shop" },
		url: (s: string) => `https://shop.test${s}`,
		log: { info() {}, warn() {}, error() {}, debug() {} },
		content: {
			async get() {
				return { status: "published", data: structuredClone(product) };
			},
		},
		http: {
			async fetch(url: string, init: RequestInit) {
				calls.push(url);
				expect(url.startsWith("https://api.paystack.co/transaction/")).toBe(true);
				expect(init.redirect).toBe("error");
				if (url.endsWith("/initialize")) {
					const body = JSON.parse(init.body as string);
					verified = {
						reference: body.reference,
						amount: body.amount,
						currency: "ZAR",
						domain: "test",
						status: "success",
						metadata: body.metadata,
						customer: { email: body.email },
					};
					if (loseInitialize) throw new Error("provider accepted, response lost");
					return Response.json({
						status: true,
						data: {
							authorization_url: "https://checkout.paystack.com/test",
							access_code: "access",
							reference: body.reference,
						},
					});
				}
				if (failVerify) throw new Error("injected transport failure");
				return Response.json({ status: true, data: verified });
			},
		},
	} as unknown as PluginContext;
	return {
		ctx,
		storage,
		kv,
		cart,
		product,
		calls,
		verified: () => verified,
		setVerified: (v: any) => {
			verified = v;
		},
		fail: (v: boolean) => {
			failVerify = v;
		},
		lose: () => {
			loseInitialize = true;
		},
	};
}
function route(
	path: string,
	input: unknown,
	method = "POST",
	headers: Record<string, string> = {},
): RouteContext {
	return {
		input,
		request: new Request(`https://shop.test/${path}`, {
			method,
			headers: { cookie: "dashcommerce_sid=session", ...headers },
		}),
	} as RouteContext;
}
async function sign(raw: Uint8Array) {
	const imported = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(key),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	return [...new Uint8Array(await crypto.subtle.sign("HMAC", imported, raw))]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
const create = (ctx: PluginContext, input: unknown = {}) =>
	checkoutRoutes["checkout/create-session"].handler(
		route("checkout/create-session", input),
		ctx,
	) as Promise<Response>;
async function session(ctx: PluginContext) {
	const res = await create(ctx);
	expect(res.status).toBe(200);
	return (await res.json()) as {
		orderDraftId: string;
		reference: string;
		url: string;
		total: { amount: number };
	};
}
const poll = async (ctx: PluginContext, id: string) =>
	(
		await ordersPublicRoutes["orders/by-draft"].handler(
			route(`orders/by-draft?id=${id}`, undefined, "GET"),
			ctx,
		)
	).json();
async function webhook(ctx: PluginContext, reference: string) {
	const raw = new TextEncoder().encode(
		JSON.stringify({ event: "charge.success", data: { reference } }, null, 2),
	);
	return webhookRoutes["checkout/paystack-webhook"].handler(
		route("checkout/paystack-webhook", raw, "POST", { "x-paystack-signature": await sign(raw) }),
		ctx,
	) as Promise<Response>;
}

describe("Paystack test orchestration — native UPSERT/CAS semantics, fake HTTP only", () => {
	it("clears the purchased cart after repricing without clearing a newer cart", async () => {
		const first = setup();
		const paid = await session(first.ctx);
		expect((await poll(first.ctx, paid.orderDraftId)).status).toBe("ready");
		expect(await first.ctx.kv.get(cartKey("session"))).toBeNull();
		const changed = setup();
		const checkout = await session(changed.ctx);
		await changed.ctx.kv.set(cartKey("session"), {
			...changed.cart,
			items: [{ ...changed.cart.items[0], quantity: 2 }],
		});
		expect((await poll(changed.ctx, checkout.orderDraftId)).status).toBe("ready");
		expect((await changed.ctx.kv.get<CartState>(cartKey("session")))?.items[0]?.quantity).toBe(2);
	});
	it("atomically reuses a single session snapshot, reservation and initialized URL under concurrent and lost-browser-response retries", async () => {
		const h = setup();
		h.product.stock_quantity = 1;
		const [a, b] = await Promise.all([session(h.ctx), session(h.ctx)]);
		expect(a).toEqual(b);
		expect(await session(h.ctx)).toEqual(a);
		expect(h.storage.payment_attempts.rows.size).toBe(1);
		expect(h.calls.filter((c) => c.endsWith("/initialize")).length).toBe(1);
		expect(a.total.amount).toBe(2000);
		expect((await getInventoryReservation(h.ctx, a.orderDraftId))?.status).toBe("reserved");
	});
	it("keeps an uncertain provider initialization durable and never sends a second initialize", async () => {
		const h = setup();
		h.lose();
		const first = await create(h.ctx);
		expect(first.status).toBe(409);
		const body = await first.json();
		expect(body.code).toBe("initialization_uncertain");
		const retry = await create(h.ctx);
		expect(retry.status).toBe(409);
		expect((await retry.json()).orderDraftId).toBe(body.orderDraftId);
		expect(h.calls.length).toBe(1);
		expect(h.storage.payment_attempts.rows.size).toBe(1);
		expect((await getInventoryReservation(h.ctx, body.orderDraftId))?.status).toBe("reserved");
		expect((await poll(h.ctx, body.orderDraftId)).status).toBe("ready");
	});
	it("recovers when the initialized URL write response is lost", async () => {
		const h = setup();
		let once = true;
		h.storage.payment_attempts.afterWrite = (_id, a) => {
			if (a.phase === "initialized" && once) {
				once = false;
				throw Error("lost storage response");
			}
		};
		expect((await create(h.ctx)).status).toBe(409);
		const s = await session(h.ctx);
		expect(s.url).toBe("https://checkout.paystack.com/test");
		expect(h.calls.length).toBe(1);
	});
	it("overlapping webhook/return finalizes once, consumes inventory and queues one durable preview; settled reads do not verify or rewrite merchant decisions", async () => {
		const h = setup();
		const s = await session(h.ctx);
		const [a, b] = await Promise.all([poll(h.ctx, s.orderDraftId), webhook(h.ctx, s.reference)]);
		expect(a.status).toBe("ready");
		expect(b.status).toBe(200);
		const id = `test_${s.orderDraftId}`;
		expect(h.storage.orders.rows.size).toBe(1);
		expect(h.storage.order_items.rows.size).toBe(1);
		expect((await getInventoryReservation(h.ctx, s.orderDraftId))?.status).toBe("consumed");
		expect(h.kv.rows.get(`receipt-preview:${id}`)).toMatchObject({
			testMode: true,
			delivery: "disabled",
			status: "preview_only",
		});
		expect(h.storage.orders.rows.get(id)).toMatchObject({
			status: "on-hold",
			paymentStatus: "paid",
			paymentProvider: "paystack-test",
			metadata: { testMode: true, inventoryStatus: "consumed" },
		});
		await h.storage.orders.put(id, { ...h.storage.orders.rows.get(id), status: "cancelled" });
		const writes = Object.values(h.storage).reduce((n, s) => n + s.writes, 0);
		const calls = h.calls.length;
		expect((await poll(h.ctx, s.orderDraftId)).order.status).toBe("cancelled");
		expect((await webhook(h.ctx, s.reference)).status).toBe(200);
		expect(h.calls.length).toBe(calls);
		expect(Object.values(h.storage).reduce((n, s) => n + s.writes, 0)).toBe(writes);
	});
	for (const point of [
		"payments",
		"customers",
		"orders",
		"order_items",
		"outbox",
		"marker",
	] as const) {
		it(`recovers partial finalization at ${point}, including overlapping deliveries`, async () => {
			const h = setup();
			const s = await session(h.ctx);
			let fail = true;
			const store =
				point === "outbox" ? h.kv : point === "marker" ? h.storage.payments : h.storage[point];
			store.beforeWrite = (id, data) => {
				if (
					fail &&
					(point !== "outbox" || id.startsWith("receipt-preview:")) &&
					(point !== "marker" || data.status === "finalized_test")
				)
					throw Error("injected write failure");
			};
			expect((await poll(h.ctx, s.orderDraftId)).status).toBe("pending");
			expect([...h.storage.payments.rows.values()][0]?.status).not.toBe("finalized_test");
			const order = [...h.storage.orders.rows.values()][0];
			if (order) await h.storage.orders.put(order.id, { ...order, status: "cancelled" });
			fail = false;
			const calls = h.calls.length;
			const [returned, delivered] = await Promise.all([
				poll(h.ctx, s.orderDraftId),
				webhook(h.ctx, s.reference),
			]);
			expect(returned.status).toBe("ready");
			expect(delivered.status).toBe(200);
			if (order) expect(returned.order.status).toBe("cancelled");
			expect(h.calls.length).toBe(calls); // success was durably verified before effects
			expect(h.storage.orders.rows.size).toBe(1);
			expect(h.storage.order_items.rows.size).toBe(1);
			expect((await getInventoryReservation(h.ctx, s.orderDraftId))?.status).toBe("consumed");
		});
	}
	for (const afterCommit of [false, true]) {
		it(`recovers an inventory consume ${afterCommit ? "lost response" : "write failure"} without finalizing early`, async () => {
			const h = setup();
			const s = await session(h.ctx);
			let once = true;
			const hook = (id: string, data: any) => {
				if (
					once &&
					id === "state:inventory:projection:v1" &&
					data.reservations[s.orderDraftId]?.status === "consumed"
				) {
					once = false;
					throw Error("inventory storage fault");
				}
			};
			if (afterCommit) h.kv.afterWrite = hook;
			else h.kv.beforeWrite = hook;
			expect((await poll(h.ctx, s.orderDraftId)).status).toBe("pending");
			expect(h.storage.payments.rows.get(`test_${s.orderDraftId}`).status).toBe("verified_test");
			expect((await poll(h.ctx, s.orderDraftId)).status).toBe("ready");
			expect((await getInventoryReservation(h.ctx, s.orderDraftId))?.status).toBe("consumed");
			expect(
				h.kv.rows.get("state:inventory:projection:v1").buckets["product:product"].available,
			).toBe(19);
		});
	}
	it("keeps a failed release recoverable before allowing another identical checkout", async () => {
		const h = setup();
		const s = await session(h.ctx);
		h.setVerified({ ...h.verified(), status: "failed" });
		let once = true;
		h.kv.beforeWrite = (id, data) => {
			if (
				once &&
				id === "state:inventory:projection:v1" &&
				data.reservations[s.orderDraftId]?.status === "released"
			) {
				once = false;
				throw Error("release failed");
			}
		};
		expect((await poll(h.ctx, s.orderDraftId)).status).toBe("pending");
		expect((await create(h.ctx)).status).toBe(409);
		expect(h.calls.filter((c) => c.endsWith("/initialize")).length).toBe(1);
		expect((await poll(h.ctx, s.orderDraftId)).status).toBe("failed");
		expect((await session(h.ctx)).reference).not.toBe(s.reference);
	});
	it("requires CAS and refuses test refunds without any provider call", async () => {
		const h = setup();
		const s = await session(h.ctx);
		await poll(h.ctx, s.orderDraftId);
		const count = h.calls.length;
		await expect(
			refundOrder(h.ctx, {
				orderId: `test_${s.orderDraftId}`,
				amount: money("ZAR", 1),
				client: { secretKey: "sk_test_unused" },
				idempotencyKey: "refund",
			}),
		).rejects.toThrow("refunds are disabled");
		expect(h.calls.length).toBe(count);
		const missing = setup();
		(missing.ctx.kv as any).compareAndSet = undefined;
		expect((await create(missing.ctx)).status).toBe(503);
		expect(missing.calls.length).toBe(0);
	});
	it("allows only loopback HTTP callbacks for local test-mode browser integration", async () => {
		const h = setup();
		h.ctx.site.url = "http://127.0.0.1:43219";
		expect((await create(h.ctx)).status).toBe(200);
		await expect(
			initialize(h.ctx, key, {
				orderDraftId: "draft",
				cart: h.cart,
				callbackUrl: "http://localhost.evil.test:43219/return",
			}),
		).rejects.toThrow("Invalid checkout callback URL");
	});
	it("does not acknowledge a signed webhook whose finalization failed", async () => {
		const h = setup();
		const s = await session(h.ctx);
		h.storage.order_items.beforeWrite = () => {
			throw Error("storage down");
		};
		await expect(webhook(h.ctx, s.reference)).rejects.toThrow("storage down");
		h.storage.order_items.beforeWrite = undefined;
		expect((await webhook(h.ctx, s.reference)).status).toBe(200);
	});
	for (const status of ["failed", "abandoned"]) {
		it(`exposes terminal ${status}, releases inventory, allows a fresh retry and holds a late success for review`, async () => {
			const h = setup();
			const s = await session(h.ctx);
			const success = h.verified();
			h.setVerified({ ...success, status });
			expect((await poll(h.ctx, s.orderDraftId)).status).toBe("failed");
			expect((await getInventoryReservation(h.ctx, s.orderDraftId))?.status).toBe("released");
			const next = await session(h.ctx);
			expect(next.reference).not.toBe(s.reference);
			h.setVerified(success);
			const late = await poll(h.ctx, s.orderDraftId);
			expect(late.status).toBe("ready");
			expect(late.manualReview).toBe(true);
			expect(late.order.metadata.inventoryStatus).toBe("manual_review");
			expect(late.order.status).toBe("on-hold");
		});
	}
	it("leaves pending reserved, fails unknown/reversed closed, and retries transport failures", async () => {
		const h = setup();
		const s = await session(h.ctx);
		const success = h.verified();
		h.setVerified({ ...success, status: "pending" });
		expect((await poll(h.ctx, s.orderDraftId)).status).toBe("pending");
		expect((await getInventoryReservation(h.ctx, s.orderDraftId))?.status).toBe("reserved");
		for (const status of ["reversed", "surprise"]) {
			h.setVerified({ ...success, status });
			expect((await poll(h.ctx, s.orderDraftId)).status).toBe("manual_review");
		}
		expect(h.storage.orders.rows.size).toBe(0);
		h.fail(true);
		expect((await poll(h.ctx, s.orderDraftId)).status).toBe("pending");
		h.fail(false);
		h.setVerified(success);
		expect((await poll(h.ctx, s.orderDraftId)).status).toBe("ready");
	});
	for (const tamper of [
		{ domain: "live" },
		{ amount: 1 },
		{ currency: "USD" },
		{ reference: "other" },
		{ metadata: {} },
		{ customer: { email: "other@example.test" } },
	]) {
		it(`rejects verification tamper ${JSON.stringify(tamper)}`, async () => {
			const h = setup();
			const s = await session(h.ctx);
			h.setVerified({ ...h.verified(), ...tamper });
			expect((await poll(h.ctx, s.orderDraftId)).status).toBe("manual_review");
			expect(h.storage.orders.rows.size).toBe(0);
		});
	}
	for (const missing of [false, true]) {
		it(`finalizes ${missing ? "missing" : "expired"} reservation explicitly on manual review`, async () => {
			const h = setup();
			const s = await session(h.ctx);
			const projection = h.kv.rows.get("state:inventory:projection:v1");
			if (missing) delete projection.reservations[s.orderDraftId];
			else projection.reservations[s.orderDraftId].expiresAt = "2000-01-01";
			const result = await poll(h.ctx, s.orderDraftId);
			expect(result.status).toBe("ready");
			expect(result.manualReview).toBe(true);
			expect(h.storage.payments.rows.get(`test_${s.orderDraftId}`).inventoryStatus).toBe(
				"manual_review",
			);
		});
	}
	it("rejects live keys, HTTP callbacks, untrusted checkout URLs and invalid capabilities before unsafe work", async () => {
		const h = setup();
		await expect(
			initialize(h.ctx, "sk_live_fake", {
				orderDraftId: "draft",
				cart: h.cart,
				callbackUrl: "https://shop.test/return",
			}),
		).rejects.toThrow("live mode disabled");
		await expect(
			initialize(h.ctx, key, {
				orderDraftId: "draft",
				cart: h.cart,
				callbackUrl: "http://shop.test/return",
			}),
		).rejects.toThrow("Invalid checkout callback URL");
		expect(h.calls.length).toBe(0);
		h.ctx.http!.fetch = async () =>
			Response.json({
				status: true,
				data: {
					reference: "dc_draft",
					access_code: "abc",
					authorization_url: "https://evil.example/checkout",
				},
			});
		await expect(
			initialize(h.ctx, key, {
				orderDraftId: "draft",
				cart: h.cart,
				callbackUrl: "https://shop.test/return",
			}),
		).rejects.toThrow("Invalid Paystack checkout response");
		const result = await ordersPublicRoutes["orders/by-draft"].handler(
			route("orders/by-draft?id=guess", undefined, "GET"),
			h.ctx,
		);
		expect(result.status).toBe(400);
	});
	it("requires signatures over exact bytes", async () => {
		const h = setup();
		const s = await session(h.ctx);
		const raw = new TextEncoder().encode(
			JSON.stringify({ event: "charge.success", data: { reference: s.reference } }),
		);
		const result = (await webhookRoutes["checkout/paystack-webhook"].handler(
			route("checkout/paystack-webhook", raw, "POST", { "x-paystack-signature": "0".repeat(128) }),
			h.ctx,
		)) as Response;
		expect(result.status).toBe(400);
		expect(h.storage.orders.rows.size).toBe(0);
	});
});

describe("authoritative shipping, tax and backend field schemas", () => {
	it("prices current flat shipping and flat shipping-inclusive tax", async () => {
		const h = setup(true);
		h.kv.rows.set("settings:flatTaxRatePercent", 15);
		h.kv.rows.set("settings:taxAppliesToShipping", true);
		expect((await session(h.ctx)).total.amount).toBe(2875);
	});
	for (const change of [
		"stale",
		"disabled",
		"destination",
		"table",
		"negative",
		"currency",
		"minimum",
		"classes",
		"coupon",
	]) {
		it(`rejects ${change} shipping before initialize`, async () => {
			const h = setup(true);
			const method = h.storage.shipping_methods.rows.get("flat");
			if (change === "stale") method.config.amount.amount = 800;
			if (change === "disabled") method.enabled = false;
			if (change === "destination") h.cart.shippingAddress = { ...address, country: "US" };
			if (change === "table") method.config.type = method.type = "weight_based";
			if (change === "negative") method.config.amount.amount = -1;
			if (change === "currency") method.config.amount.currency = "USD";
			if (change === "minimum") {
				method.type = "free_shipping";
				method.config = { type: "free_shipping", minimumAmount: money("ZAR", 999999) };
			}
			if (change === "classes") method.config.shippingClassRates = { heavy: money("ZAR", 999) };
			if (change === "coupon") {
				method.type = "free_shipping";
				method.config = { type: "free_shipping", requiresCoupon: true };
			}
			expect((await create(h.ctx)).status).toBeGreaterThanOrEqual(400);
			expect(h.calls.length).toBe(0);
		});
	}
	for (const value of [-1, 101, "15", NaN]) {
		it(`rejects invalid authoritative tax ${value}`, async () => {
			const h = setup();
			h.kv.rows.set("settings:flatTaxRatePercent", value);
			expect((await create(h.ctx)).status).toBe(503);
			expect(h.calls.length).toBe(0);
		});
	}
	for (const quantity of [-1, 0, 1.1, 1001, Number.MAX_SAFE_INTEGER]) {
		it(`rejects quantity ${quantity}`, async () => {
			const h = setup();
			h.cart.items[0]!.quantity = quantity;
			expect((await create(h.ctx)).status).toBe(409);
			expect(h.calls.length).toBe(0);
		});
	}
	it("rejects client totals, malformed contact/addresses and negative catalogue prices", async () => {
		const h = setup();
		for (const body of [{ amount: 1 }, { total: -1 }, { customerEmail: 42 }, { notes: {} }, []])
			expect((await create(h.ctx, body)).status).toBe(400);
		for (const body of [
			{ email: 42 },
			{ billingAddress: { ...address, city: [] } },
			{ shippingAddress: "ZA" },
			{ shippingAddress: { ...address, total: 1 } },
			{ notes: [] },
			null,
		]) {
			expect(
				(await cartRoutes["cart/contact"].handler(route("cart/contact", body), h.ctx)).status,
			).toBe(400);
		}
		expect(
			(
				await cartRoutes["cart/shipping-location"].handler(
					route("cart/shipping-location", { country: 1, postalCode: [] }),
					h.ctx,
				)
			).status,
		).toBe(400);
		expect(
			(
				await cartRoutes["cart/shipping-address"].handler(
					route("cart/shipping-address", { address: [] }),
					h.ctx,
				)
			).status,
		).toBe(400);
		h.product.prices.ZAR.amount = -1;
		expect((await create(h.ctx)).status).toBeGreaterThanOrEqual(400);
		expect(h.calls.length).toBe(0);
	});
	it("rejects unsupported authoritative product semantics, coupons and oversized carts", async () => {
		for (const fields of [
			{ type: "subscription" },
			{ vendor_id: "vendor" },
			{ tax_class: "zero-rate" },
			{ manage_stock: false },
		]) {
			const h = setup();
			Object.assign(h.product, fields);
			expect((await create(h.ctx)).status).toBeGreaterThanOrEqual(400);
			expect(h.calls.length).toBe(0);
		}
		const coupons = setup();
		coupons.cart.coupons = [{ code: "FREE", discountAmount: money("ZAR", 1) }] as any;
		expect((await create(coupons.ctx)).status).toBe(501);
		expect(coupons.calls.length).toBe(0);
		const oversized = setup();
		oversized.cart.items = Array.from({ length: 101 }, (_, i) => ({
			...oversized.cart.items[0]!,
			lineId: `line${i}`,
		}));
		expect((await create(oversized.ctx)).status).toBe(409);
		expect(oversized.calls.length).toBe(0);
	});
	it("accepts qualifying free shipping and rejects unsupported checkout settings/features", async () => {
		const h = setup(true);
		const method = h.storage.shipping_methods.rows.get("flat");
		method.type = "free_shipping";
		method.config = { type: "free_shipping", minimumAmount: money("ZAR", 1000) };
		h.cart.shippingMethod!.amount.amount = 0;
		expect((await session(h.ctx)).total.amount).toBe(2000);
		for (const mode of ["table", "stripe_tax", "typo"]) {
			const invalid = setup();
			invalid.kv.rows.set("settings:taxMode", mode);
			expect((await create(invalid.ctx)).status).toBe(501);
			expect(invalid.calls.length).toBe(0);
		}
		for (const provider of ["paystack-live", "paystack-mock", "", false]) {
			const invalid = setup();
			invalid.kv.rows.set("settings:paymentProvider", provider);
			expect((await create(invalid.ctx)).status).toBe(503);
			expect(invalid.calls.length).toBe(0);
		}
		expect(validateSettingsKey("paystackSecretKey", "sk_live_FAKE").ok).toBe(false);
		expect(validateSettingsKey("paystackSecretKey", key).ok).toBe(true);
		expect(validateSettingsKey("paymentProvider", "paystack-mock").ok).toBe(false);
		expect(validateSettingsKey("flatTaxRatePercent", -1).ok).toBe(false);
	});
	it("cart/contact destination changes cannot keep a stale rate at payment time", async () => {
		const h = setup(true);
		expect(
			(
				await cartRoutes["cart/contact"].handler(
					route("cart/contact", { shippingAddress: { ...address, country: "US" } }),
					h.ctx,
				)
			).status,
		).toBe(200);
		expect((await create(h.ctx)).status).toBe(409);
		expect(h.calls.length).toBe(0);
	});
});
