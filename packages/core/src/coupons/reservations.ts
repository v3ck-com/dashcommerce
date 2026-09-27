import type { PluginContext } from "emdash";
import type { CartState, Coupon, CouponUsage, Customer } from "../types";
import { collection, digest, insertOnce } from "../util/conditional";

const RETRIES = 20;
const MAX_HISTORY = 1000;
const MAX_TTL = 24 * 60 * 60_000;
type Claim = {
	draftId: string;
	identity: string;
	fingerprint: string;
	expiresAt: number;
	status: "pending" | "consumed" | "released";
	orderId?: string;
};
type QuotaCoupon = Coupon & {
	_quotaClaims?: Record<string, Claim>;
	_quotaCustomerCounts?: Record<string, number>;
	accountedOrderIds?: Record<string, true>;
};
type Mode = "live" | "test";
export class CouponQuotaConflict extends Error {
	readonly status = 409;
	constructor(message = "Coupon usage limit reached") {
		super(message);
		this.name = "CouponQuotaConflict";
	}
}
async function couponFor(
	ctx: PluginContext,
	code: string,
	couponId?: string,
): Promise<QuotaCoupon> {
	if (couponId) {
		const coupon = await collection<QuotaCoupon>(ctx, "coupons").get(couponId);
		if (!coupon) throw new CouponQuotaConflict(`Coupon ${code} no longer exists`);
		return { ...coupon, id: couponId };
	}
	const result = await collection<QuotaCoupon>(ctx, "coupons").query({
		where: { code: code.toUpperCase() },
		limit: 1,
	});
	const row = result.items[0];
	if (!row) throw new CouponQuotaConflict(`Coupon ${code} no longer exists`);
	return { ...row.data, id: row.id };
}
async function historyFor(ctx: PluginContext, coupon: Coupon, email: string): Promise<number> {
	const customer = (
		await collection<Customer>(ctx, "customers").query({ where: { email }, limit: 1 })
	).items[0];
	if (!customer) return 0;
	const history = await collection<CouponUsage>(ctx, "coupon_usage").query({
		where: { customerId: customer.id },
		limit: MAX_HISTORY + 1,
	});
	if (history.hasMore || history.items.length > MAX_HISTORY)
		throw new Error("Coupon usage history cannot be verified safely");
	const codes = new Set([coupon.code, ...(coupon.historicalCodes ?? [])]);
	return history.items.filter(
		(row) =>
			row.data.couponId === coupon.id ||
			row.id.startsWith(`${coupon.id}:`) ||
			(!row.data.couponId && codes.has(row.data.couponCode)),
	).length;
}
/** Prefer the accounting CAS counter; bounded history is only legacy hydration. */
export async function readCouponCustomerUsage(
	ctx: PluginContext,
	coupon: Coupon,
	email: string,
): Promise<number> {
	const normalized = email.trim().toLowerCase();
	const count = (coupon as QuotaCoupon)._quotaCustomerCounts?.[await digest(normalized)];
	if (count !== undefined) {
		if (!Number.isSafeInteger(count) || count < 0)
			throw new Error("Coupon customer usage cannot be verified safely");
		return count;
	}
	return historyFor(ctx, coupon, normalized);
}

