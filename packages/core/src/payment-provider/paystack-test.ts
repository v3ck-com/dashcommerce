import type { PluginContext, StorageCollection } from "emdash";
import type { CartState, StockLockEntry } from "../types";
import { validAddress, validEmail } from "../cart/validation";
import { digest, insertOnce, mutate } from "../util/conditional";
import { randomId } from "../util/ids";
import { reserveInventory, releaseInventoryReservation } from "../inventory";
import { PaymentProviderError } from "./types";

const BASE = "https://api.paystack.co";
const fail = (message: string, status = 400) => new PaymentProviderError(message, { status });
export interface PaymentAttempt {
	id: string;
	reference: string;
	orderDraftId: string;
	accessCode?: string;
	url?: string;
	phase: "prepared" | "initializing" | "initialized";
	outcome?: "pending" | "failed" | "manual_review" | "verified";
	failureReleased?: boolean;
	cart: CartState;
	inventoryLines: StockLockEntry[];
	amount: number;
	currency: "ZAR";
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
	if (typeof key !== "string" || !/^sk_test_[A-Za-z0-9]+$/.test(key))
		throw fail("Paystack test secret key required; live mode disabled", 503);
}
async function call(
	ctx: PluginContext,
	key: string,
	path: string,
	init: RequestInit,
): Promise<Record<string, any>> {
	testKey(key);
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
		cart.currency !== "ZAR" ||
		cart.total.currency !== "ZAR" ||
		!Number.isSafeInteger(cart.total.amount) ||
		cart.total.amount <= 0
	)
		throw fail("Paystack test checkout requires a positive ZAR total");
	if (!validEmail(cart.customerEmail)) throw fail("Valid customer email required");
	if (!validAddress(cart.billingAddress) || !validAddress(cart.shippingAddress))
		throw fail("Full physical billing and shipping addresses required");
	if (
		!cart.items.length ||
		cart.items.length > 100 ||
		cart.items.some(
			(i) =>
				!Number.isSafeInteger(i.quantity) ||
				i.quantity < 1 ||
				i.quantity > 1000 ||
				!Number.isSafeInteger(i.unitPrice.amount) ||
				i.unitPrice.amount < 0 ||
				i.unitPrice.currency !== "ZAR" ||
				!Number.isSafeInteger(i.lineSubtotal.amount) ||
				i.lineSubtotal.amount < 0,
		)
	)
		throw fail("Invalid checkout line");
	if (cart.coupons.length || cart.items.some((i) => i.subscriptionConfig || i.vendorId))
		throw fail("Coupons, subscriptions and vendor splits unsupported", 501);
	if (cart.shippingMethod && cart.shippingMethod.amount.amount !== cart.shippingTotal.amount)
		throw fail("Unsupported shipping pricing", 501);
}
export async function initialize(
	ctx: PluginContext,
	key: string,
	input: { orderDraftId: string; cart: CartState; callbackUrl: string },
) {
	testKey(key);
	validateCart(input.cart);
	let callback: URL;
	try {
		callback = new URL(input.callbackUrl);
	} catch {
		throw fail("Invalid checkout callback URL");
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
	if (
		(callback.protocol !== "https:" && !(loopback && callback.protocol === "http:")) ||
		callback.username ||
		callback.password ||
		callback.hash ||
		!callback.hostname ||
		(callback.port && !loopback)
	)
		throw fail("Invalid checkout callback URL");
	const reference = `dc_${input.orderDraftId}`;
	const metadata = { orderDraftId: input.orderDraftId, provider: "paystack-test" };
	const data = await call(ctx, key, "/transaction/initialize", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: input.cart.customerEmail,
			amount: input.cart.total.amount,
			currency: "ZAR",
			reference,
			callback_url: input.callbackUrl,
			metadata,
		}),
	});
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
		provider: "paystack-test" as const,
		url: url.href,
		accessCode: data.access_code as string,
		reference,
		orderDraftId: input.orderDraftId,
		total: input.cart.total,
		currency: "ZAR" as const,
	};
}
export type VerificationStatus = "pending" | "failed" | "manual_review" | "verified";
export async function verify(
	ctx: PluginContext,
	key: string,
	attempt: PaymentAttempt,
): Promise<VerificationStatus> {
	if (!/^dc_[a-f0-9]{32}$/.test(attempt.reference)) throw fail("Invalid payment reference");
	const data = await call(
		ctx,
		key,
		`/transaction/verify/${encodeURIComponent(attempt.reference)}`,
		{ method: "GET" },
	);
	if (
		data.reference !== attempt.reference ||
		data.amount !== attempt.amount ||
		data.currency !== attempt.currency ||
		data.domain !== "test" ||
		data.metadata?.orderDraftId !== attempt.orderDraftId ||
		data.metadata?.provider !== "paystack-test" ||
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
) {
	testKey(key);
	validateCart(cart);
	if (typeof ctx.kv.compareAndSet !== "function" || typeof ctx.kv.getVersioned !== "function")
		throw fail("Conditional KV required", 503);
	const { createdAt: _created, updatedAt: _updated, ...snapshot } = cart;
	const identity = `paystack-identity:${await digest(snapshot)}`;
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
		cart,
		inventoryLines,
		amount: cart.total.amount,
		currency: "ZAR",
		email: cart.customerEmail!,
		createdAt: new Date().toISOString(),
	});
	const response = (a: PaymentAttempt) => ({
		provider: "paystack-test",
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
		if (attempt.inventoryLines.length) await reserveInventory(ctx, id, attempt.inventoryLines);
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
			if (saved.inventoryLines.length) await releaseInventoryReservation(ctx, saved.id);
		} catch (err) {
			// A success raced this release. Only ignore it if success is durable.
			if ((await attempts(ctx).get(saved.id))?.outcome !== "verified") throw err;
		}
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
) {
	testKey(secret);
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
	const given = Uint8Array.from(signature.match(/../g)!, (h) => parseInt(h, 16));
	let diff = 0;
	for (let i = 0; i < expected.length; i++) diff |= expected[i]! ^ given[i]!;
	if (diff) throw fail("Invalid Paystack signature");
}
