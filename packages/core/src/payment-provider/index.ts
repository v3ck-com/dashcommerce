import type { PluginContext } from "emdash";
import { type PaymentAttempt, type PaystackMode, attemptMode, paystackKey } from "./paystack-test";
import { PaymentProviderError } from "./types";

/** Resolve by the stored attempt's mode, never the currently selected UI provider. */
export async function resolvePaystackKey(
	ctx: PluginContext,
	attempt: Pick<PaymentAttempt, "mode" | "provider"> | PaystackMode,
): Promise<string> {
	const mode = typeof attempt === "string" ? attempt : attemptMode(attempt as PaymentAttempt);
	return paystackKey(
		mode,
		mode === "test"
			? ((await ctx.kv.get<string>("settings:paystackTestSecretKey")) ??
					(await ctx.kv.get<string>("settings:paystackSecretKey")))
			: await ctx.kv.get<string>("settings:paystackLiveSecretKey"),
	);
}

/** Unset preserves Stripe; compatibility alias always forces test. */
export async function getHostedCheckoutProvider(
	ctx: PluginContext,
): Promise<{ id: "paystack" | "paystack-test"; mode: PaystackMode; secretKey: string } | null> {
	const selected = await ctx.kv.get<string>("settings:paymentProvider");
	if (selected === null || selected === undefined || selected === "stripe") return null;
	if (selected !== "paystack" && selected !== "paystack-test")
		throw new PaymentProviderError("Unsupported payment provider", { status: 503 });
	const configured = (await ctx.kv.get<string>("settings:paystackMode")) ?? "test";
	if (configured !== "test" && configured !== "live")
		throw new PaymentProviderError("Invalid Paystack mode", { status: 503 });
	const mode = selected === "paystack-test" ? "test" : configured;
	return { id: selected, mode, secretKey: await resolvePaystackKey(ctx, mode) };
}
export { PaymentProviderError } from "./types";
