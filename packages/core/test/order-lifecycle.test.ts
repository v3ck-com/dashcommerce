import { describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { reserveCouponClaims } from "../src/coupons/reservations";
import { ordersPublicRoutes } from "../src/routes/orders-public";
import {
	getInventoryReservation,
	readInventoryAvailability,
	reserveInventory,
} from "../src/inventory";
import { money } from "../src/money";
import { createOrderFromPaymentIntent } from "../src/orders/create";
import { finalizePayment } from "../src/orders/finalize";
import { dispatchCommerceNotification, isTestOrder } from "../src/orders/outbox";
import { finalizePaystack } from "../src/orders/paystack";
import { reconcileRefund, recordRefundFromWebhook, refundOrder } from "../src/orders/refund";
import { DASHCOMMERCE_STORAGE } from "../src/storage-collections";
import type { CartState, Order } from "../src/types";
import { conditionalStore } from "./helpers/conditional-store";

const address = {
	firstName: "Synthetic",
	lastName: "Buyer",
	line1: "1 Test",
	city: "Cape Town",
	region: "WC",
	postalCode: "8000",
	country: "ZA",
};
function harness() {
	const kv = conditionalStore();
	const storage = Object.fromEntries(
		[
			"payments",
			"payment_attempts",
			"orders",
			"order_items",
			"customers",
			"coupons",
			"coupon_usage",
			"download_grants",
			"commerce_outbox",
			"refunds",
			"product_variants",
		].map((name) => [
			name,
			conditionalStore(
				name === "refunds"
					? ["stripeRefundId", "providerRefundKey", "requestId"]
					: name === "orders"
						? ["paymentReference", "orderNumber"]
						: name === "payments"
							? ["paymentKey"]
							: [],
			),
		]),
	);
	const cart: CartState = {
		sessionId: "buyer",
		currency: "ZAR",
		customerEmail: "synthetic@example.test",
		billingAddress: address,
		shippingAddress: address,
		items: [
			{
				lineId: "line",
				productId: "product",
				quantity: 2,
				unitPrice: money("ZAR", 500),
				lineSubtotal: money("ZAR", 1000),
				title: "Synthetic product",
				isDigital: false,
			},
		],
		coupons: [{ code: "SAVE", discountAmount: money("ZAR", 100) }],
		taxLines: [],
		subtotal: money("ZAR", 1000),
		discountTotal: money("ZAR", 100),
		shippingTotal: money("ZAR", 0),
		taxTotal: money("ZAR", 0),
		total: money("ZAR", 900),
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
	};
	storage.coupons!.rows.set("coupon", { id: "coupon", code: "SAVE", usageCount: 0 });
	let sent = 0;
	let transport: (url: string, init: RequestInit) => Promise<Response> = async () => {
		throw new Error("No real HTTP allowed");
	};
	const ctx = {
		storage,
		kv: { ...kv, set: kv.put },
		site: { name: "Synthetic", url: "https://example.test" },
		log: { info() {}, warn() {}, error() {}, debug() {} },
		content: {
			async get() {
				return {
					status: "published",
					data: {
						title: "Synthetic",
						type: "simple",
						manage_stock: true,
						stock_quantity: 50,
						stock_status: "instock",
						is_downloadable: true,
						downloadable_files: [{ name: "Test PDF", url: "https://example.test/test.pdf" }],
					},
				};
			},
		},
		email: {
			async send() {
				sent++;
			},
		},
		http: { fetch: (url: string, init: RequestInit) => transport(url, init) },
	} as unknown as PluginContext;
	kv.rows.set("settings:paystackTestSecretKey", "sk_test_SYNTHETIC");
	kv.rows.set("settings:paystackLiveSecretKey", "sk_live_SYNTHETIC");
	return {
		ctx,
		kv,
		storage,
		cart,
		sent: () => sent,
		transport: (fn: typeof transport) => {
			transport = fn;
		},
	};
}
const draft = "a".repeat(32);
async function paid(
	h: ReturnType<typeof harness>,
	provider: "stripe" | "paystack",
	mode: "test" | "live",
	id = draft,
) {
	await reserveInventory(h.ctx, id, [{ productId: "product", quantity: 2 }], { mode });
	if (provider === "stripe")
		return createOrderFromPaymentIntent(h.ctx, {
			orderDraftId: id,
			cartSnapshot: h.cart,
			paymentIntent: {
				id: `pi_${id}`,
				status: "succeeded",
				amount: 900,
				currency: "zar",
				livemode: mode === "live",
			} as any,
		});
	const attempt = {
		id,
		reference: `dc_${id}`,
		orderDraftId: id,
		provider: "paystack",
		mode,
		outcome: "verified",
		phase: "initialized",
		cart: h.cart,
		inventoryLines: [{ productId: "product", quantity: 2 }],
		amount: 900,
		currency: "ZAR",
		email: h.cart.customerEmail,
		createdAt: "2026-01-01",
	};
	await h.storage.payment_attempts!.put(id, attempt);
	return finalizePaystack(h.ctx, attempt as any);
}
async function personalisedOrder(h: ReturnType<typeof harness>) {
	const line = h.cart.items[0]!;
	h.cart.items = ["Alice", "Bob"].map((name, index) => ({
		...line,
		lineId: `personalised-${index}`,
		quantity: 1,
		lineSubtotal: money("ZAR", 500),
		customisation: { name },
	}));
	const { order } = await paid(h, "paystack", "test");
	const items = [...h.storage.order_items!.rows.values()];
	const input = (key: string, item = items[0]) => ({
		orderId: order.id,
		amount: money("ZAR", 300),
		idempotencyKey: key,
		restock: true,
		lineItemRefunds: [{ orderItemId: item.id, quantity: 1, amount: money("ZAR", 300) }],
	});
	return { order, items, input };
}
function paystackRefund(order: Order, amount: number, id: number, status = "processed") {
	return {
		status: true,
		data: {
			id,
			amount,
			currency: "ZAR",
			status,
			domain: order.paymentMode,
			transaction: {
				reference: order.paymentReference!.split(":").at(-1),
				domain: order.paymentMode,
			},
		},
	};
}
describe("shared provider-neutral durable lifecycle", () => {
	it("late paid coupons are visibly held without grants or live coupon consumption", async () => {
		const h = harness();
		await h.storage.coupons!.put("coupon", {
			...(await h.storage.coupons!.get("coupon")),
			usageLimit: 1,
		});
		await reserveCouponClaims(h.ctx, draft, h.cart, "live");
		const coupon = await h.storage.coupons!.get("coupon");
		coupon._quotaClaims[draft].expiresAt = 0;
		await h.storage.coupons!.put("coupon", coupon);
		const { order } = await paid(h, "paystack", "live");
		expect(order.paymentStatus).toBe("paid");
		expect(order.status).toBe("on-hold");
		expect(order.metadata?.couponStatus).toBe("manual_review");
		expect((await h.storage.coupons!.get("coupon")).usageCount).toBe(0);
		expect(h.storage.download_grants!.rows.size).toBe(0);
		const response = (await ordersPublicRoutes["orders/by-draft"]!.handler(
			{ request: new Request(`https://shop.test/orders/by-draft?id=${draft}`) } as RouteContext,
			h.ctx,
		)) as Response;
		expect((await response.json()).manualReview).toBe(true);
	});
	it("indexed receipts survive the recent-order window and unfinished journals block refunds", async () => {
		const h = harness();
		for (let i = 0; i < 205; i++)
			await h.storage.orders!.put(`old${i}`, {
				id: `old${i}`,
				metadata: { orderDraftId: `old${i}` },
			});
		const { order } = await paid(h, "stripe", "test");
		const lookup = () =>
			ordersPublicRoutes["orders/by-draft"]!.handler(
				{ request: new Request(`https://shop.test/orders/by-draft?id=${draft}`) } as RouteContext,
				h.ctx,
			) as Promise<Response>;
		expect((await (await lookup()).json()).order.id).toBe(order.id);
		await h.storage.payments!.put(order.id, {
			...(await h.storage.payments!.get(order.id)),
			status: "verified",
		});
		expect((await (await lookup()).json()).status).toBe("pending");
		await expect(
			refundOrder(h.ctx, {
				orderId: order.id,
				amount: money("ZAR", 100),
				idempotencyKey: "unfinished-payment",
				reason: "test",
				restock: false,
			}),
		).rejects.toThrow(/finalization/i);
		expect(h.storage.refunds!.rows.size).toBe(0);
	});
	it("Stripe replay cannot contradict the persisted payment environment", async () => {
		const h = harness();
		await paid(h, "stripe", "test");
		await expect(
			createOrderFromPaymentIntent(h.ctx, {
				orderDraftId: draft,
				cartSnapshot: h.cart,
				paymentIntent: {
					id: `pi_${draft}`,
					status: "succeeded",
					amount: 900,
					currency: "zar",
					livemode: true,
				} as any,
			}),
		).rejects.toThrow(/environment/);
	});
	for (const provider of ["stripe", "paystack"] as const) {
		it(`${provider} reaches same live customer/coupon/inventory/outbox effects under parallel replay`, async () => {
			const h = harness();
			await paid(h, provider, "live");
			await Promise.all(Array.from({ length: 5 }, () => paid(h, provider, "live")));
			expect(h.storage.orders!.rows.size).toBe(1);
			expect(h.storage.order_items!.rows.size).toBe(1);
			const order = [...h.storage.orders!.rows.values()][0];
			expect(order.status).toBe("processing");
			expect(order.paymentProvider).toBe(provider);
			if (provider === "paystack") expect(order.stripePaymentIntentId).toBeUndefined();
			const customer = [...h.storage.customers!.rows.values()][0];
			expect(customer.ordersCount).toBe(1);
			expect(customer.totalSpent.ZAR).toBe(900);
			expect(h.storage.coupons!.rows.get("coupon").usageCount).toBe(1);
			expect(h.storage.coupon_usage!.rows.size).toBe(1);
			expect((await getInventoryReservation(h.ctx, draft, "live"))?.status).toBe("consumed");
			expect([...h.storage.commerce_outbox!.rows.values()][0].status).toBe("pending");
			expect(h.sent()).toBe(0);
		});
	}
	it("one provider payment cannot account a second draft, nor can replay change its money snapshot", async () => {
		const h = harness();
		const { order } = await paid(h, "stripe", "live");
		const input = {
			provider: "stripe" as const,
			mode: "live" as const,
			reference: order.stripePaymentIntentId!,
			orderDraftId: "different-draft",
			cartSnapshot: h.cart,
			stripe: { paymentIntentId: order.stripePaymentIntentId! },
		};
		expect(DASHCOMMERCE_STORAGE.payments!.uniqueIndexes).toContain("paymentKey");
		await expect(finalizePayment(h.ctx, input)).rejects.toThrow("unique constraint");
		await expect(
			finalizePayment(h.ctx, {
				...input,
				orderDraftId: draft,
				cartSnapshot: { ...h.cart, total: money("ZAR", 901) },
			}),
		).rejects.toThrow("claim conflict");
		expect(h.storage.orders!.rows.size).toBe(1);
		expect([...h.storage.customers!.rows.values()][0].totalSpent.ZAR).toBe(900);
		expect(h.storage.coupons!.rows.get("coupon").usageCount).toBe(1);
	});
	it("different concurrent orders share CAS customer and coupon counters without lost increments", async () => {
		const h = harness();
		await Promise.all([paid(h, "stripe", "live"), paid(h, "paystack", "live", "b".repeat(32))]);
		expect([...h.storage.customers!.rows.values()][0].ordersCount).toBe(2);
		expect([...h.storage.customers!.rows.values()][0].totalSpent.ZAR).toBe(1800);
		expect(h.storage.coupons!.rows.get("coupon").usageCount).toBe(2);
	});
	it("digital entitlement conditional insert recovers a committed grant crash exactly once", async () => {
		const h = harness();
		h.cart.items[0]!.isDigital = true;
		let crash = true;
		h.storage.download_grants!.afterWrite = () => {
			if (crash) {
				crash = false;
				throw new Error("grant response lost");
			}
		};
		await expect(paid(h, "paystack", "live")).rejects.toThrow("grant response lost");
		await paid(h, "paystack", "live");
		expect(h.storage.download_grants!.rows.size).toBe(1);
	});
	it("test orders are normal processing records, but never live accounting, grants or delivery", async () => {
		const h = harness();
		h.cart.items[0]!.isDigital = true;
		const { order } = await paid(h, "paystack", "test");
		expect(order.status).toBe("processing");
		expect(order.metadata?.fulfillment).toBe("suppressed-test");
		expect([...h.storage.customers!.rows.values()][0].ordersCount).toBe(0);
		expect(h.storage.coupons!.rows.get("coupon").usageCount).toBe(0);
		expect(h.storage.download_grants!.rows.size).toBe(0);
		const notification = [...h.storage.commerce_outbox!.rows.values()][0];
		expect(notification.subject).toContain("TEST ONLY");
		expect(notification.text).toContain("Nothing will ship");
		await h.ctx.kv.set("settings:receiptEmailEnabled", true);
		await dispatchCommerceNotification(h.ctx, notification.id, { allowDelivery: true });
		expect(h.sent()).toBe(0);
	});
	for (const collection of ["order_items", "customers", "coupons", "commerce_outbox", "payments"]) {
		it(`recovers crash after committed ${collection} effect without double accounting or resetting merchant decision`, async () => {
			const h = harness();
			let crashed = false;
			h.storage[collection]!.afterWrite = (_id, value) => {
				const eligible =
					collection === "customers"
						? value.ordersCount === 1
						: collection === "coupons"
							? value.usageCount === 1
							: collection === "payments"
								? value.status === "finalized"
								: true;
				if (!crashed && eligible) {
					crashed = true;
					throw new Error("simulated process death");
				}
			};
			await expect(paid(h, "paystack", "live")).rejects.toThrow("simulated process death");
			const existing = [...h.storage.orders!.rows.values()][0];
			await h.storage.orders!.put(existing.id, {
				...existing,
				status: "cancelled",
				customerNote: "Merchant decision",
			});
			const result = await paid(h, "paystack", "live");
			expect(result.order.status).toBe("cancelled");
			expect(result.order.customerNote).toBe("Merchant decision");
			expect([...h.storage.customers!.rows.values()][0].ordersCount).toBe(1);
			expect(h.storage.coupons!.rows.get("coupon").usageCount).toBe(1);
			expect(h.storage.commerce_outbox!.rows.size).toBe(1);
		});
	}
	it("missing reservation is genuine on-hold/manual-review rather than provider discrimination", async () => {
		const h = harness();
		const { order } = await finalizePayment(h.ctx, {
			provider: "stripe",
			mode: "live",
			reference: "pi_missing",
			orderDraftId: "missing",
			cartSnapshot: h.cart,
			stripe: { paymentIntentId: "pi_missing" },
		});
		expect(order.status).toBe("on-hold");
		expect(order.metadata?.inventoryStatus).toBe("manual_review");
	});
	it("native live receipt handoff is opt-in and concurrent dispatch claims once", async () => {
		const h = harness();
		const { order } = await paid(h, "stripe", "live");
		await dispatchCommerceNotification(h.ctx, `order:${order.id}`, { allowDelivery: true });
		expect(h.sent()).toBe(0);
		await h.ctx.kv.set("settings:receiptEmailEnabled", true);
		await Promise.all([
			dispatchCommerceNotification(h.ctx, `order:${order.id}`, { allowDelivery: true }),
			dispatchCommerceNotification(h.ctx, `order:${order.id}`, { allowDelivery: true }),
		]);
		expect(h.sent()).toBe(1);
	});
});
describe("durable provider-neutral refunds", () => {
	for (const outcome of ["pending", "processed", "uncertain"]) {
		it(`same personalised line concurrent refunds hold quantity for ${outcome}; at most one POST`, async () => {
			const h = harness();
			const { order, items, input } = await personalisedOrder(h);
			let posts = 0;
			h.transport(async (_url, init) => {
				expect(init.method).toBe("POST");
				posts++;
				if (outcome === "uncertain") throw new Error("provider response lost");
				return Response.json(paystackRefund(order, 300, 301, outcome));
			});
			await Promise.allSettled([
				refundOrder(h.ctx, input("first")),
				refundOrder(h.ctx, input("second")),
			]);
			expect(posts).toBe(1);
			const reservations = Object.values(
				h.storage.orders!.rows.get(order.id).refundReservations,
			) as any[];
			expect(reservations).toHaveLength(1);
			expect(reservations[0].restockQuantities).toEqual({ [items[0].id]: 1 });
			await expect(refundOrder(h.ctx, input("third"))).rejects.toThrow("restock quantity");
			expect(posts).toBe(1);
			if (outcome === "uncertain") {
				const winner = [...h.storage.refunds!.rows.values()].find(
					(r) => r.transportState === "uncertain",
				);
				expect((await refundOrder(h.ctx, input(winner.clientRequestId))).transportState).toBe(
					"uncertain",
				);
				h.transport(async (_url, init) => {
					expect(init.method).toBe("GET");
					return Response.json(paystackRefund(order, 300, 301));
				});
				await reconcileRefund(h.ctx, winner.id, "301");
				await refundOrder(h.ctx, input(winner.clientRequestId));
				expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
				expect(
					(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
						.effectiveStock,
				).toBe(49);
			}
		});
	}
	it("different personalised lines in the same bucket can concurrently restock", async () => {
		const h = harness();
		const { order, items, input } = await personalisedOrder(h);
		let posts = 0;
		h.transport(async () => Response.json(paystackRefund(order, 300, ++posts)));
		await Promise.all(items.map((item, index) => refundOrder(h.ctx, input(`line-${index}`, item))));
		expect(posts).toBe(2);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(600);
		expect(
			(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
				.effectiveStock,
		).toBe(50);
	});
	it("confirmed failure releases line budget and same failed ID never reacquires it", async () => {
		const h = harness();
		const { order, input } = await personalisedOrder(h);
		let posts = 0;
		h.transport(async () =>
			Response.json(paystackRefund(order, 300, ++posts, posts === 1 ? "failed" : "processed")),
		);
		expect((await refundOrder(h.ctx, input("failed"))).status).toBe("failed");
		await refundOrder(h.ctx, input("replacement"));
		expect((await refundOrder(h.ctx, input("failed"))).status).toBe("failed");
		expect(posts).toBe(2);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
		expect(
			(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
				.effectiveStock,
		).toBe(49);
	});
	it("pending-to-failed confirmation releases stock even after an accounting CAS response is lost", async () => {
		const h = harness();
		const { order, input } = await personalisedOrder(h);
		let posts = 0;
		h.transport(async (_url, init) => {
			if (init.method === "GET") return Response.json(paystackRefund(order, 300, 601, "failed"));
			posts++;
			return Response.json(
				paystackRefund(order, 300, posts === 1 ? 601 : 602, posts === 1 ? "pending" : "processed"),
			);
		});
		const first = await refundOrder(h.ctx, input("pending"));
		await expect(refundOrder(h.ctx, input("replacement"))).rejects.toThrow("restock quantity");
		let crash = true;
		h.storage.orders!.afterWrite = (_id, row) => {
			if (crash && row.refundReservations[first.id].status === "failed") {
				crash = false;
				throw new Error("failed accounting response lost");
			}
		};
		await expect(refundOrder(h.ctx, input("pending"))).rejects.toThrow(
			"failed accounting response lost",
		);
		expect((await refundOrder(h.ctx, input("pending"))).status).toBe("failed");
		// The previously rejected stable ID is recoverable; it has never POSTed.
		await refundOrder(h.ctx, input("replacement"));
		expect(posts).toBe(2);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
		expect(
			(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
				.effectiveStock,
		).toBe(49);
	});
	it("line allocations without restock consume no stock budget", async () => {
		const h = harness();
		const { order, input } = await personalisedOrder(h);
		let posts = 0;
		h.transport(async () => Response.json(paystackRefund(order, 300, ++posts)));
		const monetary = await refundOrder(h.ctx, { ...input("money-only"), restock: false });
		expect(
			h.storage.orders!.rows.get(order.id).refundReservations[monetary.id].restockQuantities,
		).toEqual({});
		await refundOrder(h.ctx, input("with-stock"));
		expect(posts).toBe(2);
		expect(
			(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
				.effectiveStock,
		).toBe(49);
	});
	it("legacy quantity-less journal hydrates from refund intent, never treats it as free units", async () => {
		const h = harness();
		const { order, items, input } = await personalisedOrder(h);
		let posts = 0;
		h.transport(async () => Response.json(paystackRefund(order, 300, ++posts)));
		const first = await refundOrder(h.ctx, input("legacy"));
		const row = await h.storage.orders!.get(order.id);
		delete row.refundReservations[first.id].restockQuantities;
		await h.storage.orders!.put(order.id, row);
		await expect(refundOrder(h.ctx, input("same-line"))).rejects.toThrow("restock quantity");
		await refundOrder(h.ctx, input("legacy"));
		expect(
			h.storage.orders!.rows.get(order.id).refundReservations[first.id].restockQuantities,
		).toEqual({ [items[0].id]: 1 });
		await refundOrder(h.ctx, input("other-line", items[1]));
		expect(posts).toBe(2);
	});
	for (const crashPoint of ["reservation", "provider-claim", "accounting", "restocked"]) {
		it(`same-ID restock retry recovers crash after committed ${crashPoint}`, async () => {
			const h = harness();
			const { order, input } = await personalisedOrder(h);
			let crashed = false;
			let posts = 0;
			const store = ["reservation", "accounting"].includes(crashPoint)
				? h.storage.orders!
				: h.storage.refunds!;
			store.afterWrite = (_id, row) => {
				const eligible =
					crashPoint === "reservation"
						? row.refundReservations && row.refundedTotal.amount === 0
						: crashPoint === "provider-claim"
							? row.providerRefundKey
							: crashPoint === "accounting"
								? row.refundedTotal.amount === 300
								: row.restocked;
				if (!crashed && eligible) {
					crashed = true;
					throw new Error("committed crash");
				}
			};
			h.transport(async () => Response.json(paystackRefund(order, 300, ++posts)));
			await expect(refundOrder(h.ctx, input("recover"))).rejects.toThrow("committed crash");
			expect(posts).toBe(crashPoint === "reservation" ? 0 : 1);
			await expect(refundOrder(h.ctx, input("blocked"))).rejects.toThrow("restock quantity");
			await refundOrder(h.ctx, input("recover"));
			await refundOrder(h.ctx, input("recover"));
			expect(posts).toBe(1);
			expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
			expect(
				(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
					.effectiveStock,
			).toBe(49);
		});
	}
	it("provider refund unique claim rejects duplicate identity before accounting/restock", async () => {
		// These are native SQL indexes, not a preflight query or a KV-only claim.
		expect(DASHCOMMERCE_STORAGE.refunds!.uniqueIndexes).toContain("providerRefundKey");
		expect(DASHCOMMERCE_STORAGE.refunds!.uniqueIndexes).toContain("stripeRefundId");
		const h = harness();
		const { order, items, input } = await personalisedOrder(h);
		h.transport(async () => Response.json(paystackRefund(order, 300, 501)));
		await refundOrder(h.ctx, input("first"));
		await expect(refundOrder(h.ctx, input("duplicate-provider", items[1]))).rejects.toThrow(
			"unique constraint",
		);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
		expect(
			(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
				.effectiveStock,
		).toBe(49);
		const pending = [...h.storage.refunds!.rows.values()].find(
			(r) => r.clientRequestId === "duplicate-provider",
		);
		expect(pending.transportState).toBe("uncertain");
		expect(h.storage.orders!.rows.get(order.id).refundReservations[pending.id].status).toBe(
			"pending",
		);
	});
	it("legacy test-mode export remains safe for native receipt suppression", async () => {
		expect(isTestOrder({ paymentProvider: "paystack-test" })).toBe(true);
		expect(isTestOrder({ paymentMode: "live", metadata: { testMode: true } })).toBe(true);
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		await h.ctx.kv.set("settings:receiptEmailEnabled", true);
		await dispatchCommerceNotification(h.ctx, `order:${order.id}`, { allowDelivery: true });
		expect(h.sent()).toBe(0);
	});
	it("Paystack partial pending is not accounted/restocked, GET confirmation is once; full remainder refunds", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		let calls = 0;
		h.transport(async (_url, init) => {
			calls++;
			return Response.json(
				paystackRefund(order, 300, 41, init.method === "POST" ? "pending" : "processed"),
			);
		});
		const input = { orderId: order.id, amount: money("ZAR", 300), idempotencyKey: "refund-one" };
		let refund = await refundOrder(h.ctx, input);
		expect(refund.status).toBe("pending");
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(0);
		refund = await refundOrder(h.ctx, input);
		expect(refund.status).toBe("succeeded");
		expect(refund.stripeRefundId).toBeUndefined();
		await refundOrder(h.ctx, input);
		expect(calls).toBe(2);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
		h.transport(async () => Response.json(paystackRefund(order, 600, 42)));
		await refundOrder(h.ctx, { ...input, amount: money("ZAR", 600), idempotencyKey: "refund-two" });
		expect(h.storage.orders!.rows.get(order.id).paymentStatus).toBe("refunded");
		expect(h.sent()).toBe(0);
	});
	it("only confirmed success restores explicit partial quantity; retries never double restock", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		const item = [...h.storage.order_items!.rows.values()][0];
		const input = {
			orderId: order.id,
			amount: money("ZAR", 300),
			idempotencyKey: "stock-request",
			restock: true,
			lineItemRefunds: [{ orderItemId: item.id, quantity: 1, amount: money("ZAR", 300) }],
		};
		h.transport(async (_url, init) =>
			Response.json(
				paystackRefund(order, 300, 91, init.method === "POST" ? "pending" : "processed"),
			),
		);
		await refundOrder(h.ctx, input);
		expect(
			(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
				.effectiveStock,
		).toBe(48);
		await refundOrder(h.ctx, input);
		await refundOrder(h.ctx, input);
		expect(
			(await readInventoryAvailability(h.ctx, { productId: "product", quantity: 1 }))
				.effectiveStock,
		).toBe(49);
	});
	it("confirmed failed request releases the monetary ceiling without accounting or stock effects", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		h.transport(async () => Response.json(paystackRefund(order, 900, 92, "failed")));
		const input = {
			orderId: order.id,
			amount: money("ZAR", 900),
			idempotencyKey: "failed-request",
		};
		const failed = await refundOrder(h.ctx, input);
		expect(failed.status).toBe("failed");
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(0);
		h.transport(async () => Response.json(paystackRefund(order, 900, 93)));
		await refundOrder(h.ctx, { ...input, idempotencyKey: "fresh-request" });
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(900);
	});
	it("same request racing submits exactly one provider POST", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		let posts = 0;
		h.transport(async () => {
			posts++;
			return Response.json(paystackRefund(order, 300, 99));
		});
		const input = { orderId: order.id, amount: money("ZAR", 300), idempotencyKey: "same-request" };
		await Promise.all([refundOrder(h.ctx, input), refundOrder(h.ctx, input)]);
		expect(posts).toBe(1);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
	});
	it("concurrent requests reserve ceiling before financial POST", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		let posts = 0;
		h.transport(async () => {
			posts++;
			return Response.json(paystackRefund(order, 600, posts, "pending"));
		});
		const results = await Promise.allSettled(
			["first", "second"].map((idempotencyKey) =>
				refundOrder(h.ctx, { orderId: order.id, amount: money("ZAR", 600), idempotencyKey }),
			),
		);
		expect(results.filter((r) => r.status === "rejected").length).toBe(1);
		expect(posts).toBe(1);
	});
	it("lost Paystack POST response stays uncertain, holds ceiling, recovers GET without resubmission", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		let posts = 0;
		h.transport(async (_url, init) => {
			if (init.method === "POST") {
				posts++;
				throw new Error("accepted but response lost");
			}
			return Response.json(paystackRefund(order, 900, 55));
		});
		const input = {
			orderId: order.id,
			amount: money("ZAR", 900),
			idempotencyKey: "uncertain-request",
		};
		await expect(refundOrder(h.ctx, input)).rejects.toThrow();
		const pending = await refundOrder(h.ctx, input);
		expect(pending.transportState).toBe("uncertain");
		expect(posts).toBe(1);
		await expect(
			refundOrder(h.ctx, { ...input, idempotencyKey: "different-request" }),
		).rejects.toThrow("remaining");
		await reconcileRefund(h.ctx, pending.id, "55");
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(900);
		expect(posts).toBe(1);
	});
	it("crash after accounting commit recovers without double refunds; changed request params rejected", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		let crash = true;
		let posts = 0;
		h.storage.orders!.afterWrite = (_id, row) => {
			if (crash && row.refundedTotal.amount === 300) {
				crash = false;
				throw new Error("crash after accounting");
			}
		};
		h.transport(async () => {
			posts++;
			return Response.json(paystackRefund(order, 300, 71));
		});
		const input = {
			orderId: order.id,
			amount: money("ZAR", 300),
			idempotencyKey: "recover-accounting",
		};
		await expect(refundOrder(h.ctx, input)).rejects.toThrow("crash");
		await refundOrder(h.ctx, input);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(300);
		expect(posts).toBe(1);
		await expect(refundOrder(h.ctx, { ...input, amount: money("ZAR", 301) })).rejects.toThrow(
			"different parameters",
		);
	});
	it("Stripe signature works and webhook echo is idempotent; Paystack never accepts Stripe event", async () => {
		const h = harness();
		const { order } = await paid(h, "stripe", "test");
		let response: any;
		h.transport(async (url, init) => {
			expect(url).toContain("api.stripe.com");
			const body = new URLSearchParams(String(init.body));
			response = {
				id: "re_synthetic",
				amount: 900,
				currency: "zar",
				status: "succeeded",
				payment_intent: order.stripePaymentIntentId,
				metadata: { refundRequestId: body.get("metadata[refundRequestId]") },
			};
			return Response.json(response);
		});
		const refund = await refundOrder(h.ctx, {
			orderId: order.id,
			amount: money("ZAR", 900),
			idempotencyKey: "stripe-request",
			client: { secretKey: "sk_test_SYNTHETIC" },
		});
		expect(refund.stripeRefundId).toBe("re_synthetic");
		await recordRefundFromWebhook(h.ctx, order, response);
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(900);
		const other = await paid(h, "paystack", "test", "b".repeat(32));
		await expect(recordRefundFromWebhook(h.ctx, other.order, response)).rejects.toThrow(
			"another provider",
		);
	});
	it("persisted mode wins over current settings and wrong reconciliation amount rejected", async () => {
		const h = harness();
		const { order } = await paid(h, "paystack", "test");
		await h.ctx.kv.set("settings:paystackMode", "live");
		h.transport(async (_url, init) => {
			expect((init.headers as any).Authorization).toBe("Bearer sk_test_SYNTHETIC");
			return Response.json(paystackRefund(order, 300, 80, "pending"));
		});
		const refund = await refundOrder(h.ctx, {
			orderId: order.id,
			amount: money("ZAR", 300),
			idempotencyKey: "mode-request",
		});
		h.transport(async () => Response.json(paystackRefund(order, 301, 80)));
		await expect(reconcileRefund(h.ctx, refund.id, "80")).rejects.toThrow("does not match");
		expect(h.storage.orders!.rows.get(order.id).refundedTotal.amount).toBe(0);
	});
});
