import type { PluginContext } from "emdash";
import { type PricingPolicy, recalculate } from "../cart/calculate";
import { validAddress } from "../cart/validation";
import { resolveDiscount, validateCoupon } from "../coupons/validate";
import { readCouponCustomerUsage } from "../coupons/reservations";
import { PaymentProviderError } from "../payment-provider/types";
import { selectApplicableRates, tableTaxLines } from "../tax/calculate";
import type {
	AppliedCoupon,
	CartState,
	Coupon,
	ShippingMethod,
	ShippingZone,
	TaxRate,
} from "../types";
import { collection } from "../util/conditional";
import { calculateRates, pickZone } from "./calculate";

function failure(message: string, status = 409): never {
	throw new PaymentProviderError(message, { status });
}

function validMoney(
	value: unknown,
	currency: string,
): value is { currency: string; amount: number } {
	return (
		!!value &&
		typeof value === "object" &&
		(value as { currency?: unknown }).currency === currency &&
		Number.isSafeInteger((value as { amount?: unknown }).amount) &&
		(value as { amount: number }).amount >= 0
	);
}

async function couponCategories(
	ctx: PluginContext,
	cart: CartState,
	coupon: Coupon,
): Promise<Record<string, string[]> | undefined> {
	if (!coupon.includedCategorySlugs?.length && !coupon.excludedCategorySlugs?.length)
		return undefined;
	if (!ctx.content) failure("Coupon category restrictions cannot be verified", 503);
	const categories: Record<string, string[]> = {};
	for (const productId of new Set(cart.items.map((item) => item.productId))) {
		const product = (await ctx.content.get("products", productId)) as {
			taxonomies?: Record<string, unknown>;
		} | null;
		const value = product?.taxonomies?.product_category;
		if (!Array.isArray(value) || value.some((slug) => typeof slug !== "string"))
			failure("Coupon category restrictions cannot be verified", 503);
		categories[productId] = value;
	}
	return categories;
}

async function couponUsageByCustomer(
	ctx: PluginContext,
	cart: CartState,
	coupon: Coupon,
): Promise<number | undefined> {
	if (coupon.usageLimitPerCustomer === undefined) return undefined;
	if (!cart.customerEmail) failure("Coupon customer usage cannot be verified", 409);
	return readCouponCustomerUsage(ctx, coupon, cart.customerEmail);
}

async function freshCoupons(ctx: PluginContext, cart: CartState): Promise<AppliedCoupon[]> {
	if (cart.coupons.length === 0) return [];
	const store = collection<Coupon>(ctx, "coupons");
	if (!store) failure("Coupon storage unavailable", 503);
	const applied: AppliedCoupon[] = [];
	for (const stale of cart.coupons) {
		const result = await store.query({ where: { code: stale.code.toUpperCase() }, limit: 1 });
		const row = result.items[0];
		if (!row) failure(`Coupon ${stale.code} is no longer available`);
		const coupon = { ...(row.data as Coupon), id: row.id };
		const productCategories = await couponCategories(ctx, cart, coupon);
		const usageByCustomer = await couponUsageByCustomer(ctx, cart, coupon);
		const pricingCart = { ...cart, coupons: applied };
		const check = validateCoupon(coupon, { cart: pricingCart, productCategories, usageByCustomer });
		if (!check.ok) failure(`Coupon ${coupon.code} no longer qualifies: ${check.reason}`);
		applied.push(resolveDiscount(coupon, pricingCart, productCategories));
	}
	if (applied.length > 1) {
		for (const appliedCoupon of applied) {
			const row = (
				await store.query({ where: { code: appliedCoupon.code.toUpperCase() }, limit: 1 })
			).items[0];
			if ((row?.data as Coupon | undefined)?.individualUse)
				failure(`Coupon ${appliedCoupon.code} cannot be combined with other coupons`);
		}
	}
	return applied;
}

