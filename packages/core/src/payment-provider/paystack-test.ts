import type { PluginContext, StorageCollection } from "emdash";
import { validAddress, validEmail } from "../cart/validation";
import { releaseInventoryReservation, reserveInventory } from "../inventory";
import { reserveCouponClaims, releaseCouponClaims } from "../coupons/reservations";
import type { CartState, StockLockEntry } from "../types";
import { digest, insertOnce, mutate } from "../util/conditional";
import { randomId } from "../util/ids";
import { PaymentProviderError } from "./types";

const BASE = "https://api.paystack.co";
export type PaystackMode = "test" | "live";
export function attemptMode(a: PaymentAttempt): PaystackMode {
	if (a.mode !== undefined && a.mode !== "test" && a.mode !== "live")
		throw fail("Invalid stored Paystack mode", 409);
	return a.mode ?? "test";
}
export function attemptProvider(a: PaymentAttempt): "paystack" | "paystack-test" {
	if (a.provider !== undefined && a.provider !== "paystack" && a.provider !== "paystack-test")
		throw fail("Invalid stored Paystack provider", 409);
	return a.provider ?? "paystack-test";
}
export function paystackKey(mode: PaystackMode, key: unknown): string {
	if (mode !== "test" && mode !== "live") throw fail("Invalid Paystack mode", 409);
	if (typeof key !== "string" || !new RegExp(`^sk_${mode}_[A-Za-z0-9]+$`).test(key))
		throw fail(`Paystack ${mode} secret key required`, 503);
	return key;
}
const fail = (message: string, status = 400) => new PaymentProviderError(message, { status });
export interface PaymentAttempt {
	id: string;
	reference: string;
	orderDraftId: string;
	/** Absent only on pre-migration attempts; absence unconditionally means test. */
	mode?: PaystackMode;
	provider?: "paystack" | "paystack-test";
	accessCode?: string;
	url?: string;
	phase: "prepared" | "initializing" | "initialized";
	outcome?: "pending" | "failed" | "manual_review" | "verified";
	failureReleased?: boolean;
	reconciliationError?: { at: string; message: string };
	cart: CartState;
	inventoryLines: StockLockEntry[];
	amount: number;
	currency: CartState["currency"];
	email: string;
	createdAt: string;
}
export function attempts(ctx: PluginContext): StorageCollection<PaymentAttempt> {
	return (ctx.storage as unknown as { payment_attempts: StorageCollection<PaymentAttempt> })
		.payment_attempts;
}
export async function attemptForDraft(ctx: PluginContext, draft: string) {
	if (!/^[a-f0-9]{32}$/.test(draft)) return undefined;
	return (await attempts(ctx).get(draft)) ?? undefined;
}
export async function attemptForReference(ctx: PluginContext, ref: string) {
	if (!/^dc_[a-f0-9]{32}$/.test(ref)) return undefined;
	const attempt = await attemptForDraft(ctx, ref.slice(3));
	return attempt?.reference === ref ? attempt : undefined;
}
export function testKey(key: unknown): asserts key is string {
	paystackKey("test", key);
}
async function call(
	ctx: PluginContext,
	key: string,
	path: string,
	init: RequestInit,
	mode: PaystackMode = "test",
): Promise<Record<string, any>> {
	paystackKey(mode, key);
	if (!ctx.http) throw fail("Sandbox HTTP transport unavailable", 503);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await ctx.http.fetch(`${BASE}${path}`, {
			...init,
			headers: { Authorization: `Bearer ${key}`, ...init.headers },
			redirect: "error",
			signal: controller.signal,
		});
		if (!res.ok) throw fail("Paystack request failed", 502);
		const text = await res.text();
		if (text.length > 65536) throw fail("Paystack response too large", 502);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw fail("Invalid Paystack response", 502);
		}
		if (
			!body ||
			typeof body !== "object" ||
			(body as any).status !== true ||
			!((body as any).data && typeof (body as any).data === "object")
		)
			throw fail("Unsuccessful Paystack response", 502);
		return (body as any).data;
	} catch (e) {
		if (e instanceof PaymentProviderError) throw e;
		throw fail("Paystack transport failed", 502);
	} finally {
		clearTimeout(timer);
	}
}
export function validateCart(cart: CartState): asserts cart is CartState {
	if (
		!["GHS", "KES", "NGN", "USD", "ZAR"].includes(cart.currency) ||
		cart.total.currency !== cart.currency ||
		!Number.isSafeInteger(cart.total.amount) ||
		cart.total.amount <= 0
	)
		throw fail("Paystack checkout requires a positive supported-currency total");
	if (!validEmail(cart.customerEmail)) throw fail("Valid customer email required");
	if (!validAddress(cart.billingAddress) || !validAddress(cart.shippingAddress))
		throw fail("Full physical billing and shipping addresses required");
	if (
		!cart.items.length ||
		cart.items.some(
			(i) =>
				!Number.isSafeInteger(i.quantity) ||
				i.quantity < 1 ||
				!Number.isSafeInteger(i.unitPrice.amount) ||
				i.unitPrice.amount < 0 ||
				i.unitPrice.currency !== cart.currency ||
				!Number.isSafeInteger(i.lineSubtotal.amount) ||
				i.lineSubtotal.amount < 0,
		)
	)
		throw fail("Invalid checkout line");
	if (cart.items.some((i) => i.subscriptionConfig || i.vendorId))
		throw fail("Subscriptions and vendor splits unsupported", 501);
}
export async function initialize(
	ctx: PluginContext,
	key: string,
	input: {
		orderDraftId: string;
		cart: CartState;
		callbackUrl: string;
		mode?: PaystackMode;
		provider?: "paystack" | "paystack-test";
	},
) {
	const mode = input.mode ?? "test";
	const provider = input.provider ?? "paystack-test";
	paystackKey(mode, key);
	validateCart(input.cart);
	let callback: URL;
	try {
		callback = new URL(input.callbackUrl);
	} catch {
		throw fail("Invalid checkout callback URL");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
	if (
		(callback.protocol !== "https:" &&
			!(mode === "test" && loopback && callback.protocol === "http:")) ||
		callback.username ||
		callback.password ||
		callback.hash ||
		!callback.hostname ||
		(callback.port && !loopback)
	)
		throw fail("Invalid checkout callback URL");
	const reference = `dc_${input.orderDraftId}`;
	const metadata = { orderDraftId: input.orderDraftId, provider, ...(input.mode ? { mode } : {}) };
	const data = await call(
		ctx,
		key,
		"/transaction/initialize",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: input.cart.customerEmail,
				amount: input.cart.total.amount,
				currency: input.cart.currency,
				reference,
				callback_url: input.callbackUrl,
				metadata,
			}),
		},
		mode,
	);
	let url: URL;
	try {
		url = new URL(data.authorization_url);
	} catch {
		throw fail("Invalid Paystack checkout URL", 502);
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "checkout.paystack.com" ||
		url.port ||
		url.username ||
		url.password ||
		!/^https:\/\/checkout\.paystack\.com\//.test(url.href) ||
		typeof data.access_code !== "string" ||
		!data.access_code ||
		data.reference !== reference
	)
		throw fail("Invalid Paystack checkout response", 502);
	return {
		provider,
		url: url.href,
		accessCode: data.access_code as string,
		reference,
		orderDraftId: input.orderDraftId,
		total: input.cart.total,
		currency: input.cart.currency,
		mode,
	};
}
export interface PaystackRefund {
	id: number;
	status: string;
	amount: number;
	currency: string;
	domain: PaystackMode;
	transaction: number | { id?: number; reference: string; domain?: string; currency?: string };
	transaction_reference?: string;
	merchant_note?: string | null;
}
export interface PaystackRefundInput {
	reference: string;
	amount?: number;
	currency?: string;
	customerNote?: string;
	merchantNote?: string;
}
function validateRefund(
	data: Record<string, any>,
	mode: PaystackMode,
	reference?: string,
	input?: PaystackRefundInput,
): PaystackRefund {
	const transactionRef =
		typeof data.transaction === "object" ? data.transaction?.reference : data.transaction_reference;
	if (
		!Number.isSafeInteger(data.id) ||
		data.id <= 0 ||
		!Number.isSafeInteger(data.amount) ||
		data.amount <= 0 ||
		typeof data.status !== "string" ||
		!data.status ||
		typeof data.currency !== "string" ||
		!["GHS", "KES", "NGN", "USD", "ZAR"].includes(data.currency) ||
		data.domain !== mode ||
		(data.merchant_note !== undefined &&
			data.merchant_note !== null &&
			typeof data.merchant_note !== "string") ||
		typeof transactionRef !== "string" ||
		!transactionRef ||
		!(
			Number.isSafeInteger(data.transaction) ||
			(data.transaction !== null && typeof data.transaction === "object")
		) ||
		(reference !== undefined && transactionRef !== reference) ||
		(input?.amount !== undefined && data.amount !== input.amount) ||
		(input?.currency !== undefined && data.currency !== input.currency) ||
		(data.transaction &&
			typeof data.transaction === "object" &&
			data.transaction.domain !== undefined &&
			data.transaction.domain !== mode)
	)
		throw fail("Paystack refund response mismatch", 409);
	return data as PaystackRefund;
}
/** Single financial POST: caller MUST persist a durable claim before invoking and must
 * reconcile an ambiguous response via GET/list/operator, never repeat the POST. */
