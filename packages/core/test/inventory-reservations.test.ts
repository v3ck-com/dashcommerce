import { describe, expect, it } from "bun:test";
import type { PluginContext } from "emdash";
import {
	InventoryError,
	consumeInventoryReservation,
	getInventoryReservation,
	reconcileInventory,
	releaseInventoryReservation,
	reserveInventory,
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
	return { ctx, product, variants };
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
});
