/** Coupon validation + authoritative, per-line discount resolution. */

import { allocateDiscountAcrossLines, remainingLineBalances } from "../cart/calculate";
import { money, percent as pct, type Money, zero, CurrencyMismatchError } from "../money";
import type { AppliedCoupon, CartLineItem, CartState, Coupon, DiscountType } from "../types";

export interface CouponValidationContext {
	cart: CartState;
	/** Slugs of categories keyed by product ID. */
	productCategories?: Record<string, string[]>;
	/** Usage count for this coupon by this customer (0 for guest). */
	usageByCustomer?: number;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateCoupon(coupon: Coupon, ctx: CouponValidationContext): ValidationResult {
	const { cart } = ctx;
	if (coupon.status !== "active") return { ok: false, reason: "Coupon inactive." };

	const now = Date.now();
	if (coupon.startsAt && Date.parse(coupon.startsAt) > now)
		return { ok: false, reason: "Coupon not yet active." };
	if (coupon.endsAt && Date.parse(coupon.endsAt) < now)
		return { ok: false, reason: "Coupon expired." };
	if (
		(coupon.discountType === "fixed_cart" || coupon.discountType === "fixed_product") &&
		coupon.currency &&
		coupon.currency !== cart.currency
	) {
		return { ok: false, reason: `Coupon is in ${coupon.currency}; cart is in ${cart.currency}.` };
	}
	if (coupon.minAmount && cart.subtotal.amount < coupon.minAmount.amount)
		return { ok: false, reason: "Cart subtotal below coupon minimum." };
	if (coupon.maxAmount && cart.subtotal.amount > coupon.maxAmount.amount)
		return { ok: false, reason: "Cart subtotal above coupon maximum." };
	if (coupon.usageLimit !== undefined && coupon.usageCount >= coupon.usageLimit)
		return { ok: false, reason: "Coupon usage limit reached." };
	if (
		coupon.usageLimitPerCustomer !== undefined &&
		ctx.usageByCustomer !== undefined &&
		ctx.usageByCustomer >= coupon.usageLimitPerCustomer
	)
		return { ok: false, reason: "You have already used this coupon." };
	if (coupon.individualUse && cart.coupons.length > 0)
		return { ok: false, reason: "This coupon cannot be combined with others." };
	if (!coupon.individualUse && cart.coupons.some((applied) => applied.code === coupon.code))
		return { ok: false, reason: "Coupon already applied." };

	const hasExcludedItem = cart.items.some((item) =>
		itemExcluded(coupon, item, ctx.productCategories),
	);
	if (hasExcludedItem) return { ok: false, reason: "Coupon excludes an item in this cart." };

	if (
		hasProductFilter(coupon) &&
		!cart.items.some((item) => itemIncluded(coupon, item, ctx.productCategories))
	)
		return { ok: false, reason: "Coupon does not apply to any item in cart." };
	return { ok: true };
}

function hasProductFilter(coupon: Coupon): boolean {
	return Boolean(coupon.includedProductIds?.length || coupon.includedCategorySlugs?.length);
}

function itemExcluded(
	coupon: Coupon,
	item: CartLineItem,
	productCategories?: Record<string, string[]>,
): boolean {
	return (
		coupon.excludedProductIds?.includes(item.productId) === true ||
		(coupon.excludedCategorySlugs?.length !== undefined &&
			(productCategories?.[item.productId] ?? []).some((category) =>
				coupon.excludedCategorySlugs?.includes(category),
			))
	);
}

function itemIncluded(
	coupon: Coupon,
	item: CartLineItem,
	productCategories?: Record<string, string[]>,
): boolean {
	if (itemExcluded(coupon, item, productCategories)) return false;
	if (!hasProductFilter(coupon)) return true;
	return (
		coupon.includedProductIds?.includes(item.productId) === true ||
		(productCategories?.[item.productId] ?? []).some((category) =>
			coupon.includedCategorySlugs?.includes(category),
		)
	);
}

function subtotal(items: CartLineItem[], currency: string): Money {
	return money(
		currency,
		items.reduce((total, item) => total + item.lineSubtotal.amount, 0),
	);
}

/**
 * Resolve a coupon into its durable, per-line allocation. Product coupons use
 * only eligible product balances; cart coupons intentionally spread across the
 * entire remaining cart balance. Earlier coupons are never overdrawn.
 */
export function resolveDiscount(
	coupon: Coupon,
	cart: CartState,
	productCategories?: Record<string, string[]>,
): AppliedCoupon {
	const currency = cart.currency;
	if (
		(coupon.discountType === "fixed_cart" || coupon.discountType === "fixed_product") &&
		coupon.currency &&
		coupon.currency !== currency
	)
		throw new CurrencyMismatchError(coupon.currency, currency);

	const discountType: DiscountType = coupon.discountType;
	if (discountType === "free_shipping")
		return {
			code: coupon.code,
			couponId: coupon.id,
			discountAmount: zero(currency),
			freeShipping: true,
			lineDiscounts: {},
		};

	const productScoped = discountType === "percent_product" || discountType === "fixed_product";
	const eligible = productScoped
		? cart.items.filter((item) => itemIncluded(coupon, item, productCategories))
		: cart.items;
	const balances = remainingLineBalances(cart);
	const eligibleBalance = eligible.reduce(
		(total, item) => total + Math.max(0, balances[item.lineId] ?? 0),
		0,
	);
	const requested =
		discountType === "percent_cart" || discountType === "percent_product"
			? pct(money(currency, eligibleBalance), coupon.discountValue).amount
			: Math.min(coupon.discountValue, eligibleBalance);
	const lineDiscounts = allocateDiscountAcrossLines(
		eligible.map((item) => ({ lineId: item.lineId, capacity: balances[item.lineId] ?? 0 })),
		requested,
		currency,
	);
	const discountAmount = subtotal(
		eligible.map((item) => ({ ...item, lineSubtotal: lineDiscounts[item.lineId]! })),
		currency,
	);
	return {
		code: coupon.code,
		couponId: coupon.id,
		discountAmount,
		freeShipping: false,
		lineDiscounts,
	};
}
