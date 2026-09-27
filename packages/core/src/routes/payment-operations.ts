import type { PluginContext, RouteContext, StorageCollection } from "emdash";
import {
	InventoryError,
	readInventoryAvailability,
	reconcileInventory,
	type InventoryAvailability,
} from "../inventory";
import { refundsStore } from "../orders/create";
import { finalizePaystack } from "../orders/paystack";
import { reconcileRefund } from "../orders/refund";
import { resolvePaystackKey } from "../payment-provider";
import { type PaymentAttempt, attempts, reconcileAttempt } from "../payment-provider/paystack-test";
import type { Refund } from "../types";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
	});
const context = (r: RouteContext, c?: PluginContext) => (c ?? r) as unknown as PluginContext;
const bounded = (value: string | null, fallback = 25) => {
	const n = value === null ? fallback : Number(value);
	return Number.isSafeInteger(n) && n >= 1 && n <= 100 ? n : null;
};
function body(input: unknown): Record<string, unknown> | null {
	return input && typeof input === "object" && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: null;
}
function store<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const value = (ctx.storage as unknown as Record<string, StorageCollection<T> | undefined>)[name];
	if (!value) throw new Error(`Storage collection ${name} unavailable`);
	return value;
}
function publicAttempt(a: PaymentAttempt, id: string) {
	return {
		id,
		provider: a.provider ?? "paystack-test",
		mode: a.mode ?? "test",
		phase: a.phase,
		outcome: a.outcome ?? "pending",
		amount: a.amount,
		currency: a.currency,
		createdAt: a.createdAt,
		reconciliationError: a.reconciliationError
			? { at: a.reconciliationError.at, message: "Reconciliation needs review" }
			: undefined,
	};
}
function publicRefund(r: Refund, id: string) {
	return {
		id,
		orderId: r.orderId,
		amount: r.amount,
		paymentProvider: r.paymentProvider,
		paymentMode: r.paymentMode,
		status: r.status,
		transportState: r.transportState,
		effectsFinalized: r.effectsFinalized,
		needsEffectRecovery: Boolean(r.requestId && r.status !== "pending" && !r.effectsFinalized),
		providerRefundId: r.providerRefundId,
		createdAt: r.createdAt,
	};
}
async function getPage<T>(req: Request, collection: StorageCollection<T>) {
	const url = new URL(req.url);
	const limit = bounded(url.searchParams.get("limit"));
	if (limit === null) return null;
	const cursor = url.searchParams.get("cursor") ?? undefined;
	if (cursor && cursor.length > 512) return null;
	return collection.query({ limit, ...(cursor ? { cursor } : {}) });
}
export const paymentOperationsRoutes = {
	"admin/payment-operations/attempts": {
		methods: ["GET"],
		handler: async (r: RouteContext, c?: PluginContext) => {
			const ctx = context(r, c);
			const page = await getPage(r.request, attempts(ctx));
			if (!page) return json({ error: "Invalid page bounds" }, 400);
			return json({
				items: page.items.map((row) =>
					publicAttempt({ ...row.data, id: row.id } as PaymentAttempt, row.id),
				),
				...(page.hasMore ? { cursor: page.cursor } : {}),
			});
		},
	},
	"admin/payment-operations/refunds": {
		methods: ["GET"],
		handler: async (r: RouteContext, c?: PluginContext) => {
			const ctx = context(r, c);
			const page = await getPage(r.request, refundsStore(ctx));
			if (!page) return json({ error: "Invalid page bounds" }, 400);
			return json({
				items: page.items.map((row) => publicRefund(row.data as Refund, row.id)),
				...(page.hasMore ? { cursor: page.cursor } : {}),
			});
		},
	},
	"admin/payment-operations/outbox": {
		methods: ["GET"],
		handler: async (r: RouteContext, c?: PluginContext) => {
			const ctx = context(r, c);
			const page = await getPage(r.request, store<Record<string, unknown>>(ctx, "commerce_outbox"));
			if (!page) return json({ error: "Invalid page bounds" }, 400);
			return json({
				items: page.items.map((row) => ({
					id: row.id,
					orderId: row.data.orderId,
					status: row.data.status,
					testMode: row.data.testMode,
					createdAt: row.data.createdAt,
					reviewRequired: ["sending", "uncertain"].includes(String(row.data.status)),
				})),
				...(page.hasMore ? { cursor: page.cursor } : {}),
			});
		},
	},
	"admin/payment-operations/reconcile-attempt": {
		methods: ["POST"],
		request: { body: "json", maxBytes: 4096 },
		handler: async (r: RouteContext, c?: PluginContext) => {
			const ctx = context(r, c);
			const input = body(r.input);
			const id = input?.attemptId;
			if (typeof id !== "string" || id.length > 128)
				return json({ error: "A valid attemptId is required" }, 400);
			const attempt = await attempts(ctx).get(id);
			if (!attempt) return json({ error: "Payment attempt not found" }, 404);
			if (attempt.phase === "prepared")
				return json(
					{ error: "Attempt was not initialized; no provider verification is available" },
					409,
				);
			if (attempt.outcome === "verified") {
				await finalizePaystack(ctx, { ...attempt, id });
				return json({
					status: "verified",
					message: "Provider verification succeeded; finalization was checked.",
				});
			}
			try {
				const verified = await reconcileAttempt(ctx, await resolvePaystackKey(ctx, attempt), {
					...attempt,
					id,
				});
				if (verified.outcome !== "verified")
					return json({
						status: verified.outcome ?? "pending",
						message: "Provider has not confirmed payment. No paid status was applied.",
					});
				await finalizePaystack(ctx, verified);
				return json({
					status: "verified",
					message: "Provider independently verified payment and shared finalization completed.",
				});
			} catch {
				return json(
					{
						error:
							"Independent provider verification failed; attempt remains unresolved for operator review.",
					},
					409,
				);
			}
		},
	},
	"admin/payment-operations/reconcile-refund": {
		methods: ["POST"],
		request: { body: "json", maxBytes: 4096 },
		handler: async (r: RouteContext, c?: PluginContext) => {
			const ctx = context(r, c);
			const input = body(r.input);
			const refundId = input?.refundId;
			const providerRefundId = input?.providerRefundId;
			if (
				typeof refundId !== "string" ||
				refundId.length > 128 ||
				typeof providerRefundId !== "string" ||
				providerRefundId.length > 128 ||
				!providerRefundId.trim()
			)
				return json({ error: "Refund request and provider refund IDs are required" }, 400);
			try {
				const persisted = await refundsStore(ctx).get(refundId);
				if (!persisted) return json({ error: "Refund request not found" }, 404);
				let stripeClient: { secretKey: string } | undefined;
				const localRecovery =
					persisted.requestId &&
					persisted.transportState === "confirmed" &&
					persisted.status !== "pending" &&
					persisted.providerRefundId === providerRefundId.trim();
				if (persisted.paymentProvider === "stripe" && !localRecovery) {
					const mode = persisted.paymentMode ?? "live";
					const secretKey = await ctx.kv.get<string>("settings:stripeSecretKey");
					if (!secretKey || !new RegExp(`^(sk|rk)_${mode}_`).test(secretKey))
						return json({ error: "Matching Stripe credentials are not configured" }, 409);
					stripeClient = { secretKey };
				}
				const refund = await reconcileRefund(ctx, refundId, providerRefundId.trim(), stripeClient);
				return json({
					status: refund.status,
					message:
						refund.status === "succeeded"
							? "Provider-confirmed refund recorded."
							: refund.status === "failed"
								? "Provider reports the refund failed; funds are not considered returned."
								: "Refund remains pending provider confirmation.",
					refund: publicRefund(refund, refund.id),
				});
			} catch {
				return json(
					{
						error:
							"Provider refund could not be matched to the persisted transaction, mode, amount and currency. No new refund was submitted.",
					},
					409,
				);
			}
		},
	},
	"admin/payment-operations/reconcile-inventory": {
		methods: ["POST"],
		request: { body: "json", maxBytes: 4096 },
		handler: async (r: RouteContext, c?: PluginContext) => {
			const ctx = context(r, c);
			const input = body(r.input);
			const productId = input?.productId;
			const variantId = input?.variantId;
			const expected = body(input?.expected);
			if (
				input?.confirm !== true ||
				typeof productId !== "string" ||
				!productId ||
				productId.length > 128 ||
				(variantId !== undefined &&
					(typeof variantId !== "string" || !variantId || variantId.length > 128)) ||
				!expected
			)
				return json(
					{ error: "Explicit confirmation and a fresh inventory preview are required" },
					400,
				);
			const line = {
				productId,
				...(typeof variantId === "string" ? { variantId } : {}),
				quantity: 1,
			};
			try {
				await reconcileInventory(ctx, [line], [expected as unknown as InventoryAvailability]);
				ctx.log.info("Inventory baseline explicitly reconciled", { productId, variantId });
				return json({ reconciled: true });
			} catch (error) {
				return json(
					{
						error:
							error instanceof InventoryError
								? error.message
								: "Inventory changed or cannot be reconciled; obtain a fresh preview",
					},
					409,
				);
			}
		},
	},
	"admin/payment-operations/inventory": {
		methods: ["GET"],
		handler: async (r: RouteContext, c?: PluginContext) => {
			const ctx = context(r, c);
			const params = new URL(r.request.url).searchParams;
			const productId = params.get("productId");
			const variantId = params.get("variantId") || undefined;
			if (!productId || productId.length > 128 || (variantId && variantId.length > 128))
				return json({ error: "Valid product and optional variant IDs are required" }, 400);
			const line = { productId, ...(variantId ? { variantId } : {}), quantity: 1 };
			try {
				return json({
					line,
					availability: await readInventoryAvailability(ctx, line),
					mutationAvailable: true,
					note: "Adoption deliberately replaces the available-stock baseline with current CMS quantities, less active reservations. Use only after an intentional stock count or replenishment, never as a refresh.",
				});
			} catch (error) {
				return json(
					{
						error:
							error instanceof InventoryError
								? error.message
								: "Inventory availability could not be read",
					},
					409,
				);
			}
		},
	},
};