async function fingerprint(cart: CartState, email: string): Promise<string> {
	// Binds a durable draft to the checkout intent, not just a mutable email address.
	return digest({ email, cart });
}
async function mutateCoupon(
	ctx: PluginContext,
	couponId: string,
	fn: (coupon: QuotaCoupon) => QuotaCoupon,
): Promise<QuotaCoupon> {
	const store = collection<QuotaCoupon>(ctx, "coupons");
	if (typeof store.getVersioned !== "function" || typeof store.compareAndSet !== "function")
		throw new Error("Conditional coupon storage required");
	for (let i = 0; i < RETRIES; i++) {
		const current = await store.getVersioned(couponId);
		if (!current) throw new CouponQuotaConflict("Coupon no longer exists");
		const next = fn({ ...current.value, id: couponId });
		if (next === current.value) return next;
		if ((await store.compareAndSet(couponId, current.revision, next)).applied) return next;
	}
	throw new Error("Coupon quota contention; retry");
}
async function claimCoupon(
	ctx: PluginContext,
	coupon: QuotaCoupon,
	draftId: string,
	identity: string,
	fingerprintValue: string,
	ttl: number,
	history: number,
): Promise<boolean> {
	let created = false;
	await mutateCoupon(ctx, coupon.id, (row) => {
		created = false;
		const now = Date.now();
		const claims = { ...(row._quotaClaims ?? {}) };
		const customerCounts = { ...(row._quotaCustomerCounts ?? {}) };
		if (customerCounts[identity] === undefined) customerCounts[identity] = history;
		for (const [id, c] of Object.entries(claims))
			if (c.status === "pending" && c.expiresAt <= now) delete claims[id];
		const prior = claims[draftId];
		if (prior) {
			if (prior.identity !== identity || prior.fingerprint !== fingerprintValue)
				throw new Error("Coupon draft identity/cart conflict");
			if (prior.status !== "released") return row;
			// A rejected preflight may be retried with the same immutable draft.
			// Financially initialized attempts do not re-enter this preparation API.
		}
		const pending = Object.values(claims).filter(
			(c) => c.status === "pending" && c.expiresAt > now,
		);
		if (row.usageLimit !== undefined && row.usageCount + pending.length >= row.usageLimit)
			throw new CouponQuotaConflict();
		if (
			row.usageLimitPerCustomer !== undefined &&
			(customerCounts[identity] ?? 0) + pending.filter((c) => c.identity === identity).length >=
				row.usageLimitPerCustomer
		)
			throw new CouponQuotaConflict("Coupon customer usage limit reached");
		claims[draftId] = {
			draftId,
			identity,
			fingerprint: fingerprintValue,
			expiresAt: now + ttl,
			status: "pending",
		};
		created = true;
		return { ...row, _quotaClaims: claims, _quotaCustomerCounts: customerCounts };
	});
	return created;
}
async function setReleased(ctx: PluginContext, coupon: Coupon, draftId: string): Promise<void> {
	await mutateCoupon(ctx, coupon.id, (row) => {
		const claim = row._quotaClaims?.[draftId];
		if (!claim || claim.status !== "pending") return row;
		return {
			...row,
			_quotaClaims: { ...row._quotaClaims, [draftId]: { ...claim, status: "released" } },
		};
	});
}
/** Reserve all limited coupons for a live durable draft before provider initialization. */
export async function reserveCouponClaims(
	ctx: PluginContext,
	draftId: string,
	cart: CartState,
	mode: Mode,
	options: { ttlMs?: number } = {},
): Promise<void> {
	if (mode === "test") return;
	const ttl = options.ttlMs ?? 15 * 60_000;
	if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TTL)
		throw new RangeError("Coupon claim TTL must be a positive integer no greater than 24 hours");
	if (!cart.coupons.length) return;
	const email = cart.customerEmail?.trim().toLowerCase() ?? "";
	const identity = email ? await digest(email) : `anonymous:${await digest(draftId)}`;
	const intent = await fingerprint(cart, email);
	const done: Array<{ coupon: Coupon; newlyClaimed: boolean }> = [];
	try {
		for (const applied of cart.coupons) {
			const coupon = await couponFor(ctx, applied.code, applied.couponId);
			if (coupon.usageLimit === undefined && coupon.usageLimitPerCustomer === undefined) continue;
			if (coupon.usageLimitPerCustomer !== undefined && !email)
				throw new CouponQuotaConflict("Enter your email before applying a customer-limited coupon");
			const history =
				email && coupon._quotaCustomerCounts?.[identity] === undefined
					? await historyFor(ctx, coupon, email)
					: 0;
			const newlyClaimed = await claimCoupon(ctx, coupon, draftId, identity, intent, ttl, history);
			done.push({ coupon, newlyClaimed });
		}
	} catch (error) {
		// Only clean up claims this attempt definitely introduced, and only known quota rejection.
		if (error instanceof CouponQuotaConflict)
			for (const { coupon, newlyClaimed } of done.reverse())
				if (newlyClaimed) await setReleased(ctx, coupon, draftId);
		throw error;
	}
}
export async function releaseCouponClaims(
	ctx: PluginContext,
	draftId: string,
	cart: CartState,
	mode: Mode,
): Promise<void> {
	if (mode === "test") return;
	for (const applied of cart.coupons) {
		try {
			await setReleased(ctx, await couponFor(ctx, applied.code, applied.couponId), draftId);
		} catch (error) {
			if (!(error instanceof CouponQuotaConflict)) throw error;
		}
	}
}
/** One coupon-row CAS commits claim conversion, native usage count, customer count, and idempotency marker. */
export async function consumeAndAccountCoupon(
	ctx: PluginContext,
	coupon: Coupon,
	draftId: string,
	orderId: string,
	customerId: string,
	discountAmount: CouponUsage["discountAmount"],
	createdAt: string,
): Promise<boolean> {
	const email = (await collection<Customer>(ctx, "customers").get(customerId))?.email
		?.trim()
		.toLowerCase();
	if (!email) throw new Error("Coupon customer identity cannot be verified");
	const emailIdentity = await digest(email);
	const prior = await collection<QuotaCoupon>(ctx, "coupons").get(coupon.id);
	const history =
		prior?._quotaCustomerCounts?.[emailIdentity] === undefined
			? await historyFor(ctx, coupon, email)
			: 0;
	let consumed = false;
	await mutateCoupon(ctx, coupon.id, (row) => {
		consumed = false; // A failed CAS must not carry acceptance into a later rejected retry.
		const accounted = row.accountedOrderIds ?? {};
		if (accounted[orderId]) {
			consumed = true;
			return row;
		}
		const claims = { ...(row._quotaClaims ?? {}) };
		const claim = claims[draftId];
		const limited = row.usageLimit !== undefined || row.usageLimitPerCustomer !== undefined;
		if (limited && (!claim || claim.status !== "pending" || claim.expiresAt <= Date.now()))
			return row;
		if (
			claim &&
			claim.status !== "pending" &&
			!(claim.status === "consumed" && claim.orderId === orderId)
		)
			return row;
		if (row.usageLimitPerCustomer !== undefined && claim?.identity !== emailIdentity) return row;
		const identity = emailIdentity;
		claims[draftId] = {
			...(claim ?? { draftId, identity, fingerprint: "legacy", expiresAt: 0 }),
			status: "consumed",
			orderId,
		};
		consumed = true;
		return {
			...row,
			usageCount: row.usageCount + 1,
			_quotaClaims: claims,
			_quotaCustomerCounts: {
				...row._quotaCustomerCounts,
				[identity]: (row._quotaCustomerCounts?.[identity] ?? history) + 1,
			},
			accountedOrderIds: { ...accounted, [orderId]: true },
			updatedAt: new Date().toISOString(),
		};
	});
	if (!consumed) return false;
	await insertCouponUsage(ctx, coupon, orderId, customerId, discountAmount, createdAt);
	return true;
}
export async function insertCouponUsage(
	ctx: PluginContext,
	coupon: Coupon,
	orderId: string,
	customerId: string,
	discountAmount: CouponUsage["discountAmount"],
	createdAt: string,
): Promise<void> {
	const id = `${coupon.id}:${orderId}`;
	await insertOnce(collection<CouponUsage>(ctx, "coupon_usage"), id, {
		id,
		dedupKey: `${coupon.code}:${orderId}`,
		couponCode: coupon.code,
		couponId: coupon.id,
		customerId,
		orderId,
		discountAmount,
		createdAt,
	});
}