async function freshShipping(
	ctx: PluginContext,
	cart: CartState,
): Promise<CartState["shippingMethod"]> {
	const physical = cart.items.some((line) => !line.isDigital);
	if (!physical) return undefined;
	if (!cart.shippingAddress) failure("Shipping address is required");
	if (!cart.shippingMethod?.id) failure("Select a shipping method first");
	const zonesStore = collection<ShippingZone>(ctx, "shipping_zones");
	const methodsStore = collection<ShippingMethod>(ctx, "shipping_methods");
	if (!zonesStore || !methodsStore) failure("Shipping configuration unavailable", 503);
	const zones = await zonesStore.query({ limit: 200 });
	if (zones.hasMore) failure("Too many shipping zones to validate safely", 503);
	const zone = pickZone(
		cart.shippingAddress,
		zones.items.map((row) => ({ ...row.data, id: row.id })),
	);
	if (!zone) failure("No shipping zone matches the address");
	const methods = await methodsStore.query({ limit: 200 });
	if (methods.hasMore) failure("Too many shipping methods to validate safely", 503);
	const options = calculateRates({
		items: cart.items,
		currency: cart.currency,
		methods: methods.items
			.map((row) => ({ ...row.data, id: row.id }))
			.filter(
				(method) =>
					method.zoneId === zone.id &&
					(method.enabled === true || (method.enabled as unknown) === 1),
			),
		couponsGiveFreeShipping: cart.coupons.some((coupon) => coupon.freeShipping),
	});
	const selected = options.find((option) => option.methodId === cart.shippingMethod?.id);
	if (!selected || !validMoney(selected.amount, cart.currency)) {
		failure("Shipping method no longer qualifies for this cart and destination");
	}
	return { id: selected.methodId, label: selected.label, amount: selected.amount };
}

async function pricingPolicy(ctx: PluginContext, cart: CartState): Promise<PricingPolicy> {
	const mode = (await ctx.kv.get<string>("settings:taxMode")) ?? "flat";
	const taxAppliesToShipping =
		(await ctx.kv.get<boolean>("settings:taxAppliesToShipping")) ?? false;
	if (mode === "stripe_tax") return { taxMode: "stripe_tax" };
	if (mode === "flat") {
		const rate = (await ctx.kv.get<unknown>("settings:flatTaxRatePercent")) ?? 0;
		if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 100) {
			failure("Invalid flat tax settings", 503);
		}
		return { taxMode: "flat", flatTaxPercent: rate, taxAppliesToShipping };
	}
	if (mode !== "table") failure("Invalid tax mode", 503);
	const destination = cart.shippingAddress ?? cart.billingAddress;
	if (!destination) failure("Address is required to calculate tax");
	const store = collection<TaxRate>(ctx, "tax_rates");
	if (!store) failure("Tax configuration unavailable", 503);
	const rows = await store.query({ limit: 500 });
	if (rows.hasMore) failure("Too many tax rates to validate safely", 503);
	const rates = rows.items.map((row) => ({ ...row.data, id: row.id }));
	const ratesFor = (taxClass: string) =>
		selectApplicableRates(rates, {
			country: destination.country,
			...(destination.region ? { region: destination.region } : {}),
			...(destination.postalCode ? { postalCode: destination.postalCode } : {}),
			taxClass,
		});
	return {
		taxMode: "table",
		// Goods are resolved by their server-stamped product class. Shipping
		// keeps the established standard lookup because it has no independent
		// class in the persisted shipping-method schema.
		taxResolver: ({ base, taxClass }) => tableTaxLines(base, ratesFor(taxClass ?? "standard")),
		shippingTaxResolver: ({ base }) =>
			tableTaxLines(
				base,
				ratesFor("standard").filter((rate) => rate.appliesToShipping),
			),
	};
}

/**
 * Build the one authoritative snapshot used by every hosted provider. It
 * deliberately re-reads merchant configuration: a cart is only a hint, never
 * authority for coupon eligibility, destination rates, or tax.
 */
export async function priceCheckout(ctx: PluginContext, cart: CartState): Promise<CartState> {
	// Stored cart totals are a UI cache. Coupon qualification and resolution
	// must instead use the freshly re-priced item subtotal.
	const base = { ...recalculate({ ...cart, coupons: [] }), coupons: cart.coupons };
	const coupons = await freshCoupons(ctx, base);
	const shippingMethod = await freshShipping(ctx, { ...base, coupons });
	const priced = { ...base, coupons, shippingMethod };
	return recalculate(priced, await pricingPolicy(ctx, priced));
}

/** @deprecated Compatibility name retained for integrations. */
export const priceTestShippingAndTax = priceCheckout;

/** Paystack cannot delegate tax calculation to Stripe Tax. */
export async function pricePaystackCheckout(
	ctx: PluginContext,
	cart: CartState,
): Promise<CartState> {
	if (!validAddress(cart.billingAddress) || !validAddress(cart.shippingAddress)) {
		failure("Full physical billing and shipping addresses required", 400);
	}
	if ((await ctx.kv.get<string>("settings:taxMode")) === "stripe_tax") {
		failure("Stripe Tax is unavailable with Paystack", 501);
	}
	return priceCheckout(ctx, cart);
}
