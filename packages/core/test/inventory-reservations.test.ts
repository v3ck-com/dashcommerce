import { describe, expect, it } from "bun:test";
import type { PluginContext } from "emdash";
import {
	createLock,
	deleteLock,
	getLock,
	newLock,
	releaseLock,
	sweepExpiredLocks,
} from "../src/cart/lock";
import {
	InventoryError,
	consumeInventoryReservation,
	finalizeOrderInventory,
	getInventoryReservation,
	readInventoryAvailability,
	reconcileInventory,
	releaseInventoryReservation,
	reserveInventory,
	resolveInventoryMode,
	restockOrderInventory,
	restoreOrderInventory,
	sumReservedInventory,
	validateInventoryLines,
} from "../src/inventory/reservations";

type Versioned = { value: unknown; revision: string };

function fixture(
	opts: {
		stock?: number;
		variants?: Array<
			Partial<{ id: string; productId: string; stockQuantity: number | null; isActive: boolean }>
		>;
	} = {},
) {
	const values = new Map<string, Versioned>();
	let revision = 0;
	const stock = opts.stock ?? 2;
	const variants = new Map(
		(opts.variants ?? []).map((v, index) => {
			const id = v.id ?? `v${index + 1}`;
			return [
				id,
				{
					id,
					productId: v.productId ?? "p1",
					sku: id,
					prices: {},
					stockQuantity: v.stockQuantity ?? stock,
					weightGrams: null,
					attributes: {},
					isActive: v.isActive ?? true,
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			];
		}),
	);
	const product = {
		id: "p1",
		status: "published",
		data: {
			title: "Widget",
			prices: { USD: { amount: 100 } },
			manage_stock: true,
			stock_quantity: stock,
			stock_status: "instock",
			backorders: "no",
		},
	};
	const ctx = {
		kv: {
			async get<T>(key: string) {
				return (values.get(key)?.value as T | undefined) ?? null;
			},
			async getVersioned<T>(key: string) {
				const found = values.get(key);
				return found
					? { value: structuredClone(found.value) as T, revision: found.revision }
					: null;
			},
			async compareAndSet(key: string, expected: string | null, value: unknown) {
				const found = values.get(key);
				if ((found?.revision ?? null) !== expected) return { applied: false as const };
				const next = { value: structuredClone(value), revision: String(++revision) };
				values.set(key, next);
				return { applied: true as const, revision: next.revision };
			},
			async compareAndDelete(key: string, expected: string) {
				if (values.get(key)?.revision !== expected) return { applied: false };
				values.delete(key);
				return { applied: true };
			},
			async set(key: string, value: unknown) {
				values.set(key, { value, revision: String(++revision) });
			},
			async delete(key: string) {
				return values.delete(key);
			},
			async list(prefix = "") {
				return [...values]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, entry]) => ({ key, value: entry.value }));
			},
		},
		content: {
			async get(_collection: string, id: string) {
				return id === "p1" ? structuredClone(product) : null;
			},
		},
		storage: {
			product_variants: {
				async get(id: string) {
					return structuredClone(variants.get(id) ?? null);
				},
				async query({
					where = {},
					limit = 100,
				}: { where?: Record<string, unknown>; limit?: number }) {
					return {
						items: [...variants]
							.filter(([, variant]) =>
								Object.entries(where).every(
									([key, value]) => variant[key as keyof typeof variant] === value,
								),
							)
							.slice(0, limit)
							.map(([id, data]) => ({ id, data: structuredClone(data) })),
						hasMore: variants.size > limit,
					};
				},
			},
		},
	} as unknown as PluginContext;
	return {
		ctx,
		product,
		variants,
		values,
		setSetting(key: string, value: string) {
			values.set(`settings:${key}`, { value, revision: String(++revision) });
		},
	};
}

const line = { productId: "p1", quantity: 1 };

async function expectInventoryError(promise: Promise<unknown>, code: string) {
	try {
		await promise;
		expect.unreachable("Expected inventory operation to reject");
	} catch (error) {
		expect(error).toBeInstanceOf(InventoryError);
		expect((error as InventoryError).code).toBe(code);
	}
}

