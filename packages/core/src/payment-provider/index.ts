import type { PluginContext } from "emdash";
import { PaymentProviderError } from "./types";
import { testKey } from "./paystack-test";

/** Explicit test-mode selection. Unset preserves the original Stripe path. */
export async function getHostedCheckoutProvider(
	ctx: PluginContext,
): Promise<{ id: "paystack-test" } | null> {
	const selected = await ctx.kv.get<string>("settings:paymentProvider");
	if (selected === null || selected === undefined || selected === "stripe") return null;
	if (selected !== "paystack-test")
		throw new PaymentProviderError("Unsupported provider; live and mock checkout disabled", {
			status: 503,
		});
	testKey(await ctx.kv.get<string>("settings:paystackSecretKey"));
	return { id: "paystack-test" };
}
export { PaymentProviderError } from "./types";
