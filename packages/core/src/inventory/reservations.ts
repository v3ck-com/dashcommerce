/**
 * CAS-backed inventory projection and reservation ledger.
 *
 * The projection deliberately lives in one KV document: a reservation which
 * spans several SKUs changes all buckets in one compare-and-set operation.
 * This is a conservative single-store primitive, not a distributed
 * transaction with the CMS or a payment provider.
 */

import type { PluginContext } from "emdash";
import { normalizeProductFields } from "../products/normalize";
import { getVariant, listVariantsForProduct } from "../products/variants";

const PROJECTION_KEY = "state:inventory:projection:v1";
export const MAX_INVENTORY_QUANTITY = 1_000;
export const MAX_RESERVATION_LINES = 100;
const MAX_CAS_RETRIES = 12;

export type InventoryReservationStatus = "reserved" | "consumed" | "released";

export interface InventoryRequestLine {
	productId: string;
	variantId?: string;
	quantity: number;
}

export interface InventoryBucketLine extends InventoryRequestLine {
	bucketId: string;
}

export interface InventoryReservation {
	id: string;
	fingerprint: string;
	lines: InventoryBucketLine[];
	status: InventoryReservationStatus;
	expiresAt: string;
	createdAt: string;
	consumedAt?: string;
	releasedAt?: string;
}

interface InventoryBucket {
	productId: string;
	variantId?: string;
	/** CMS quantity seen when this projection bucket was explicitly initialized/reconciled. */
	catalogStock: number;
	/** Sellable units after consumed and currently-reserved units. */
	available: number;
}

interface InventoryProjection {
	version: 1;
	buckets: Record<string, InventoryBucket>;
	reservations: Record<string, InventoryReservation>;
}

export class InventoryError extends Error {
	constructor(
		message: string,
		public readonly code: string,
	) {
		super(message);
		this.name = "InventoryError";
	}
}

function fail(message: string, code: string): never {
	throw new InventoryError(message, code);
}

function assertId(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string") fail(`Invalid ${label}`, "invalid_input");
	if (value.length === 0 || value.length > 200) fail(`Invalid ${label}`, "invalid_input");
}

function assertQuantity(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value)) {
		fail(
			`Quantity must be a safe integer between 1 and ${MAX_INVENTORY_QUANTITY}`,
			"invalid_quantity",
		);
	}
	if (value < 1 || value > MAX_INVENTORY_QUANTITY) {
		fail(
			`Quantity must be a safe integer between 1 and ${MAX_INVENTORY_QUANTITY}`,
			"invalid_quantity",
		);
	}
}

export function inventoryBucketId(productId: string, variantId?: string): string {
	return variantId ? `variant:${productId}:${variantId}` : `product:${productId}`;
}

function fingerprint(lines: InventoryBucketLine[]): string {
	return JSON.stringify(lines.map(({ bucketId, quantity }) => [bucketId, quantity]));
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function emptyProjection(): InventoryProjection {
	return { version: 1, buckets: {}, reservations: {} };
}

function validStock(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER
	);
}

/**
 * Validate a line against the current catalogue and select its one stock owner.
 * A product that has any variants never falls back to parent stock.
 */
export async function validateInventoryLines(
	ctx: PluginContext,
	lines: InventoryRequestLine[],
): Promise<InventoryBucketLine[]> {
	if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_RESERVATION_LINES) {
		fail("A reservation must contain between 1 and 100 lines", "invalid_input");
	}
	if (!ctx.content) fail("Content access unavailable", "catalogue_unavailable");

	const aggregate = new Map<string, InventoryBucketLine>();
	for (const line of lines) {
		if (!line || typeof line !== "object") fail("Invalid inventory line", "invalid_input");
		assertId(line.productId, "productId");
		if (line.variantId !== undefined) assertId(line.variantId, "variantId");
		assertQuantity(line.quantity);

		const product = await ctx.content.get("products", line.productId);
		if (!product || product.status !== "published") {
			fail("Product is unavailable", "product_unavailable");
		}
		const fields = normalizeProductFields(product.data as Record<string, unknown>);
		if (fields.stockStatus === "outofstock" || fields.backorders !== "no") {
			fail("Product is not available for reserved checkout", "product_unavailable");
		}

		const variants = await listVariantsForProduct(ctx, line.productId, {
			limit: MAX_RESERVATION_LINES,
		});
		if (variants.hasMore) fail("Too many variants to safely reserve", "unsupported_catalogue");
		if (variants.items.length > 0 && !line.variantId) {
			fail("A variant must be selected for this product", "variant_required");
		}
		if (variants.items.length === 0 && line.variantId) {
			fail("This product does not have that variant", "variant_mismatch");
		}

		let variantId: string | undefined;
		let stock: unknown;
		if (line.variantId) {
			const variant = await getVariant(ctx, line.variantId);
			if (!variant || variant.productId !== line.productId || variant.isActive !== true) {
				fail("Variant is unavailable", "variant_unavailable");
			}
			variantId = variant.id;
			stock = variant.stockQuantity;
		} else {
			if (fields.manageStock !== true) {
				fail("Untracked product stock cannot be reserved", "unsupported_catalogue");
			}
			stock = fields.stockQuantity;
		}
		if (!validStock(stock)) {
			fail("Stock must be a finite non-negative safe integer", "unsupported_catalogue");
		}

		const bucketId = inventoryBucketId(line.productId, variantId);
		const existing = aggregate.get(bucketId);
		const quantity = (existing?.quantity ?? 0) + line.quantity;
		assertQuantity(quantity);
		aggregate.set(bucketId, {
			productId: line.productId,
			...(variantId ? { variantId } : {}),
			quantity,
			bucketId,
		});
	}
	return [...aggregate.values()].sort((a, b) => a.bucketId.localeCompare(b.bucketId));
}