describe("inventory environment isolation", () => {
	it("keeps identical product/reservation IDs and capacity independent across modes", async () => {
		const { ctx, values } = fixture({ stock: 2 });
		await reserveInventory(ctx, "same", [{ ...line, quantity: 2 }], { mode: "test" });
		await reserveInventory(ctx, "same", [line], { mode: "live" });
		expect(await sumReservedInventory(ctx, "p1", undefined, "test")).toBe(2);
		expect(await sumReservedInventory(ctx, "p1", undefined, "live")).toBe(1);
		expect((await readInventoryAvailability(ctx, line, "test")).effectiveStock).toBe(0);
		expect((await readInventoryAvailability(ctx, line, "live")).effectiveStock).toBe(1);
		await expectInventoryError(
			reserveInventory(ctx, "full", [line], { mode: "test" }),
			"insufficient_stock",
		);
		await consumeInventoryReservation(ctx, "same", "live");
		expect((await getInventoryReservation(ctx, "same", "test"))?.status).toBe("reserved");
		expect(values.has("state:inventory:projection:v1")).toBe(true);
		expect(values.has("state:inventory:projection:live:v1")).toBe(true);
	});

	it("retains last-unit CAS protection independently in both environments", async () => {
		const { ctx } = fixture({ stock: 1 });
		for (const mode of ["test", "live"] as const) {
			const results = await Promise.allSettled(
				["a", "b", "c"].map((id) => reserveInventory(ctx, id, [line], { mode })),
			);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(await sumReservedInventory(ctx, "p1", undefined, mode)).toBe(1);
		}
	});

	it("resolves only new work from the selected provider and matching key prefix", async () => {
		const { ctx, setSetting } = fixture();
		expect(await resolveInventoryMode(ctx)).toBe("test");
		setSetting("stripeSecretKey", "sk_live_fixture");
		expect(await resolveInventoryMode(ctx)).toBe("live");
		setSetting("paymentProvider", "paystack-test");
		setSetting("paystackMode", "live");
		expect(await resolveInventoryMode(ctx)).toBe("test");
		setSetting("paymentProvider", "paystack");
		expect(await resolveInventoryMode(ctx)).toBe("live");
		await reserveInventory(ctx, "new-live", [line]);
		expect(await getInventoryReservation(ctx, "new-live", "test")).toBeNull();
		expect((await readInventoryAvailability(ctx, line)).mode).toBe("live");
		setSetting("paystackMode", "test");
		expect((await readInventoryAvailability(ctx, line)).effectiveStock).toBe(2);
		setSetting("paymentProvider", "stripe");
		setSetting("stripeSecretKey", "sk_test_fixture");
		expect(await resolveInventoryMode(ctx)).toBe("test");
		setSetting("stripeSecretKey", "rk_live_fixture");
		expect(await resolveInventoryMode(ctx)).toBe("live");
		setSetting("stripeSecretKey", "rk_test_fixture");
		expect(await resolveInventoryMode(ctx)).toBe("test");
		setSetting("stripeSecretKey", "invalid-fixture");
		await expectInventoryError(resolveInventoryMode(ctx), "invalid_input");
		expect(await resolveInventoryMode(ctx, "live")).toBe("live");
		setSetting("paymentProvider", "paystack");
		setSetting("paystackMode", "invalid");
		await expectInventoryError(resolveInventoryMode(ctx), "invalid_input");
	});

	for (const oldMode of ["test", "live"] as const) {
		it(`uses persisted ${oldMode} for consume, release and partial/full refund after a settings switch`, async () => {
			const { ctx, setSetting } = fixture({ stock: 4 });
			const newMode = oldMode === "test" ? "live" : "test";
			setSetting("paymentProvider", "paystack");
			setSetting("paystackMode", oldMode);
			await reserveInventory(ctx, "paid", [{ ...line, quantity: 2 }]);
			await reserveInventory(ctx, "cancelled", [line]);
			await reserveInventory(ctx, "paid", [line], { mode: newMode });
			setSetting("paystackMode", newMode);
			await finalizeOrderInventory(ctx, { orderId: "order", orderDraftId: "paid", mode: oldMode });
			await releaseInventoryReservation(ctx, "cancelled", oldMode);
			(ctx.storage as unknown as { orders: unknown }).orders = {
				async get() {
					return { metadata: { inventoryReservationId: "paid" } };
				},
			};
			const refund = {
				orderItem: { id: "item", orderId: "order", productId: "p1", quantity: 2 } as never,
				quantity: 1,
				refundId: "refund",
				mode: oldMode,
			};
			await restoreOrderInventory(ctx, refund);
			await restoreOrderInventory(ctx, refund);
			expect((await readInventoryAvailability(ctx, line, oldMode)).effectiveStock).toBe(3);
			await restockOrderInventory(ctx, "paid", oldMode);
			expect((await readInventoryAvailability(ctx, line, oldMode)).effectiveStock).toBe(4);
			expect((await readInventoryAvailability(ctx, line, newMode)).effectiveStock).toBe(3);
			expect((await getInventoryReservation(ctx, "paid", newMode))?.status).toBe("reserved");
		});
	}

	it("does not let a simulated refund change a newly adopted live CMS baseline", async () => {
		const { ctx, product, setSetting } = fixture({ stock: 2 });
		await reserveInventory(ctx, "legacy", [line]);
		await consumeInventoryReservation(ctx, "legacy");
		product.data.stock_quantity = 1;
		setSetting("paymentProvider", "paystack");
		setSetting("paystackMode", "live");
		await reconcileInventory(ctx, [line]);
		(ctx.storage as unknown as { orders: unknown }).orders = {
			async get() {
				return { metadata: { inventoryReservationId: "legacy" } };
			},
		};
		await restoreOrderInventory(ctx, {
			orderItem: { id: "item", orderId: "order", productId: "p1", quantity: 1 } as never,
			quantity: 1,
			refundId: "refund", // Historical transaction: absent mode remains test.
		});
		expect((await readInventoryAvailability(ctx, line, "test")).effectiveStock).toBe(2);
		expect((await readInventoryAvailability(ctx, line, "live")).effectiveStock).toBe(1);
		await reserveInventory(ctx, "live-sale", [line], { mode: "live" });
		await expectInventoryError(
			consumeInventoryReservation(ctx, "live-sale"),
			"reservation_not_found",
		);
	});

	it("retains historical test reservations for legacy consume/release after switching to live", async () => {
		const { ctx, setSetting } = fixture();
		await reserveInventory(ctx, "paid", [line]);
		await reserveInventory(ctx, "cancelled", [line]);
		setSetting("paymentProvider", "paystack");
		setSetting("paystackMode", "live");
		await finalizeOrderInventory(ctx, { orderId: "order", orderDraftId: "paid" });
		await releaseInventoryReservation(ctx, "cancelled");
		expect((await getInventoryReservation(ctx, "paid"))?.status).toBe("consumed");
		expect((await readInventoryAvailability(ctx, line)).effectiveStock).toBe(2);
	});

	it("rejects cross-mode previews even when all stock counts match", async () => {
		const { ctx, product, setSetting } = fixture();
		setSetting("paymentProvider", "paystack");
		const preview = [await readInventoryAvailability(ctx, line)];
		setSetting("paystackMode", "live");
		await expectInventoryError(reconcileInventory(ctx, [line], preview), "reconcile_conflict");
		await reconcileInventory(ctx, [line], preview, "test");
		const livePreview = [await readInventoryAvailability(ctx, line)];
		await reconcileInventory(ctx, [line], livePreview);
		product.data.manage_stock = false;
		const untrackedPreview = [await readInventoryAvailability(ctx, line, "test")];
		expect(untrackedPreview[0]?.mode).toBe("test");
		await expectInventoryError(
			reconcileInventory(ctx, [line], untrackedPreview, "live"),
			"reconcile_conflict",
		);
	});

	it("isolates variant counts and expiry transitions", async () => {
		const { ctx } = fixture({ stock: 1, variants: [{ id: "v1" }] });
		const variantLine = { ...line, variantId: "v1" };
		await reserveInventory(ctx, "expired", [variantLine], { mode: "test", ttlMs: 1 });
		await reserveInventory(ctx, "held", [variantLine], { mode: "live" });
		await Bun.sleep(5);
		expect((await readInventoryAvailability(ctx, variantLine, "test")).effectiveStock).toBe(1);
		expect((await readInventoryAvailability(ctx, variantLine, "live")).effectiveStock).toBe(0);
	});

	for (const action of [deleteLock, releaseLock] as const) {
		it(`${action.name} releases the captured mode after settings change`, async () => {
			const { ctx, setSetting } = fixture();
			setSetting("paymentProvider", "paystack");
			setSetting("paystackMode", "live");
			const lock = newLock("draft", "session", [line]);
			await createLock(ctx, lock);
			expect((await getLock(ctx, "draft"))?.mode).toBe("live");
			setSetting("paystackMode", "test");
			await createLock(ctx, lock); // Retry must keep the original mode.
			await reserveInventory(ctx, "draft", [line], { mode: "test" });
			await action(ctx, "draft");
			expect((await getInventoryReservation(ctx, "draft", "live"))?.status).toBe("released");
			expect((await getInventoryReservation(ctx, "draft", "test"))?.status).toBe("reserved");
			expect(await getLock(ctx, "draft")).toBeNull();
		});
	}

	it("uses explicit lock mode over settings and never releases paid stock during cleanup", async () => {
		const { ctx } = fixture(); // Default settings are test.
		await createLock(ctx, newLock("paid", "session", [line], { mode: "live" }));
		await consumeInventoryReservation(ctx, "paid", "live");
		await expect(
			createLock(ctx, newLock("paid", "session", [line], { mode: "test" })),
		).rejects.toThrow("Stock lock mode conflict");
		await deleteLock(ctx, "paid");
		expect((await getInventoryReservation(ctx, "paid", "live"))?.status).toBe("consumed");
		expect((await readInventoryAvailability(ctx, line, "live")).effectiveStock).toBe(1);
		expect((await readInventoryAvailability(ctx, line, "test")).effectiveStock).toBe(2);
	});

	it("sweeps captured live locks and treats mode-less historical locks as test", async () => {
		const { ctx, setSetting, values } = fixture({ stock: 3 });
		const lock = newLock("expired", "session", [line], { mode: "live" });
		await createLock(ctx, lock);
		const stored = values.get("lock:expired")!;
		values.set("lock:expired", {
			...stored,
			value: { ...lock, expiresAt: "2000-01-01T00:00:00.000Z" },
		});
		await reserveInventory(ctx, "expired", [line], { mode: "test" });
		expect(await sweepExpiredLocks(ctx)).toBe(1);
		expect((await getInventoryReservation(ctx, "expired", "live"))?.status).toBe("released");
		expect((await getInventoryReservation(ctx, "expired", "test"))?.status).toBe("reserved");
		await reserveInventory(ctx, "legacy", [line]);
		values.set("lock:legacy", { value: newLock("legacy", "session", [line]), revision: "legacy" });
		setSetting("paymentProvider", "paystack");
		setSetting("paystackMode", "live");
		await deleteLock(ctx, "legacy");
		expect((await getInventoryReservation(ctx, "legacy", "test"))?.status).toBe("released");
		expect((await readInventoryAvailability(ctx, line, "live")).effectiveStock).toBe(3);
	});
});

