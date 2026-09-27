/**
 * Provider-neutral CAS inventory projection. Catalogue stock remains the raw
 * merchant-entered baseline; this ledger records reservations and irreversible
 * paid/refund effects exactly once. It deliberately never uses `put` as a
 * lock and never decrements CMS stock as a second side effect.
 */
import type { PluginContext } from "emdash";
import { normalizeProductFields } from "../products/normalize";
import { getVariant, listVariantsForProduct } from "../products/variants";
import type { OrderItem } from "../types";

// The pre-mode ledger belongs to the original test-only integration.
const TEST_PROJECTION_KEY = "state:inventory:projection:v1";
const LIVE_PROJECTION_KEY = "state:inventory:projection:live:v1";
export type InventoryMode = "test" | "live";
export const MAX_INVENTORY_QUANTITY = 1_000;
export const MAX_RESERVATION_LINES = 100;
const MAX_CAS_RETRIES = 12;

type InventoryTracking = "finite" | "backorder" | "untracked";
export type InventoryReservationStatus = "reserved" | "consumed" | "released" | "restocked";

export interface InventoryRequestLine {
	productId: string;
	variantId?: string;
	quantity: number;
}
export interface InventoryBucketLine extends InventoryRequestLine {
	bucketId: string;
	tracking: InventoryTracking;
	/** Raw finite CMS quantity observed while validating this line. */
	catalogStock?: number;
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
	restockedAt?: string;
}
interface InventoryBucket {
	productId: string;
	variantId?: string;
	catalogStock: number;
	/** Effective sellable stock after paid and reserved effects. Can be negative for configured backorders. */
	available: number;
	tracking: Exclude<InventoryTracking, "untracked">;
}
interface InventoryRestockEffect {
	reservationId: string;
	bucketId: string;
	/** Absent on projections written before per-order-item restoration tracking. */
	orderItemId?: string;
	quantity: number;
}
interface InventoryProjection {
	version: 1;
	buckets: Record<string, InventoryBucket>;
	reservations: Record<string, InventoryReservation>;
	/** refund-line idempotency records, keyed by refund + order item */
	restockEffects?: Record<string, InventoryRestockEffect>;
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
function assertMode(mode: unknown): asserts mode is InventoryMode {
	if (mode !== "test" && mode !== "live") fail("Invalid inventory mode", "invalid_input");
}

/** Current environment is only suitable for NEW stock work, never old callbacks. */
export async function resolveInventoryMode(
	ctx: PluginContext,
	mode?: InventoryMode,
): Promise<InventoryMode> {
	if (mode !== undefined) {
		assertMode(mode);
		return mode;
	}
	const provider = await ctx.kv.get<string>("settings:paymentProvider");
	if (provider === "paystack-test") return "test";
	if (provider === "paystack") {
		const configured = (await ctx.kv.get<string>("settings:paystackMode")) ?? "test";
		assertMode(configured);
		return configured;
	}
	if (provider != null && provider !== "stripe")
		fail("Invalid inventory provider", "invalid_input");
	const key = await ctx.kv.get<string>("settings:stripeSecretKey");
	if (!key) return "test";
	if (/^(sk|rk)_test_/.test(key)) return "test";
	if (/^(sk|rk)_live_/.test(key)) return "live";
	fail("Invalid Stripe inventory environment", "invalid_input");
}

function assertId(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 200)
		fail(`Invalid ${label}`, "invalid_input");
}
function assertQuantity(value: unknown): asserts value is number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 1 ||
		(value as number) > MAX_INVENTORY_QUANTITY
	)
		fail(
			`Quantity must be a safe integer between 1 and ${MAX_INVENTORY_QUANTITY}`,
			"invalid_quantity",
		);
}
function validStock(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER
	);
}
export function inventoryBucketId(productId: string, variantId?: string): string {
	return variantId ? `variant:${productId}:${variantId}` : `product:${productId}`;
}
function fingerprint(lines: InventoryBucketLine[]): string {
	return JSON.stringify(lines.map((line) => [line.bucketId, line.quantity, line.tracking]));
}
function clone<T>(value: T): T {
	return structuredClone(value);
}
function emptyProjection(): InventoryProjection {
	return { version: 1, buckets: {}, reservations: {}, restockEffects: {} };
}