async function authoritativeStocks(
	ctx: PluginContext,
	lines: InventoryBucketLine[],
): Promise<Map<string, number>> {
	// validateInventoryLines checks identity/status and aggregation. Reloading it
	// here makes a CMS edit between validation and the CAS fail closed.
	const current = await validateInventoryLines(ctx, lines);
	const out = new Map<string, number>();
	for (const line of current) {
		if (line.bucketId !== inventoryBucketId(line.productId, line.variantId)) {
			fail("Inventory bucket changed during validation", "catalogue_changed");
		}
		if (line.variantId) {
			const variant = await getVariant(ctx, line.variantId);
			if (!variant || !validStock(variant.stockQuantity))
				fail("Variant stock changed", "catalogue_changed");
			out.set(line.bucketId, variant.stockQuantity);
		} else {
			const product = await ctx.content?.get("products", line.productId);
			const fields = product
				? normalizeProductFields(product.data as Record<string, unknown>)
				: null;
			if (!fields || !validStock(fields.stockQuantity))
				fail("Product stock changed", "catalogue_changed");
			out.set(line.bucketId, fields.stockQuantity);
		}
	}
	return out;
}

function releaseExpired(projection: InventoryProjection, now: number): boolean {
	let changed = false;
	for (const reservation of Object.values(projection.reservations)) {
		if (reservation.status !== "reserved" || Date.parse(reservation.expiresAt) > now) continue;
		for (const line of reservation.lines) {
			const bucket = projection.buckets[line.bucketId];
			if (!bucket) fail("Reservation references a missing inventory bucket", "projection_corrupt");
			bucket.available += line.quantity;
		}
		reservation.status = "released";
		reservation.releasedAt = new Date(now).toISOString();
		changed = true;
	}
	return changed;
}

async function mutateProjection<T>(
	ctx: PluginContext,
	mutate: (projection: InventoryProjection, now: number) => T,
): Promise<T> {
	const kv = ctx.kv;
	if (typeof kv.getVersioned !== "function" || typeof kv.compareAndSet !== "function") {
		fail("EmDash conditional KV is required for inventory", "conditional_kv_required");
	}
	for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
		const current = await kv.getVersioned<InventoryProjection>(PROJECTION_KEY);
		const projection = clone(current?.value ?? emptyProjection());
		const now = Date.now();
		releaseExpired(projection, now);
		const result = mutate(projection, now);
		const write = await kv.compareAndSet(PROJECTION_KEY, current?.revision ?? null, projection);
		if (write.applied) return result;
	}
	fail("Inventory was busy; retry the request", "concurrent_update");
}

