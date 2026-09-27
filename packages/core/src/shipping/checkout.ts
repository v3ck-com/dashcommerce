import type { PluginContext } from "emdash";
import type { CartState, ShippingMethod, ShippingZone } from "../types";
import { collection } from "../util/conditional";
import { calculateRates, pickZone } from "./calculate";
import { PaymentProviderError } from "../payment-provider/types";
import { validAddress } from "../cart/validation";
import { recalculate } from "../cart/calculate";

/** Recompute only supported rates and flat tax from authoritative settings. */
export async function priceTestShippingAndTax(
	ctx: PluginContext,
	cart: CartState,
): Promise<CartState> {
	const fail = (message: string, status = 409): never => {
		throw new PaymentProviderError(message, { status });
	};
	if (!validAddress(cart.billingAddress) || !validAddress(cart.shippingAddress))
		fail("Full physical billing and shipping addresses required", 400);
	if (cart.coupons.length) fail("Coupons unsupported", 501);
	const mode = (await ctx.kv.get("settings:taxMode")) ?? "flat";
	const rate = (await ctx.kv.get("settings:flatTaxRatePercent")) ?? 0;
	const shippingTax = (await ctx.kv.get("settings:taxAppliesToShipping")) ?? false;
	if (mode !== "flat") fail("Only flat tax is supported by Paystack test checkout", 501);
	if (
		typeof rate !== "number" ||
		!Number.isFinite(rate) ||
		rate < 0 ||
		rate > 100 ||
		typeof shippingTax !== "boolean"
	)
		fail("Invalid tax settings", 503);
	let shippingMethod: CartState["shippingMethod"];
	if (cart.items.some((line) => !line.isDigital)) {
		if (
			!cart.shippingMethod ||
			typeof cart.shippingMethod.id !== "string" ||
			cart.shippingMethod.id.length > 128
		)
			fail("Select a shipping method first");
		const zones = await collection<ShippingZone>(ctx, "shipping_zones").query({ limit: 200 });
		if (zones.hasMore) fail("Too many shipping zones to validate safely", 503);
		const zone = pickZone(
			cart.shippingAddress!,
			zones.items.map((r) => ({ ...r.data, id: r.id })),
		);
		const method = await collection<ShippingMethod>(ctx, "shipping_methods").get(
			cart.shippingMethod!.id,
		);
		if (
			!zone ||
			!method ||
			method.zoneId !== zone.id ||
			(method.enabled !== true && (method.enabled as unknown) !== 1)
		)
			fail("Shipping method no longer available for destination");
		const cfg = method!.config;
		if (!cfg || !["flat_rate", "free_shipping"].includes(cfg.type) || method!.type !== cfg.type)
			fail("Only flat/free shipping is supported", 501);
		if (
			(cfg.type === "flat_rate" &&
				cfg.shippingClassRates &&
				Object.keys(cfg.shippingClassRates).length) ||
			(cfg.type === "free_shipping" && cfg.requiresCoupon)
		)
			fail("Shipping class overrides and coupon-based shipping unsupported", 501);
		const amount =
			cfg.type === "flat_rate"
				? cfg.amount
				: cfg.type === "free_shipping"
					? cfg.minimumAmount
					: undefined;
		if (
			(cfg.type === "flat_rate" && !amount) ||
			(amount &&
				(amount.currency !== cart.currency ||
					!Number.isSafeInteger(amount.amount) ||
					amount.amount < 0))
		)
			fail("Invalid shipping amount", 503);
		const chosen = calculateRates({
			items: cart.items,
			currency: cart.currency,
			methods: [{ ...method!, id: cart.shippingMethod!.id }],
		})[0];
		if (!chosen) fail("Shipping method does not qualify");
		if (
			chosen!.amount.amount !== cart.shippingMethod!.amount.amount ||
			chosen!.amount.currency !== cart.shippingMethod!.amount.currency
		)
			fail("Shipping rate changed; select shipping again");
		shippingMethod = { id: chosen!.methodId, label: chosen!.label, amount: chosen!.amount };
	}
	return recalculate(
		{ ...cart, shippingMethod },
		{
			taxMode: "flat",
			flatTaxPercent: rate as number,
			taxAppliesToShipping: shippingTax as boolean,
		},
	);
}