export async function createPaystackRefund(
	ctx: PluginContext,
	key: string,
	input: PaystackRefundInput,
	mode: PaystackMode,
): Promise<PaystackRefund> {
	paystackKey(mode, key);
	if (
		!/^dc_[a-f0-9]{32}$/.test(input.reference) ||
		(input.amount !== undefined && (!Number.isSafeInteger(input.amount) || input.amount <= 0)) ||
		(input.currency !== undefined &&
			!["GHS", "KES", "NGN", "USD", "ZAR"].includes(input.currency)) ||
		[input.customerNote, input.merchantNote].some(
			(n) => n !== undefined && (typeof n !== "string" || n.length > 2000),
		)
	)
		throw fail("Invalid Paystack refund request");
	const data = await call(
		ctx,
		key,
		"/refund",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				transaction: input.reference,
				...(input.amount !== undefined ? { amount: input.amount } : {}),
				...(input.currency ? { currency: input.currency } : {}),
				...(input.customerNote ? { customer_note: input.customerNote } : {}),
				...(input.merchantNote ? { merchant_note: input.merchantNote } : {}),
			}),
		},
		mode,
	);
	return validateRefund(data, mode, input.reference, input);
}
/** Safe read-only reconciliation for a known Paystack refund id. */
export async function retrievePaystackRefund(
	ctx: PluginContext,
	key: string,
	id: number,
	mode: PaystackMode,
): Promise<PaystackRefund> {
	paystackKey(mode, key);
	if (!Number.isSafeInteger(id) || id <= 0) throw fail("Invalid Paystack refund id");
	const data = await call(ctx, key, `/refund/${id}`, { method: "GET" }, mode);
	if (data.id !== id) throw fail("Paystack refund id mismatch", 409);
	return validateRefund(data, mode);
}
export type VerificationStatus = "pending" | "failed" | "manual_review" | "verified";
export async function verify(
	ctx: PluginContext,
	key: string,
	attempt: PaymentAttempt,
): Promise<VerificationStatus> {
	if (!/^dc_[a-f0-9]{32}$/.test(attempt.reference)) throw fail("Invalid payment reference");
	const mode = attemptMode(attempt);
	const provider = attemptProvider(attempt);
	const data = await call(
		ctx,
		key,
		`/transaction/verify/${encodeURIComponent(attempt.reference)}`,
		{ method: "GET" },
		mode,
	);
	if (
		data.reference !== attempt.reference ||
		data.amount !== attempt.amount ||
		data.currency !== attempt.currency ||
		data.domain !== mode ||
		data.metadata?.orderDraftId !== attempt.orderDraftId ||
		data.metadata?.provider !== provider ||
		(attempt.mode !== undefined && data.metadata?.mode !== mode) ||
		(attempt.mode === undefined &&
			data.metadata?.mode !== undefined &&
			data.metadata.mode !== "test") ||
		!validEmail(data.customer?.email) ||
		data.customer.email.toLowerCase() !== attempt.email.toLowerCase()
	)
		throw fail("Payment verification mismatch", 409);
	if (data.status === "success") return "verified";
	if (["failed", "abandoned"].includes(data.status)) return "failed";
	if (["pending", "ongoing", "processing", "queued"].includes(data.status)) return "pending";
	return "manual_review";
}
/** Stable session + immutable server-priced snapshot identity. The random capability
 * is stored behind a private CAS index, never derived from public cart contents. */
