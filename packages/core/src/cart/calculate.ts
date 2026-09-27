/**
 * Cart totals pipeline — pure functions, currency-aware.
 *
 * Discounts are retained per line. This is important for tax, hosted-payment
 * line amounts, and the order/refund snapshot: a cart-level total alone loses
 * the scope of a product coupon.
 */

import { add, money, mul, percent as pct, sub, sum, zero } from "../money";
import type { AppliedCoupon, CartLineItem, CartState, Money, TaxLine } from "../types";

export interface PricingPolicy {
	taxMode: "flat" | "table" | "stripe_tax";
	flatTaxPercent?: number;
	taxAppliesToShipping?: boolean;
	taxResolver?: (args: {
		base: Money;
		currency: string;
		shippingClassesInCart: string[];
		taxClass?: string;
	}) => TaxLine[];
	shippingTaxResolver?: (args: {
		base: Money;
		currency: string;
		shippingClassesInCart: string[];
		taxClass?: string;
	}) => TaxLine[];
}

export function lineSubtotal(item: CartLineItem): Money {
	return mul(item.unitPrice, item.quantity);
}

export function computeSubtotal(items: CartLineItem[], currency: string): Money {
	if (items.length === 0) return zero(currency);
	return sum(items.map(lineSubtotal), currency);
}

export function computeDiscountTotal(coupons: AppliedCoupon[], currency: string): Money {
	if (coupons.length === 0) return zero(currency);
	return sum(
		coupons.map((coupon) => coupon.discountAmount),
		currency,
	);
}

export function computeShippingTotal(cart: Pick<CartState, "shippingMethod" | "currency">): Money {
	return cart.shippingMethod?.amount ?? zero(cart.currency);
}

type AllocatableLine = { lineId: string; capacity: number };

/**
 * Allocate an integer amount by largest remainder. Ties use cart line order,
 * making retries reproducible. Every allocation is bounded by that line's
 * capacity, and the returned amounts always sum to the capped target.
 */
export function allocateDiscountAcrossLines(
	lines: AllocatableLine[],
	amount: number,
	currency: string,
): Record<string, Money> {
	const capacities = lines.map((line) => Math.max(0, Math.floor(line.capacity)));
	const totalCapacity = capacities.reduce((total, capacity) => total + capacity, 0);
	const target = Math.min(Math.max(0, Math.floor(amount)), totalCapacity);
	const allocated = capacities.map(() => 0);
	if (target > 0 && totalCapacity > 0) {
		let assigned = 0;
		const remainders = capacities.map((capacity, index) => {
			const numerator = target * capacity;
			const share = Math.floor(numerator / totalCapacity);
			allocated[index] = share;
			assigned += share;
			return { index, remainder: numerator % totalCapacity };
		});
		remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
		for (let i = 0; i < target - assigned; i++) {
			const index = remainders[i]!.index;
			allocated[index] = (allocated[index] ?? 0) + 1;
		}
	}
	return Object.fromEntries(
		lines.map((line, index) => [line.lineId, money(currency, allocated[index]!)]),
	);
}

function allocationTotal(allocation: Record<string, Money>, currency: string): number | null {
	let total = 0;
	for (const value of Object.values(allocation)) {
		if (value.currency !== currency || !Number.isSafeInteger(value.amount) || value.amount < 0)
			return null;
		total += value.amount;
		if (!Number.isSafeInteger(total)) return null;
	}
	return total;
}

function legacyAllocationIsUnambiguous(items: CartLineItem[]): boolean {
	// Older carts only retained an aggregate coupon total. It can be safely
	// replayed when all goods use one tax class; otherwise its product scope is
	// unknowable and must be refreshed by the authoritative checkout resolver.
	return new Set(items.map((line) => line.taxClass ?? "standard")).size <= 1;
}

/**
 * Normalize old and current coupon snapshots into bounded, per-line values.
 * Legacy aggregate snapshots are only replayed where their tax result is
 * unambiguous. Fresh coupon resolution always supplies `lineDiscounts`.
 */