/** Validate identity and determine whether each line is finite, backorderable, or untracked. */
export async function validateInventoryLines(
	ctx: PluginContext,
	lines: InventoryRequestLine[],
): Promise<InventoryBucketLine[]> {
	if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_RESERVATION_LINES)
		fail("A reservation must contain between 1 and 100 lines", "invalid_input");
	if (!ctx.content) fail("Content access unavailable", "catalogue_unavailable");
	const aggregate = new Map<string, InventoryBucketLine>();
	for (const line of lines) {
		if (!line || typeof line !== "object") fail("Invalid inventory line", "invalid_input");
		assertId(line.productId, "productId");
		if (line.variantId !== undefined) assertId(line.variantId, "variantId");
		assertQuantity(line.quantity);
		const product = await ctx.content.get("products", line.productId);
		if (!product || product.status !== "published")
			fail("Product is unavailable", "product_unavailable");
		const fields = normalizeProductFields(product.data as Record<string, unknown>);
		if (fields.stockStatus === "outofstock" && fields.backorders === "no")
			fail("Product is out of stock", "product_unavailable");
		const variants = await listVariantsForProduct(ctx, line.productId, {
			limit: MAX_RESERVATION_LINES,
		});
		if (variants.hasMore) fail("Too many variants to safely reserve", "unsupported_catalogue");
		if (variants.items.length > 0 && !line.variantId)
			fail("A variant must be selected for this product", "variant_required");
		if (variants.items.length === 0 && line.variantId)
			fail("This product does not have that variant", "variant_mismatch");
		let variantId: string | undefined;
		let rawStock: unknown;
		if (line.variantId) {
			const variant = await getVariant(ctx, line.variantId);
			if (!variant || variant.productId !== line.productId || !variant.isActive)
				fail("Variant is unavailable", "variant_unavailable");
			variantId = variant.id;
			rawStock = variant.stockQuantity;
		} else {
			rawStock = fields.manageStock ? fields.stockQuantity : null;
		}
		let tracking: InventoryTracking = "untracked";
		let catalogStock: number | undefined;
		if (rawStock !== null && rawStock !== undefined) {
			if (!validStock(rawStock))
				fail("Stock must be a finite non-negative safe integer", "unsupported_catalogue");
			catalogStock = rawStock;
			tracking = fields.backorders === "no" ? "finite" : "backorder";
		}
		const bucketId = inventoryBucketId(line.productId, variantId);
		const old = aggregate.get(bucketId);
		const quantity = (old?.quantity ?? 0) + line.quantity;
		assertQuantity(quantity);
		aggregate.set(bucketId, {
			productId: line.productId,
			...(variantId ? { variantId } : {}),
			quantity,
			bucketId,
			tracking,
			...(catalogStock !== undefined ? { catalogStock } : {}),
		});
	}
	return [...aggregate.values()].sort((a, b) => a.bucketId.localeCompare(b.bucketId));
}

