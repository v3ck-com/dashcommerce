/**
 * Cron handler — fires on each scheduled task matching our plugin.
 *
 * Tasks registered (via `plugin:install` in phase 17):
 *   - `sweep-stock-locks` every 5 min → release expired cart locks.
 *
 * Future (wired in later phases):
 *   - `dunning-retry` daily → phase 7 subscription retries
 *   - `abandoned-cart-recover` hourly → phase 11
 */

import type { PluginContext } from "emdash";
import { recoverAbandoned } from "../abandoned-cart/recover";
import { sweepExpiredLocks } from "../cart/lock";
import { reconcilePendingAttempts } from "../payment-provider/reconcile";
import { dispatchCommerceNotification } from "../orders/outbox";
import { reconcileRefund } from "../orders/refund";
import type { Refund } from "../types";
import type { StorageCollection } from "emdash";

/**
 * Minimal CronEvent shape — emdash's runtime type is not re-exported from
 * the package root. We model only the fields we read.
 */
export interface CronEvent {
	name: string;
	data?: Record<string, unknown>;
	scheduledAt: string;
}

export const SWEEP_STOCK_LOCKS = "sweep-stock-locks";
export const ABANDONED_CART_SCAN = "abandoned-cart-scan";
export const PAYMENT_OPERATIONS_SCAN = "payment-operations-scan";

function opsStore<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const value = (ctx.storage as unknown as Record<string, StorageCollection<T> | undefined>)[name];
	if (!value) throw new Error(`Storage collection ${name} unavailable`);
	return value;
}

/** One bounded page per collection and run. Cursors rotate through history; uncertain
 * notifications and refunds without provider IDs are never retried automatically. */
export async function runPaymentOperationsCron(ctx: PluginContext) {
	const payment = await reconcilePendingAttempts(ctx, 20);
	const refunds = opsStore<Refund>(ctx, "refunds");
	const cursor = await ctx.kv.get<string>("payment-ops:refund-cursor");
	const page = await refunds.query({ limit: 20, ...(cursor ? { cursor } : {}) });
	let refundChecks = 0;
	for (const row of page.items) {
		const refund = { ...row.data, id: row.id };
		const recoverEffects = Boolean(
			refund.requestId &&
				refund.transportState === "confirmed" &&
				refund.status !== "pending" &&
				!refund.effectsFinalized,
		);
		if ((refund.status !== "pending" && !recoverEffects) || !refund.providerRefundId) continue;
		try {
			let stripeClient: { secretKey: string } | undefined;
			if (refund.paymentProvider === "stripe" && !recoverEffects) {
				const secretKey = await ctx.kv.get<string>("settings:stripeSecretKey");
				if (!secretKey || !new RegExp(`^(sk|rk)_${refund.paymentMode ?? "live"}_`).test(secretKey))
					continue;
				stripeClient = { secretKey };
			}
			await reconcileRefund(ctx, refund.id, refund.providerRefundId, stripeClient);
			refundChecks++;
		} catch (error) {
			ctx.log.warn("Known refund reconciliation deferred", {
				refundId: refund.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	await ctx.kv.set("payment-ops:refund-cursor", page.hasMore && page.cursor ? page.cursor : "");
	const outbox = opsStore<{ status: string; testMode: boolean }>(ctx, "commerce_outbox");
	const outboxCursor = await ctx.kv.get<string>("payment-ops:outbox-cursor");
	const outboxPage = await outbox.query({
		limit: 20,
		...(outboxCursor ? { cursor: outboxCursor } : {}),
	});
	let dispatched = 0;
	if ((await ctx.kv.get<boolean>("settings:receiptEmailEnabled")) === true && ctx.email) {
		for (const row of outboxPage.items) {
			if (row.data.status !== "pending" || row.data.testMode === true) continue;
			try {
				await dispatchCommerceNotification(ctx, row.id, { allowDelivery: true });
				dispatched++;
			} catch (error) {
				ctx.log.warn("Notification handoff requires operator review", {
					notificationId: row.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	await ctx.kv.set(
		"payment-ops:outbox-cursor",
		outboxPage.hasMore && outboxPage.cursor ? outboxPage.cursor : "",
	);
	return { attempts: payment.examined, refunds: refundChecks, outbox: dispatched };
}

export async function cronHandler(event: CronEvent, ctx: PluginContext): Promise<void> {
	switch (event.name) {
		case SWEEP_STOCK_LOCKS: {
			const swept = await sweepExpiredLocks(ctx);
			if (swept > 0) {
				ctx.log.info(`Swept ${swept} expired stock lock(s)`, { task: event.name });
			}
			return;
		}
		case PAYMENT_OPERATIONS_SCAN: {
			const result = await runPaymentOperationsCron(ctx);
			ctx.log.info("Payment operations reconciliation completed", { task: event.name, ...result });
			return;
		}
		case ABANDONED_CART_SCAN: {
			const { sent, scanned } = await recoverAbandoned(ctx);
			if (sent > 0 || scanned > 0) {
				ctx.log.info(`Abandoned-cart scan: sent ${sent} of ${scanned}`, {
					task: event.name,
				});
			}
			return;
		}
		default:
			ctx.log.debug("Unhandled cron task", { name: event.name });
	}
}