describe("CAS inventory reservations", () => {
	it("allows only one concurrent reservation for the last unit", async () => {
		const { ctx } = fixture({ stock: 1 });
		const results = await Promise.allSettled(
			["a", "b", "c"].map((id) => reserveInventory(ctx, id, [line])),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(await sumReservedInventory(ctx, "p1")).toBe(1);
	});

	it("aggregates personalised lines sharing the same stock bucket", async () => {
		const { ctx } = fixture({ stock: 1 });
		await expectInventoryError(
			reserveInventory(ctx, "order", [
				{ ...line, quantity: 1 },
				{ ...line, quantity: 1 },
			]),
			"insufficient_stock",
		);
	});

	it("is idempotent for a stable ID, consumes once, and never releases consumption", async () => {
		const { ctx } = fixture();
		const first = await reserveInventory(ctx, "order", [line]);
		expect((await reserveInventory(ctx, "order", [line])).createdAt).toBe(first.createdAt);
		await expectInventoryError(
			reserveInventory(ctx, "order", [{ ...line, quantity: 2 }]),
			"reservation_conflict",
		);
		expect((await consumeInventoryReservation(ctx, "order")).status).toBe("consumed");
		expect((await consumeInventoryReservation(ctx, "order")).status).toBe("consumed");
		await expectInventoryError(releaseInventoryReservation(ctx, "order"), "reservation_consumed");
	});

	it("expires through a CAS state transition and restores availability", async () => {
		const { ctx } = fixture({ stock: 1 });
		await reserveInventory(ctx, "expired", [line], { ttlMs: 1 });
		await Bun.sleep(5);
		expect((await getInventoryReservation(ctx, "expired"))?.status).toBe("released");
		await expect(reserveInventory(ctx, "next", [line])).resolves.toMatchObject({
			status: "reserved",
		});
	});

	it("records untracked and configured backorders without rejecting normal checkout", async () => {
		const untracked = fixture({ stock: 0 });
		untracked.product.data.manage_stock = false;
		await expect(
			reserveInventory(untracked.ctx, "untracked", [{ ...line, quantity: 2 }]),
		).resolves.toMatchObject({
			status: "reserved",
		});
		expect(await readInventoryAvailability(untracked.ctx, line)).toMatchObject({
			tracking: "untracked",
		});

		const backorder = fixture({ stock: 0 });
		backorder.product.data.backorders = "yes";
		await reserveInventory(backorder.ctx, "backorder", [{ ...line, quantity: 2 }]);
		await consumeInventoryReservation(backorder.ctx, "backorder");
		expect(await readInventoryAvailability(backorder.ctx, line)).toMatchObject({
			tracking: "backorder",
			effectiveStock: -2,
		});
		(backorder.ctx.storage as unknown as { orders: unknown }).orders = {
			async get(id: string) {
				return id === "order" ? { metadata: { inventoryReservationId: "backorder" } } : null;
			},
		};
		const refundLine = {
			id: "item",
			orderId: "order",
			productId: "p1",
			quantity: 2,
		} as never;
		await Promise.all([
			restoreOrderInventory(backorder.ctx, {
				orderItem: refundLine,
				quantity: 2,
				refundId: "refund",
			}),
			restoreOrderInventory(backorder.ctx, {
				orderItem: refundLine,
				quantity: 2,
				refundId: "refund",
			}),
		]);
		expect(await readInventoryAvailability(backorder.ctx, line)).toMatchObject({
			effectiveStock: 0,
		});
		await restockOrderInventory(backorder.ctx, "backorder");
		expect(await readInventoryAvailability(backorder.ctx, line)).toMatchObject({
			effectiveStock: 0,
		});
	});

	it("rejects mismatched/inactive variants and CMS changes until explicit reconciliation", async () => {
		const inactive = fixture({ variants: [{ id: "v1", isActive: false }] });
		await expectInventoryError(
			validateInventoryLines(inactive.ctx, [{ productId: "p1", variantId: "v1", quantity: 1 }]),
			"variant_unavailable",
		);
		const { ctx, product } = fixture({ stock: 2 });
		await reserveInventory(ctx, "first", [line]);
		product.data.stock_quantity = 1;
		await expectInventoryError(reserveInventory(ctx, "second", [line]), "catalogue_changed");
		await reconcileInventory(ctx, [line]);
		await releaseInventoryReservation(ctx, "first");
		await expect(reserveInventory(ctx, "second", [line])).resolves.toMatchObject({
			status: "reserved",
		});
	});

	it("rejects an adoption preview made stale by a sale, reservation, or refund", async () => {
		const sale = fixture({ stock: 2 });
		await reconcileInventory(sale.ctx, [line]);
		const salePreview = [await readInventoryAvailability(sale.ctx, line)];
		await reserveInventory(sale.ctx, "sale", [line]);
		await consumeInventoryReservation(sale.ctx, "sale");
		await expectInventoryError(
			reconcileInventory(sale.ctx, [line], salePreview),
			"reconcile_conflict",
		);

		const held = fixture({ stock: 2 });
		await reconcileInventory(held.ctx, [line]);
		const heldPreview = [await readInventoryAvailability(held.ctx, line)];
		await reserveInventory(held.ctx, "held", [line]);
		await expectInventoryError(
			reconcileInventory(held.ctx, [line], heldPreview),
			"reconcile_conflict",
		);

		const refunded = fixture({ stock: 2 });
		await reserveInventory(refunded.ctx, "order", [line]);
		await consumeInventoryReservation(refunded.ctx, "order");
		const refundPreview = [await readInventoryAvailability(refunded.ctx, line)];
		(refunded.ctx.storage as unknown as { orders: unknown }).orders = {
			async get() {
				return { metadata: { inventoryReservationId: "order" } };
			},
		};
		await restoreOrderInventory(refunded.ctx, {
			orderItem: { id: "item", orderId: "order", productId: "p1", quantity: 1 } as never,
			quantity: 1,
			refundId: "refund",
		});
		await expectInventoryError(
			reconcileInventory(refunded.ctx, [line], refundPreview),
			"reconcile_conflict",
		);
	});

	it("rejects stale CMS stock and tracking previews without bypassing drift checks", async () => {
		const stock = fixture({ stock: 2 });
		await reconcileInventory(stock.ctx, [line]);
		const stockPreview = [await readInventoryAvailability(stock.ctx, line)];
		stock.product.data.stock_quantity = 1;
		await expectInventoryError(
			reconcileInventory(stock.ctx, [line], stockPreview),
			"reconcile_conflict",
		);
		await expectInventoryError(
			reserveInventory(stock.ctx, "stock-change", [line]),
			"catalogue_changed",
		);

		const tracking = fixture({ stock: 2 });
		await reconcileInventory(tracking.ctx, [line]);
		const trackingPreview = [await readInventoryAvailability(tracking.ctx, line)];
		tracking.product.data.manage_stock = false;
		await expectInventoryError(
			reconcileInventory(tracking.ctx, [line], trackingPreview),
			"reconcile_conflict",
		);
		await expectInventoryError(
			reserveInventory(tracking.ctx, "tracking-change", [line]),
			"catalogue_changed",
		);
	});

	it("adopts an exact preview while preserving held quantities", async () => {
		const { ctx, product } = fixture({ stock: 5 });
		await reconcileInventory(ctx, [line]);
		await reserveInventory(ctx, "held", [{ ...line, quantity: 2 }]);
		product.data.stock_quantity = 4;
		const preview = [await readInventoryAvailability(ctx, line)];
		expect(preview).toEqual([
			{
				mode: "test",
				bucketId: "product:p1",
				tracking: "finite",
				catalogStock: 4,
				effectiveStock: 3,
				drift: -1,
				reserved: 2,
			},
		]);
		await reconcileInventory(ctx, [line], preview);
		expect(await readInventoryAvailability(ctx, line)).toEqual({
			mode: "test",
			bucketId: "product:p1",
			tracking: "finite",
			catalogStock: 4,
			effectiveStock: 2,
			drift: 0,
			reserved: 2,
		});
	});

	it("permits only one concurrent adoption of the same preview", async () => {
		const { ctx, product } = fixture({ stock: 5 });
		await reconcileInventory(ctx, [line]);
		product.data.stock_quantity = 4;
		const preview = [await readInventoryAvailability(ctx, line)];
		const results = await Promise.allSettled([
			reconcileInventory(ctx, [line], preview),
			reconcileInventory(ctx, [line], preview),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect((rejected as PromiseRejectedResult).reason).toMatchObject({
			code: "reconcile_conflict",
		});
	});

	it("caps refunds by their durable order item as well as their shared bucket", async () => {
		const { ctx } = fixture({ stock: 2 });
		await reserveInventory(ctx, "order", [
			{ ...line, quantity: 1 },
			{ ...line, quantity: 1 },
		]);
		await consumeInventoryReservation(ctx, "order");
		(ctx.storage as unknown as { orders: unknown }).orders = {
			async get() {
				return { metadata: { inventoryReservationId: "order" } };
			},
		};
		const first = { id: "first", orderId: "order", productId: "p1", quantity: 1 } as never;
		const second = { id: "second", orderId: "order", productId: "p1", quantity: 1 } as never;
		await restoreOrderInventory(ctx, { orderItem: first, quantity: 1, refundId: "refund-1" });
		await expect(
			restoreOrderInventory(ctx, { orderItem: first, quantity: 1, refundId: "refund-1" }),
		).resolves.toBeUndefined();
		await expectInventoryError(
			restoreOrderInventory(ctx, { orderItem: first, quantity: 1, refundId: "refund-2" }),
			"restock_exceeds_purchased",
		);
		await expect(
			restoreOrderInventory(ctx, { orderItem: second, quantity: 1, refundId: "refund-3" }),
		).resolves.toBeUndefined();
	});
});