function releaseExpired(projection: InventoryProjection, now: number): boolean {
	let changed = false;
	for (const reservation of Object.values(projection.reservations)) {
		if (reservation.status !== "reserved" || Date.parse(reservation.expiresAt) > now) continue;
		for (const line of reservation.lines) {
			const bucket = projection.buckets[line.bucketId];
			if (bucket) bucket.available += line.quantity;
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
	mode: InventoryMode,
): Promise<T> {
	assertMode(mode);
	const projectionKey = mode === "live" ? LIVE_PROJECTION_KEY : TEST_PROJECTION_KEY;
	const kv = ctx.kv;
	if (typeof kv.getVersioned !== "function" || typeof kv.compareAndSet !== "function")
		fail("EmDash conditional KV is required for inventory", "conditional_kv_required");
	for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
		const current = await kv.getVersioned<InventoryProjection>(projectionKey);
		const projection = clone(current?.value ?? emptyProjection());
		projection.restockEffects ??= {};
		const now = Date.now();
		releaseExpired(projection, now);
		const result = mutate(projection, now);
		if ((await kv.compareAndSet(projectionKey, current?.revision ?? null, projection)).applied)
			return result;
	}
	fail("Inventory was busy; retry the request", "concurrent_update");
}

/** Atomically reserve all requested lines. Untracked lines are recorded but never capacity-gated. */
export async function reserveInventory(
	ctx: PluginContext,
	reservationId: string,
	lines: InventoryRequestLine[],
	opts: { ttlMs?: number; mode?: InventoryMode } = {},
): Promise<InventoryReservation> {
	const mode = await resolveInventoryMode(ctx, opts.mode);
	assertId(reservationId, "reservationId");
	const requested = await validateInventoryLines(ctx, lines);
	const ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
	if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000)
		fail("Invalid reservation TTL", "invalid_input");
	const requestFingerprint = fingerprint(requested);
	return mutateProjection(
		ctx,
		(projection, now) => {
			const existing = projection.reservations[reservationId];
			if (existing) {
				if (existing.fingerprint !== requestFingerprint)
					fail("Reservation ID was reused for different stock", "reservation_conflict");
				return existing;
			}
			for (const line of requested) {
				const bucket = projection.buckets[line.bucketId];
				if (line.tracking === "untracked") {
					// A previously tracked bucket must be explicitly reconciled before a
					// CMS tracking change can bypass its ledger.
					if (bucket)
						fail(
							"Catalogue stock changed; inspect or reconcile inventory before accepting orders",
							"catalogue_changed",
						);
					continue;
				}
				const catalogStock = line.catalogStock;
				if (catalogStock === undefined) fail("Tracked stock is missing", "catalogue_changed");
				if (!bucket)
					projection.buckets[line.bucketId] = {
						productId: line.productId,
						...(line.variantId ? { variantId: line.variantId } : {}),
						catalogStock,
						available: catalogStock,
						tracking: line.tracking,
					};
				else if (
					bucket.catalogStock !== catalogStock ||
					bucket.tracking !== line.tracking ||
					bucket.productId !== line.productId ||
					bucket.variantId !== line.variantId
				)
					fail(
						"Catalogue stock changed; inspect or reconcile inventory before accepting orders",
						"catalogue_changed",
					);
			}
			for (const line of requested) {
				const bucket = projection.buckets[line.bucketId];
				if (bucket?.tracking === "finite" && bucket.available < line.quantity)
					fail("Insufficient stock", "insufficient_stock");
			}
			for (const line of requested) {
				const bucket = projection.buckets[line.bucketId];
				if (bucket) bucket.available -= line.quantity;
			}
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
		},
		mode,
	);
}
export async function getInventoryReservation(
	ctx: PluginContext,
	reservationId: string,
	mode: InventoryMode = "test",
): Promise<InventoryReservation | null> {
	assertId(reservationId, "reservationId");
	return mutateProjection(
		ctx,
		(projection) => projection.reservations[reservationId] ?? null,
		mode,
	);
}
/** Paid finalization: consuming an already-held reservation has no second CMS decrement. */
export async function consumeInventoryReservation(
	ctx: PluginContext,
	reservationId: string,
	mode: InventoryMode = "test",
): Promise<InventoryReservation> {
	assertId(reservationId, "reservationId");
	return mutateProjection(
		ctx,
		(projection, now) => {
			const reservation = projection.reservations[reservationId];
			if (!reservation) fail("Reservation not found", "reservation_not_found");
			if (reservation.status === "consumed" || reservation.status === "restocked")
				return reservation;
			if (reservation.status !== "reserved")
				fail("Reservation is no longer active", "reservation_inactive");
			if (Date.parse(reservation.expiresAt) <= now)
				fail("Reservation expired", "reservation_expired");
			reservation.status = "consumed";
			reservation.consumedAt = new Date(now).toISOString();
			return reservation;
		},
		mode,
	);
}
export async function releaseInventoryReservation(
	ctx: PluginContext,
	reservationId: string,
	mode: InventoryMode = "test",
): Promise<InventoryReservation | null> {
	assertId(reservationId, "reservationId");
	return mutateProjection(
		ctx,
		(projection, now) => {
			const reservation = projection.reservations[reservationId];
			if (!reservation || reservation.status === "released") return reservation ?? null;
			if (reservation.status === "consumed" || reservation.status === "restocked")
				fail("Consumed reservations cannot be released", "reservation_consumed");
			for (const line of reservation.lines) {
				const bucket = projection.buckets[line.bucketId];
				if (bucket) bucket.available += line.quantity;
			}
			reservation.status = "released";
			reservation.releasedAt = new Date(now).toISOString();
			return reservation;
		},
		mode,
	);
}
/** Lifecycle adapter used by B's provider-neutral finalizer. The reservation
 * is the sole stock effect; deliberately do not call legacy CMS decrement. */
export async function finalizeOrderInventory(
	ctx: PluginContext,
	input: {
		orderId: string;
		orderDraftId: string;
		reservationId?: string;
		mode?: "test" | "live";
		items?: unknown[];
	},
): Promise<InventoryReservation> {
	return consumeInventoryReservation(
		ctx,
		input.reservationId ?? input.orderDraftId,
		input.mode ?? "test",
	);
}

