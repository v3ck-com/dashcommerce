/**
 * Compatibility facade for checkout's historical cart locks.
 *
 * Stock protection is no longer derived from a list of expiring lock records:
 * inventory/reservations owns the CAS-backed projection. These records only
 * link a draft to its reservation for legacy webhook cleanup.
 */

import type { PluginContext } from "emdash";
import type { StockLock } from "../types";
import {
	InventoryError,
	type InventoryMode,
	releaseInventoryReservation,
	reserveInventory,
	resolveInventoryMode,
	sumReservedInventory,
} from "../inventory/reservations";

const LOCK_PREFIX = "lock:";
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_CAS_RETRIES = 8;

export function lockKey(orderDraftId: string): string {
	return `${LOCK_PREFIX}${orderDraftId}`;
}

export function newLock(
	orderDraftId: string,
	sessionId: string,
	entries: StockLock["entries"],
	opts: { ttlMs?: number; stripePaymentIntentId?: string; mode?: InventoryMode } = {},
): StockLock {
	const now = Date.now();
	const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
	return {
		orderDraftId,
		sessionId,
		...(opts.mode !== undefined ? { mode: opts.mode } : {}),
		...(opts.stripePaymentIntentId ? { stripePaymentIntentId: opts.stripePaymentIntentId } : {}),
		entries,
		expiresAt: new Date(now + ttl).toISOString(),
		createdAt: new Date(now).toISOString(),
	};
}

/**
 * Reserve stock before recording the legacy draft link. The reservation is the
 * source of truth; a crash after it succeeds only leaves an expiring,
 * recoverable reservation and never an unprotected stock mutation.
 */
export async function createLock(ctx: PluginContext, lock: StockLock): Promise<void> {
	const prior = await getLock(ctx, lock.orderDraftId);
	const mode = prior ? (prior.mode ?? "test") : await resolveInventoryMode(ctx, lock.mode);
	if (lock.mode !== undefined && lock.mode !== mode) throw new Error("Stock lock mode conflict");
	// Capture once, including on retries after settings have changed.
	lock = { ...lock, mode };
	const ttlMs = Date.parse(lock.expiresAt) - Date.now();
	await reserveInventory(ctx, lock.orderDraftId, lock.entries, { ttlMs, mode });
	if (typeof ctx.kv.getVersioned !== "function" || typeof ctx.kv.compareAndSet !== "function") {
		throw new Error("EmDash conditional KV is required for stock locks");
	}
	for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
		const current = await ctx.kv.getVersioned<StockLock>(lockKey(lock.orderDraftId));
		if (current) {
			// Repeated checkout calls with the same draft are harmless. Do not
			// overwrite a different record after a read/modify/write race.
			if (
				current.value.orderDraftId === lock.orderDraftId &&
				(current.value.mode ?? "test") === mode
			)
				return;
			throw new Error("Stock lock key collision");
		}
		const write = await ctx.kv.compareAndSet(lockKey(lock.orderDraftId), null, lock);
		if (write.applied) return;
	}
	// Do not release here: another caller may have installed the same link
	// after our final failed CAS. The reservation's bounded expiry recovers it.
	throw new Error("Could not record stock lock; retry checkout");
}

export async function getLock(ctx: PluginContext, orderDraftId: string): Promise<StockLock | null> {
	return (await ctx.kv.get<StockLock>(lockKey(orderDraftId))) ?? null;
}

async function releaseReservationForLock(
	ctx: PluginContext,
	orderDraftId: string,
	mode: InventoryMode = "test",
) {
	try {
		return await releaseInventoryReservation(ctx, orderDraftId, mode);
	} catch (error) {
		// A successful payment may leave its legacy link for observability. Its
		// consumed reservation must remain immutable, but the stale link may be
		// cleaned up safely.
		if (error instanceof InventoryError && error.code === "reservation_consumed") return null;
		throw error;
	}
}

/** Conditional delete prevents an expiry/cleanup worker deleting a newer link. */
export async function deleteLock(ctx: PluginContext, orderDraftId: string): Promise<void> {
	await releaseAndDeleteLock(ctx, orderDraftId);
}

async function releaseAndDeleteLock(ctx: PluginContext, orderDraftId: string): Promise<boolean> {
	// Read the durable environment once before releasing; never consult settings.
	const existing =
		typeof ctx.kv.getVersioned === "function"
			? await ctx.kv.getVersioned<StockLock>(lockKey(orderDraftId))
			: null;
	const released = await releaseReservationForLock(
		ctx,
		orderDraftId,
		existing?.value.mode ?? "test",
	);
	if (existing && typeof ctx.kv.compareAndDelete === "function") {
		await ctx.kv.compareAndDelete(lockKey(orderDraftId), existing.revision);
	}
	return Boolean(existing || released);
}

/** List is informational only; it is not used to decide stock availability. */
export async function listActiveLocks(ctx: PluginContext): Promise<StockLock[]> {
	const now = Date.now();
	const rows = await ctx.kv.list(LOCK_PREFIX);
	return rows.flatMap((row) => {
		const lock = row.value as StockLock | null;
		return lock && Date.parse(lock.expiresAt) > now ? [lock] : [];
	});
}

/** CAS projection, rather than lock enumeration, is the availability source. */
export async function sumActiveLocksForProduct(
	ctx: PluginContext,
	productId: string,
	variantId?: string,
	mode?: InventoryMode,
): Promise<number> {
	return sumReservedInventory(ctx, productId, variantId, mode);
}

/** Release is idempotent and cannot mutate a consumed reservation. */
export async function releaseLock(ctx: PluginContext, orderDraftId: string): Promise<boolean> {
	return releaseAndDeleteLock(ctx, orderDraftId);
}

/**
 * Expiry transitions reservation state with CAS before conditionally removing
 * its convenience link. No blind delete can race a fresh lock write.
 */
export async function sweepExpiredLocks(ctx: PluginContext): Promise<number> {
	const now = Date.now();
	const rows = await ctx.kv.list(LOCK_PREFIX);
	let swept = 0;
	for (const row of rows) {
		const lock = row.value as StockLock | null;
		if (!lock || Date.parse(lock.expiresAt) > now) continue;
		const versioned =
			typeof ctx.kv.getVersioned === "function"
				? await ctx.kv.getVersioned<StockLock>(row.key)
				: null;
		if (!versioned || Date.parse(versioned.value.expiresAt) > now) continue;
		// Release the same version's environment that will be conditionally deleted.
		await releaseReservationForLock(
			ctx,
			versioned.value.orderDraftId,
			versioned.value.mode ?? "test",
		);
		if (typeof ctx.kv.compareAndDelete === "function") {
			const deleted = await ctx.kv.compareAndDelete(row.key, versioned.revision);
			if (deleted.applied) swept++;
		}
	}
	return swept;
}
