import { describe, expect, it } from "bun:test";
import { recalculate } from "../src/cart/calculate";
import { resolveDiscount } from "../src/coupons/validate";
import { money, zero } from "../src/money";
import { buildHostedCheckoutLineItems } from "../src/routes/checkout";
import type { CartLineItem, CartState, Coupon } from "../src/types";

function line(id: string, amount: number): CartLineItem {
	return {
		lineId: id,
		productId: id,
		quantity: 1,
		unitPrice: money("USD", amount),
		lineSubtotal: money("USD", amount),
		title: id,
		isDigital: true,
	};
}

it("sends exact non-negative largest-remainder Stripe hosted line amounts", () => {
	const cart: CartState = {
		sessionId: "synthetic",
		currency: "USD",
		items: [line("a", 10_000), line("b", 10_000), line("c", 1)],
		coupons: [],
		taxLines: [],
		subtotal: money("USD", 20_001),
		discountTotal: zero("USD"),
		shippingTotal: zero("USD"),
		taxTotal: zero("USD"),
		total: money("USD", 20_001),
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
	const coupon: Coupon = {
		id: "fixed",
		code: "FIXED",
		discountType: "fixed_cart",
		discountValue: 10_002,
		currency: "USD",
		status: "active",
		excludeSaleItems: false,
		usageCount: 0,
		individualUse: false,
		createdAt: cart.createdAt,
		updatedAt: cart.updatedAt,
	};
	const priced = recalculate({ ...cart, coupons: [resolveDiscount(coupon, cart)] });
	const stripeLines = buildHostedCheckoutLineItems(priced, false);
	expect(stripeLines.map((item) => item.amount)).toEqual([4_999, 4_999, 1]);
	expect(stripeLines.reduce((total, item) => total + item.amount * item.quantity, 0)).toBe(9_999);
	expect(stripeLines.every((item) => item.amount >= 0)).toBe(true);
});