/** Idempotently reverse a fully consumed order effect; untracked lines remain accounting-only. */
export async function restockInventoryReservation(
	ctx: PluginContext,
	reservationId: string,
	mode: InventoryMode = "test",
): Promise<InventoryReservation> {
	assertId(reservationId, "reservationId");
	return mutateProjection(
		ctx,
		(projection, now) => {
			const reservation = projection.reservations[reservationId];
			if (!reservation) fail("Reservation not found", "reservation_not_found");
			if (reservation.status === "restocked") return reservation;
			if (reservation.status !== "consumed")
				fail("Only consumed reservations can be restocked", "reservation_inactive");
			for (const line of reservation.lines) {
				const alreadyRestored = Object.values(projection.restockEffects ?? {})
					.filter(
						(effect) => effect.reservationId === reservationId && effect.bucketId === line.bucketId,
					)
					.reduce((total, effect) => total + effect.quantity, 0);
				const remaining = Math.max(0, line.quantity - alreadyRestored);
				const bucket = projection.buckets[line.bucketId];
				if (bucket) bucket.available += remaining;
			}
			reservation.status = "restocked";
			reservation.restockedAt = new Date(now).toISOString();
			return reservation;
		},
		mode,
	);
}
/** Alias named for lifecycle/refund callers. */
export const restockOrderInventory = restockInventoryReservation;

/**
 * Apply one refunded order-line quantity to the same projection that consumed
 * it. The CAS effect key makes retries safe and the aggregate guard prevents
 * several partial refunds from restoring more than was purchased.
 */
export async function restoreOrderInventory(
	ctx: PluginContext,
	input: { orderItem: OrderItem; quantity: number; refundId: string; mode?: "test" | "live" },
): Promise<void> {
	assertQuantity(input.quantity);
	assertId(input.refundId, "refundId");
	const orders = (
		ctx.storage as unknown as {
			orders?: { get(id: string): Promise<{ metadata?: Record<string, unknown> } | null> };
		}
	).orders;
	const order = orders ? await orders.get(input.orderItem.orderId) : null;
	const reservationId = order?.metadata?.inventoryReservationId;
	if (typeof reservationId !== "string")
		fail("Order inventory reservation is missing", "reservation_not_found");
	const bucketId = inventoryBucketId(input.orderItem.productId, input.orderItem.variantId);
	const effectId = `refund:${input.refundId}:${input.orderItem.id}`;
	await mutateProjection(
		ctx,
		(projection) => {
			let effects = projection.restockEffects;
			if (!effects) {
				effects = {};
				projection.restockEffects = effects;
			}
			const prior = effects[effectId];
			if (prior) {
				if (
					prior.reservationId !== reservationId ||
					prior.bucketId !== bucketId ||
					prior.quantity !== input.quantity
				)
					fail("Refund inventory effect conflict", "restock_conflict");
				return;
			}
			const reservation = projection.reservations[reservationId];
			if (!reservation || reservation.status !== "consumed")
				fail("Only consumed reservations can be restocked", "reservation_inactive");
			const purchased = reservation.lines.find((line) => line.bucketId === bucketId)?.quantity;
			if (purchased === undefined)
				fail("Refund line is absent from reservation", "reservation_conflict");
			const alreadyRestored = Object.values(effects)
				.filter((effect) => effect.reservationId === reservationId && effect.bucketId === bucketId)
				.reduce((total, effect) => total + effect.quantity, 0);
			if (alreadyRestored + input.quantity > purchased)
				fail("Refund restock exceeds purchased quantity", "restock_exceeds_purchased");
			// New effects retain their source order item. Old projections did not,
			// so they cannot safely be attributed to an item; the bucket ceiling
			// above remains the conservative migration guard for those effects.
			const restoredForItem = Object.values(effects)
				.filter(
					(effect) =>
						effect.reservationId === reservationId && effect.orderItemId === input.orderItem.id,
				)
				.reduce((total, effect) => total + effect.quantity, 0);
			if (restoredForItem + input.quantity > input.orderItem.quantity)
				fail("Refund restock exceeds purchased order-item quantity", "restock_exceeds_purchased");
			const bucket = projection.buckets[bucketId];
			if (bucket) bucket.available += input.quantity;
			effects[effectId] = {
				reservationId,
				bucketId,
				orderItemId: input.orderItem.id,
				quantity: input.quantity,
			};
		},
		input.mode ?? "test",
	);
}
export async function sumReservedInventory(
	ctx: PluginContext,
	productId: string,
	variantId?: string,
	mode?: InventoryMode,
): Promise<number> {
	const resolvedMode = await resolveInventoryMode(ctx, mode);
	const bucketId = inventoryBucketId(productId, variantId);
	return mutateProjection(
		ctx,
		(projection) =>
			Object.values(projection.reservations)
				.filter((r) => r.status === "reserved")
				.reduce(
					(total, r) => total + (r.lines.find((line) => line.bucketId === bucketId)?.quantity ?? 0),
					0,
				),
		resolvedMode,
	);
}

