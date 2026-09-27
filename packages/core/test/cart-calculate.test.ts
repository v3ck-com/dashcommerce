import { describe, expect, it } from "bun:test";
import { recalculate } from "../src/cart/calculate";
import { money, zero } from "../src/money";
import type { CartLineItem, CartState } from "../src/types";

function line(productId: string, qty: number, unit: number): CartLineItem {
	return {
		lineId: `l-${productId}`,
		productId,
		quantity: qty,
		unitPrice: money("USD", unit),
		lineSubtotal: money("USD", unit * qty),
		title: productId,
		isDigital: false,
	};
}

function baseCart(items: CartLineItem[] = []): CartState {
	return {
		sessionId: "sess",
		currency: "USD",
		items,
		coupons: [],
		taxLines: [],
		subtotal: zero("USD"),
		discountTotal: zero("USD"),
		shippingTotal: zero("USD"),
		taxTotal: zero("USD"),
		total: zero("USD"),
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

describe("cart recalculate", () => {
	it("computes zero totals on empty cart", () => {
		const result = recalculate(baseCart());
		expect(result.subtotal.amount).toBe(0);
		expect(result.total.amount).toBe(0);
	});

	it("sums line subtotals into cart subtotal", () => {
		const result = recalculate(baseCart([line("a", 2, 1000), line("b", 1, 500)]));
		expect(result.subtotal.amount).toBe(2500);
		expect(result.total.amount).toBe(2500);
	});

	it("applies flat percentage tax to post-discount subtotal", () => {
		const cart = {
			...baseCart([line("a", 1, 10_000)]),
			coupons: [{ code: "SAVE", discountAmount: money("USD", 1_000), freeShipping: false }],
		};
		const result = recalculate(cart, { taxMode: "flat", flatTaxPercent: 10 });
		expect(result.discountTotal.amount).toBe(1_000);
		expect(result.taxTotal.amount).toBe(900); // 10% of 9000
		expect(result.total.amount).toBe(9_900);
	});

	it("optionally applies tax to shipping", () => {
		const cart = {
			...baseCart([line("a", 1, 10_000)]),
			shippingMethod: {
				id: "flat",
				label: "Flat",
				amount: money("USD", 500),
			},
		};
		const noShipTax = recalculate(cart, {
			taxMode: "flat",
			flatTaxPercent: 10,
			taxAppliesToShipping: false,
		});
		expect(noShipTax.taxTotal.amount).toBe(1_000);
		const withShipTax = recalculate(cart, {
			taxMode: "flat",
			flatTaxPercent: 10,
			taxAppliesToShipping: true,
		});
		expect(withShipTax.taxTotal.amount).toBe(1_050);
	});

	it("uses table rates that explicitly apply to shipping", () => {
		const cart = {
			...baseCart([line("a", 1, 10_000)]),
			shippingMethod: { id: "flat", label: "Flat", amount: money("USD", 500) },
		};
		const result = recalculate(cart, {
			taxMode: "table",
			taxResolver: ({ base }) => [{ label: "Goods", amount: money(base.currency, 700), rate: 7 }],
			shippingTaxResolver: ({ base }) => [
				{ label: "Shipping", amount: money(base.currency, 25), rate: 5 },
			],
		});
		expect(result.taxTotal.amount).toBe(725);
		expect(result.total.amount).toBe(11_225);
	});

	it("clamps negative totals to zero (over-discounted cart)", () => {
		const cart = {
			...baseCart([line("a", 1, 500)]),
			coupons: [{ code: "BIG", discountAmount: money("USD", 1_000), freeShipping: false }],
		};
		const result = recalculate(cart);
		expect(result.total.amount).toBe(0);
	});

	it("keeps a product coupon on its eligible tax class", () => {
		const zeroRated = { ...line("zero", 1, 1_000), taxClass: "zero" };
		const standard = { ...line("standard", 1, 1_000), taxClass: "standard" };
		const result = recalculate(
			{
				...baseCart([zeroRated, standard]),
				coupons: [
					{
						code: "ZEROONLY",
						discountAmount: money("USD", 1_000),
						freeShipping: false,
						lineDiscounts: {
							"l-zero": money("USD", 1_000),
							"l-standard": money("USD", 0),
						},
					},
				],
			},
			{
				taxMode: "table",
				taxResolver: ({ base, taxClass }) => [
					{
						label: taxClass ?? "standard",
						amount: money(base.currency, taxClass === "standard" ? base.amount / 10 : 0),
					},
				],
			},
		);
		expect(result.taxTotal.amount).toBe(100);
		expect(result.items[0]?.taxAmount?.amount).toBe(0);
		expect(result.items[1]?.taxAmount?.amount).toBe(100);
	});

	it("passes tax lines through from resolver (table mode)", () => {
		const cart = baseCart([line("a", 1, 10_000)]);
		const result = recalculate(cart, {
			taxMode: "table",
			taxResolver: ({ base }) => [
				{ label: "State", amount: money(base.currency, 600), rate: 6 },
				{ label: "City", amount: money(base.currency, 200), rate: 2 },
			],
		});
		expect(result.taxLines.length).toBe(2);
		expect(result.taxTotal.amount).toBe(800);
		expect(result.total.amount).toBe(10_800);
	});
});