/** Atomically reserve all stock buckets for a stable checkout/order ID. */
export async function reserveInventory(
	ctx: PluginContext,
	reservationId: string,
	lines: InventoryRequestLine[],
	opts: { ttlMs?: number } = {},
): Promise<InventoryReservation> {
	assertId(reservationId, "reservationId");
	const requested = await validateInventoryLines(ctx, lines);
	const stocks = await authoritativeStocks(ctx, requested);
	const ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) {
		fail("Invalid reservation TTL", "invalid_input");
	}
	const requestFingerprint = fingerprint(requested);

	return mutateProjection(ctx, (projection, now) => {
		const existing = projection.reservations[reservationId];
		if (existing) {
			if (existing.fingerprint !== requestFingerprint) {
				fail("Reservation ID was reused for different stock", "reservation_conflict");
			}
			return existing;
		}
		for (const line of requested) {
			const stock = stocks.get(line.bucketId);
			if (stock === undefined) fail("Catalogue stock disappeared", "catalogue_changed");
			const bucket = projection.buckets[line.bucketId];
			if (!bucket) {
				projection.buckets[line.bucketId] = {
					productId: line.productId,
					...(line.variantId ? { variantId: line.variantId } : {}),
					catalogStock: stock,
					available: stock,
				};
			} else if (
				bucket.catalogStock !== stock ||
				bucket.productId !== line.productId ||
				bucket.variantId !== line.variantId
			) {
				fail(
					"Catalogue stock changed; reconcile inventory before accepting orders",
					"catalogue_changed",
				);
			}
		}
		for (const line of requested) {
			if (projection.buckets[line.bucketId]!.available < line.quantity) {
				fail("Insufficient stock", "insufficient_stock");
			}
		}
		for (const line of requested) projection.buckets[line.bucketId]!.available -= line.quantity;
		const reservation: InventoryReservation = {
			id: reservationId,
			fingerprint: requestFingerprint,
			lines: requested,
			status: "reserved",
			expiresAt: new Date(now + ttlMs).toISOString(),
			createdAt: new Date(now).toISOString(),
		};
		projection.reservations[reservationId] = reservation;
		return reservation;
	});
}

export async function getInventoryReservation(
	ctx: PluginContext,
	reservationId: string,
): Promise<InventoryReservation | null> {
	assertId(reservationId, "reservationId");
	return mutateProjection(ctx, (projection) => projection.reservations[reservationId] ?? null);
}

/** Mark a non-expired reservation consumed. Repeating with the same ID is safe. */
export async function consumeInventoryReservation(
	ctx: PluginContext,
	reservationId: string,
): Promise<InventoryReservation> {
	assertId(reservationId, "reservationId");
	return mutateProjection(ctx, (projection, now) => {
		const reservation = projection.reservations[reservationId];
		if (!reservation) fail("Reservation not found", "reservation_not_found");
		if (reservation.status === "consumed") return reservation;
		if (reservation.status !== "reserved")
			fail("Reservation is no longer active", "reservation_inactive");
		if (Date.parse(reservation.expiresAt) <= now)
			fail("Reservation expired", "reservation_expired");
		reservation.status = "consumed";
		reservation.consumedAt = new Date(now).toISOString();
		return reservation;
	});
}

/** Release an active reservation. Consumed reservations are deliberately immutable. */
export async function releaseInventoryReservation(
	ctx: PluginContext,
	reservationId: string,
): Promise<InventoryReservation | null> {
	assertId(reservationId, "reservationId");
	return mutateProjection(ctx, (projection, now) => {
		const reservation = projection.reservations[reservationId];
		if (!reservation || reservation.status === "released") return reservation ?? null;
		if (reservation.status === "consumed")
			fail("Consumed reservations cannot be released", "reservation_consumed");
		for (const line of reservation.lines)
			projection.buckets[line.bucketId]!.available += line.quantity;
		reservation.status = "released";
		reservation.releasedAt = new Date(now).toISOString();
		return reservation;
	});
}

export async function sumReservedInventory(
	ctx: PluginContext,
	productId: string,
	variantId?: string,
): Promise<number> {
	const bucketId = inventoryBucketId(productId, variantId);
	return mutateProjection(ctx, (projection) => {
		let total = 0;
		for (const reservation of Object.values(projection.reservations)) {
			if (reservation.status !== "reserved") continue;
			total += reservation.lines.find((line) => line.bucketId === bucketId)?.quantity ?? 0;
		}
		return total;
	});
}

/**
 * Explicitly accept current CMS quantities as the new projection baseline.
 * Active reservations remain protected; reconciliation fails rather than
 * silently admitting a CMS quantity below already-reserved units.
 */
export async function reconcileInventory(
	ctx: PluginContext,
	lines: InventoryRequestLine[],
): Promise<void> {
	const requested = await validateInventoryLines(ctx, lines);
	const stocks = await authoritativeStocks(ctx, requested);
	await mutateProjection(ctx, (projection) => {
		for (const line of requested) {
			const held = Object.values(projection.reservations)
				.filter((reservation) => reservation.status === "reserved")
				.reduce(
					(total, reservation) =>
						total +
						(reservation.lines.find((entry) => entry.bucketId === line.bucketId)?.quantity ?? 0),
					0,
				);
			const stock = stocks.get(line.bucketId)!;
			if (stock < held) fail("CMS stock is below active reservations", "reconcile_conflict");
			projection.buckets[line.bucketId] = {
				productId: line.productId,
				...(line.variantId ? { variantId: line.variantId } : {}),
				catalogStock: stock,
				available: stock - held,
			};
		}
	});
}