export interface InventoryAvailability {
	mode: InventoryMode;
	bucketId: string;
	tracking: InventoryTracking;
	catalogStock?: number;
	effectiveStock?: number;
	drift?: number;
	reserved: number;
}
function availabilityFor(
	projection: InventoryProjection,
	current: InventoryBucketLine,
	mode: InventoryMode,
): InventoryAvailability {
	const bucket = projection.buckets[current.bucketId];
	const reserved = Object.values(projection.reservations)
		.filter((r) => r.status === "reserved")
		.reduce(
			(n, r) => n + (r.lines.find((entry) => entry.bucketId === current.bucketId)?.quantity ?? 0),
			0,
		);
	if (current.tracking === "untracked")
		return { mode, bucketId: current.bucketId, tracking: current.tracking, reserved };
	const catalogStock = current.catalogStock;
	if (catalogStock === undefined) fail("Tracked stock is missing", "catalogue_changed");
	return {
		mode,
		bucketId: current.bucketId,
		tracking: current.tracking,
		catalogStock,
		effectiveStock: bucket?.available ?? catalogStock,
		drift: bucket ? catalogStock - bucket.catalogStock : 0,
		reserved,
	};
}
function sameAvailability(a: InventoryAvailability, b: InventoryAvailability): boolean {
	return (
		a.mode === b.mode &&
		a.bucketId === b.bucketId &&
		a.tracking === b.tracking &&
		a.catalogStock === b.catalogStock &&
		a.effectiveStock === b.effectiveStock &&
		a.drift === b.drift &&
		a.reserved === b.reserved
	);
}
function expectedAvailabilityMatches(
	projection: InventoryProjection,
	requested: InventoryBucketLine[],
	expected: readonly InventoryAvailability[],
	mode: InventoryMode,
): boolean {
	if (!Array.isArray(expected) || expected.length !== requested.length) return false;
	const byBucket = new Map<string, InventoryAvailability>();
	for (const state of expected) {
		if (!state || typeof state.bucketId !== "string" || byBucket.has(state.bucketId)) return false;
		byBucket.set(state.bucketId, state);
	}
	return requested.every((line) => {
		const preview = byBucket.get(line.bucketId);
		return (
			preview !== undefined && sameAvailability(availabilityFor(projection, line, mode), preview)
		);
	});
}
/** Observable accounting for source/projection drift; callers can present this before explicit reconciliation. */
export async function readInventoryAvailability(
	ctx: PluginContext,
	line: InventoryRequestLine,
	mode?: InventoryMode,
): Promise<InventoryAvailability> {
	const resolvedMode = await resolveInventoryMode(ctx, mode);
	const current = (await validateInventoryLines(ctx, [line]))[0];
	if (!current) fail("Inventory line missing", "invalid_input");
	return mutateProjection(
		ctx,
		(projection) => availabilityFor(projection, current, resolvedMode),
		resolvedMode,
	);
}
/** Explicitly adopt raw CMS quantities as a new baseline while retaining active reservations. */
export async function reconcileInventory(
	ctx: PluginContext,
	lines: InventoryRequestLine[],
	expectedState?: readonly InventoryAvailability[],
	mode?: InventoryMode,
): Promise<void> {
	const resolvedMode = await resolveInventoryMode(ctx, mode);
	const requested = await validateInventoryLines(ctx, lines);
	await mutateProjection(
		ctx,
		(projection) => {
			// Expiry has already been applied by mutateProjection. Verify every
			// preview before changing any bucket, so failed UI adoption has no effect.
			if (
				expectedState !== undefined &&
				!expectedAvailabilityMatches(projection, requested, expectedState, resolvedMode)
			)
				fail("Inventory changed since it was previewed", "reconcile_conflict");
			for (const line of requested) {
				if (line.tracking === "untracked") {
					delete projection.buckets[line.bucketId];
					continue;
				}
				const catalogStock = line.catalogStock;
				if (catalogStock === undefined) fail("Tracked stock is missing", "catalogue_changed");
				const held = Object.values(projection.reservations)
					.filter((r) => r.status === "reserved")
					.reduce(
						(n, r) =>
							n + (r.lines.find((entry) => entry.bucketId === line.bucketId)?.quantity ?? 0),
						0,
					);
				if (line.tracking === "finite" && catalogStock < held)
					fail("CMS stock is below active reservations", "reconcile_conflict");
				projection.buckets[line.bucketId] = {
					productId: line.productId,
					...(line.variantId ? { variantId: line.variantId } : {}),
					catalogStock,
					available: catalogStock - held,
					tracking: line.tracking,
				};
			}
		},
		resolvedMode,
	);
}