export async function startCheckout(
	ctx: PluginContext,
	key: string,
	cart: CartState,
	inventoryLines: StockLockEntry[],
	siteUrl: string,
	selection: { mode: PaystackMode; provider: "paystack" | "paystack-test" } = {
		mode: "test",
		provider: "paystack-test",
	},
) {
	paystackKey(selection.mode, key);
	validateCart(cart);
	if (typeof ctx.kv.compareAndSet !== "function" || typeof ctx.kv.getVersioned !== "function")
		throw fail("Conditional KV required", 503);
	const { createdAt: _created, updatedAt: _updated, ...snapshot } = cart;
	const identity =
		selection.provider === "paystack-test"
			? `paystack-identity:${await digest(snapshot)}` // pre-migration retry identity
			: `paystack-identity:${selection.mode}:${selection.provider}:${await digest(snapshot)}`;
	let id: string | undefined;
	for (let n = 0; n < 20; n++) {
		const current = await ctx.kv.getVersioned<{ id: string }>(identity);
		if (current) {
			const prior = await attempts(ctx).get(current.value.id);
			if (!prior || prior.outcome !== "failed" || !prior.failureReleased) {
				id = current.value.id;
				break;
			}
		}
		const candidate = randomId();
		if (
			(await ctx.kv.compareAndSet(identity, current?.revision ?? null, { id: candidate })).applied
		) {
			id = candidate;
			break;
		}
	}
	if (!id) throw fail("Checkout is busy; retry", 409);
	let attempt = await insertOnce(attempts(ctx), id, {
		id,
		orderDraftId: id,
		reference: `dc_${id}`,
		phase: "prepared",
		mode: selection.mode,
		provider: selection.provider,
		cart,
		inventoryLines,
		amount: cart.total.amount,
		currency: cart.currency,
		email: cart.customerEmail!,
		createdAt: new Date().toISOString(),
	});
	const response = (a: PaymentAttempt) => ({
		provider: attemptProvider(a),
		mode: attemptMode(a),
		url: a.url!,
		reference: a.reference,
		orderDraftId: a.id,
		total: a.cart.total,
		currency: a.currency,
	});
	if (
		attempt.url &&
		attempt.phase === "initialized" &&
		!["failed", "manual_review"].includes(attempt.outcome ?? "")
	)
		return response(attempt);
	if (attempt.phase === "prepared") {
		await reserveCouponClaims(ctx, id, attempt.cart, attemptMode(attempt));
		if (attempt.inventoryLines.length)
			await reserveInventory(ctx, id, attempt.inventoryLines, { mode: attemptMode(attempt) });
		await ctx.kv.compareAndSet(`draft:${id}`, null, {
			cart: attempt.cart,
			createdAt: attempt.createdAt,
			ttlMs: 15 * 60 * 1000,
		});
		const current = await attempts(ctx).getVersioned(id);
		if (
			current?.value.phase === "prepared" &&
			(
				await attempts(ctx).compareAndSet(id, current.revision, {
					...current.value,
					phase: "initializing",
				})
			).applied
		) {
			// Never repeat this POST after any ambiguous response or interrupted write.
			try {
				const result = await initialize(ctx, key, {
					orderDraftId: id,
					cart: attempt.cart,
					callbackUrl: `${siteUrl}/thank-you/${id}`,
					mode: attempt.mode,
					provider: attempt.provider,
				});
				attempt = await mutate(attempts(ctx), id, (a) => ({
					...a,
					phase: "initialized",
					url: result.url,
					accessCode: result.accessCode,
				}));
				return response(attempt);
			} catch {
				throw new PaymentProviderError(
					"Checkout initialization uncertain; verify this draft or request manual review",
					{ status: 409, code: "initialization_uncertain", orderDraftId: id },
				);
			}
		}
	}
	// A concurrent initializer may just be finishing. Do not mint another reference.
	for (let n = 0; n < 20; n++) {
		attempt = (await attempts(ctx).get(id))!;
		if (
			attempt.phase === "initialized" &&
			attempt.url &&
			!["failed", "manual_review"].includes(attempt.outcome ?? "")
		)
			return response(attempt);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new PaymentProviderError(
		"Checkout initialization uncertain; verify this draft or request manual review",
		{ status: 409, code: "initialization_uncertain", orderDraftId: id },
	);
}

/** Persist verified success before any effects. Success is monotonic; a delayed
 * failure cannot undo it. A late success after release is finalized on hold. */
export async function reconcileAttempt(
	ctx: PluginContext,
	key: string,
	attempt: PaymentAttempt,
): Promise<PaymentAttempt> {
	const latest = (await attempts(ctx).get(attempt.id))!;
	if (latest.outcome === "verified") return latest;
	let status: VerificationStatus;
	try {
		status = await verify(ctx, key, latest);
	} catch (err) {
		if (!(err instanceof PaymentProviderError) || err.status !== 409) throw err;
		status = "manual_review";
	}
	let saved = await mutate(attempts(ctx), latest.id, (a) => {
		if (a.outcome === "verified") return a;
		if (status === "pending" && (a.outcome === "failed" || a.outcome === "manual_review")) return a;
		return { ...a, outcome: status };
	});
	if (saved.outcome === "failed" && !saved.failureReleased) {
		try {
			if (saved.inventoryLines.length)
				await releaseInventoryReservation(ctx, saved.id, attemptMode(saved));
		} catch (err) {
			// A success raced this release. Only ignore it if success is durable.
			if ((await attempts(ctx).get(saved.id))?.outcome !== "verified") throw err;
		}
		if ((await attempts(ctx).get(saved.id))?.outcome === "failed")
			await releaseCouponClaims(ctx, saved.id, saved.cart, attemptMode(saved));
		saved = await mutate(attempts(ctx), saved.id, (a) =>
			a.outcome === "failed" ? { ...a, failureReleased: true } : a,
		);
	}
	return saved;
}

export async function verifySignature(
	payload: Uint8Array,
	signature: string | null,
	secret: string,
	mode: PaystackMode = "test",
) {
	paystackKey(mode, secret);
	if (!signature || !/^[a-f0-9]{128}$/i.test(signature)) throw fail("Invalid Paystack signature");
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	const expected = new Uint8Array(
		await crypto.subtle.sign("HMAC", cryptoKey, new Uint8Array(payload)),
	);
	const given = Uint8Array.from(signature.match(/../g)!, (h) => Number.parseInt(h, 16));
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
	if (diff) throw fail("Invalid Paystack signature");
}
