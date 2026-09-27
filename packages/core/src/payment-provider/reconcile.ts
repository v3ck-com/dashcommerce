import type { PluginContext } from "emdash";
import { finalizePaystack } from "../orders/paystack";
import { mutate } from "../util/conditional";
import { resolvePaystackKey } from "./index";
import { type PaymentAttempt, attempts, reconcileAttempt } from "./paystack-test";

/** Scheduled recovery: no customer return/webhook required. One bounded page per run,
 * with a persisted cursor to prevent older stuck attempts from starving newer ones.
 * The finalizer is idempotent and repairs interrupted side effects. */
export async function reconcilePendingAttempts(
	ctx: PluginContext,
	limit = 25,
): Promise<{ examined: number; verified: number; errors: number; cursor?: string }> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new Error("Invalid reconciliation batch size");
	const cursorKey = "paystack:reconcile-cursor";
	const cursor = await ctx.kv.get<string>(cursorKey);
	const page = await attempts(ctx).query({ limit, ...(cursor ? { cursor } : {}) });
	let verified = 0;
	let errors = 0;
	for (const row of page.items) {
		const attempt = { ...row.data, id: row.id } as PaymentAttempt;
		if (attempt.phase === "prepared") continue; // No initialize POST was sent yet.
		try {
			const current =
				attempt.outcome === "verified"
					? attempt
					: await reconcileAttempt(ctx, await resolvePaystackKey(ctx, attempt), attempt);
			if (current.outcome === "verified") {
				await finalizePaystack(ctx, current);
				verified++;
			}
		} catch (err) {
			errors++;
			ctx.log.error("Paystack reconciliation deferred", {
				attemptId: attempt.id,
				error: err instanceof Error ? err.message : String(err),
			});
			await mutate(attempts(ctx), attempt.id, (a) => ({
				...a,
				reconciliationError: {
					at: new Date().toISOString(),
					message: err instanceof Error ? err.message : String(err),
				},
			}));
		}
	}
	await ctx.kv.set(cursorKey, page.hasMore && page.cursor ? page.cursor : "");
	return {
		examined: page.items.length,
		verified,
		errors,
		...(page.hasMore && page.cursor ? { cursor: page.cursor } : {}),
	};
}