export function normalizeCouponAllocations(
	items: CartLineItem[],
	coupons: AppliedCoupon[],
	currency: string,
): AppliedCoupon[] {
	const remaining = new Map(items.map((line) => [line.lineId, lineSubtotal(line).amount]));
	return coupons.map((coupon) => {
		const declared =
			coupon.discountAmount.currency === currency &&
			Number.isSafeInteger(coupon.discountAmount.amount) &&
			coupon.discountAmount.amount >= 0
				? coupon.discountAmount.amount
				: 0;
		let allocation: Record<string, Money>;
		const supplied = coupon.lineDiscounts;
		const suppliedTotal = supplied ? allocationTotal(supplied, currency) : null;
		const suppliedIsComplete =
			suppliedTotal === declared &&
			Object.keys(supplied ?? {}).every((lineId) => remaining.has(lineId));
		if (suppliedIsComplete && supplied) {
			allocation = {};
			for (const line of items) {
				const requested = supplied[line.lineId]?.amount ?? 0;
				const amount = Math.min(requested, remaining.get(line.lineId) ?? 0);
				allocation[line.lineId] = money(currency, amount);
				remaining.set(line.lineId, (remaining.get(line.lineId) ?? 0) - amount);
			}
		} else if (declared > 0 && legacyAllocationIsUnambiguous(items)) {
			allocation = allocateDiscountAcrossLines(
				items.map((line) => ({
					lineId: line.lineId,
					capacity: remaining.get(line.lineId) ?? 0,
				})),
				declared,
				currency,
			);
			for (const [lineId, value] of Object.entries(allocation))
				remaining.set(lineId, (remaining.get(lineId) ?? 0) - value.amount);
		} else {
			allocation = Object.fromEntries(items.map((line) => [line.lineId, zero(currency)]));
		}
		const total = allocationTotal(allocation, currency) ?? 0;
		return {
			...coupon,
			discountAmount: money(currency, total),
			lineDiscounts: allocation,
		};
	});
}

export function aggregateLineDiscounts(
	items: CartLineItem[],
	coupons: AppliedCoupon[],
	currency: string,
): Record<string, Money> {
	const totals = new Map(items.map((line) => [line.lineId, 0]));
	for (const coupon of normalizeCouponAllocations(items, coupons, currency)) {
		for (const [lineId, value] of Object.entries(coupon.lineDiscounts ?? {})) {
			totals.set(lineId, (totals.get(lineId) ?? 0) + value.amount);
		}
	}
	return Object.fromEntries(
		[...totals].map(([lineId, amount]) => [lineId, money(currency, amount)]),
	);
}

export function remainingLineBalances(cart: CartState): Record<string, number> {
	const discounts = aggregateLineDiscounts(cart.items, cart.coupons, cart.currency);
	return Object.fromEntries(
		cart.items.map((line) => [
			line.lineId,
			Math.max(0, lineSubtotal(line).amount - (discounts[line.lineId]?.amount ?? 0)),
		]),
	);
}

