export interface RefundIntentStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

const storageKey = (orderId: string) => `dashcommerce:refund-intent:${orderId}`;

/** Persist before POST so a lost response or page reload cannot mint another refund. */
export async function refundIntentKey(
	storage: RefundIntentStorage,
	orderId: string,
	payload: unknown,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(payload)),
	);
	const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const saved = storage.getItem(storageKey(orderId));
	if (saved) {
		let prior: { fingerprint?: string; key?: string };
		try {
			prior = JSON.parse(saved);
		} catch {
			throw new Error("Previous refund request needs review before another can be submitted.");
		}
		if (prior.fingerprint !== fingerprint || typeof prior.key !== "string") {
			throw new Error(
				"An earlier refund request is unresolved. Retry its original details or review refund history before submitting another.",
			);
		}
		return prior.key;
	}
	const key = `refund:${orderId}:${crypto.randomUUID()}`;
	storage.setItem(storageKey(orderId), JSON.stringify({ fingerprint, key }));
	return key;
}

/** A refresh may observe a terminal result whose original HTTP response was lost. */
export function settleRefundIntent(
	storage: RefundIntentStorage,
	orderId: string,
	refunds: Array<{ requestId?: string; clientRequestId?: string; status: string }>,
): void {
	const raw = storage.getItem(storageKey(orderId));
	if (!raw) return;
	let saved: { key?: string };
	try {
		saved = JSON.parse(raw);
	} catch {
		return;
	}
	if (
		refunds.some(
			(refund) =>
				(refund.clientRequestId ?? refund.requestId) === saved.key &&
				(refund.status === "succeeded" || refund.status === "failed"),
		)
	) {
		finishRefundIntent(storage, orderId);
	}
}

/** Call only after an authoritative terminal outcome, never on a transport error. */
export function finishRefundIntent(storage: RefundIntentStorage, orderId: string): void {
	storage.removeItem(storageKey(orderId));
}