export function computeTax(
	taxableAmount: Money,
	shipping: Money,
	policy: PricingPolicy,
	items: CartLineItem[] = [],
	lineDiscounts: Record<string, Money> = {},
): { lines: TaxLine[]; total: Money; lineAmounts: Record<string, Money> } {
	const emptyLineAmounts = Object.fromEntries(
		items.map((line) => [line.lineId, zero(taxableAmount.currency)]),
	);
	if (taxableAmount.amount < 0)
		return { lines: [], total: zero(taxableAmount.currency), lineAmounts: emptyLineAmounts };
	const base = policy.taxAppliesToShipping ? add(taxableAmount, shipping) : taxableAmount;
	const taxableLines = items.map((line) => ({
		lineId: line.lineId,
		taxClass: line.taxClass ?? "standard",
		gross: lineSubtotal(line).amount,
		net: Math.max(0, lineSubtotal(line).amount - (lineDiscounts[line.lineId]?.amount ?? 0)),
	}));
	if (policy.taxMode === "flat") {
		const rate = policy.flatTaxPercent ?? 0;
		if (rate === 0) return { lines: [], total: zero(base.currency), lineAmounts: emptyLineAmounts };
		const amount = pct(base, rate);
		// Shipping tax is not an order-item tax. Preserve the aggregate flat-tax
		// rounding while assigning only its goods component to cart lines.
		const shippingTax = policy.taxAppliesToShipping ? pct(shipping, rate).amount : 0;
		const goodsTax = Math.max(0, amount.amount - shippingTax);
		return {
			lines: [{ label: "Sales tax", amount, rate }],
			total: amount,
			lineAmounts: allocateDiscountAcrossLines(
				taxableLines.map((line) => ({ lineId: line.lineId, capacity: line.net })),
				goodsTax,
				base.currency,
			),
		};
	}
	if (policy.taxMode === "table" && policy.taxResolver) {
		const groups = new Map<string, typeof taxableLines>();
		for (const line of taxableLines) {
			const group = groups.get(line.taxClass) ?? [];
			group.push(line);
			groups.set(line.taxClass, group);
		}
		if (groups.size === 0) groups.set("standard", []);
		const shippingClassesInCart = [
			...new Set(items.map((item) => item.shippingClassSlug).filter(Boolean)),
		] as string[];
		const lines: TaxLine[] = [];
		const lineAmounts = { ...emptyLineAmounts };
		for (const [taxClass, group] of groups) {
			const groupBase = group.reduce((total, line) => total + line.net, 0);
			const groupTaxLines = policy.taxResolver({
				base: money(taxableAmount.currency, groupBase),
				currency: taxableAmount.currency,
				shippingClassesInCart,
				taxClass,
			});
			lines.push(...groupTaxLines);
			const groupTax = groupTaxLines.reduce((total, line) => total + line.amount.amount, 0);
			Object.assign(
				lineAmounts,
				allocateDiscountAcrossLines(
					group.map((line) => ({ lineId: line.lineId, capacity: line.net })),
					groupTax,
					taxableAmount.currency,
				),
			);
		}
		if (shipping.amount > 0 && policy.shippingTaxResolver) {
			lines.push(
				...policy.shippingTaxResolver({
					base: shipping,
					currency: taxableAmount.currency,
					shippingClassesInCart,
					taxClass: "standard",
				}),
			);
		}
		const total = lines.length
			? sum(
					lines.map((line) => line.amount),
					taxableAmount.currency,
				)
			: zero(taxableAmount.currency);
		return { lines, total, lineAmounts };
	}
	return { lines: [], total: zero(base.currency), lineAmounts: emptyLineAmounts };
}

/** Recompute totals from the server-stamped item and coupon snapshot. */
export function recalculate(
	cart: CartState,
	policy: PricingPolicy = { taxMode: "flat" },
): CartState {
	const currency = cart.currency;
	const coupons = normalizeCouponAllocations(cart.items, cart.coupons, currency);
	const lineDiscounts = aggregateLineDiscounts(cart.items, coupons, currency);
	const subtotal = computeSubtotal(cart.items, currency);
	const discountTotal = computeDiscountTotal(coupons, currency);
	const taxable = sub(subtotal, discountTotal);
	const shippingTotal = computeShippingTotal(cart);
	const {
		lines,
		total: taxTotal,
		lineAmounts,
	} = computeTax(taxable, shippingTotal, policy, cart.items, lineDiscounts);
	const total = add(add(sub(subtotal, discountTotal), shippingTotal), taxTotal);
	return {
		...cart,
		items: cart.items.map((line) => ({
			...line,
			discountAmount: lineDiscounts[line.lineId] ?? zero(currency),
			taxAmount: lineAmounts[line.lineId] ?? zero(currency),
		})),
		coupons,
		subtotal,
		discountTotal,
		taxLines: lines,
		taxTotal,
		shippingTotal,
		total: money(currency, Math.max(0, total.amount)),
	};
}
