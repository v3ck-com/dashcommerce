import { useEffect, useRef, useState } from "react";

interface Money {
	currency: string;
	amount: number;
}
interface Item {
	id: string;
	name: string;
	quantity: number;
	total: Money;
	customisation?: Record<string, string>;
}
interface Order {
	id: string;
	orderNumber: string;
	status: string;
	paymentStatus?: string;
	paymentProvider?: string;
	customerEmail: string;
	total: Money;
	currency: string;
	metadata?: Record<string, unknown>;
}
type PollResponse =
	| { status: "ready"; order: Order; items: Item[]; testMode?: boolean; manualReview?: boolean }
	| { status: "pending" }
	| { status: "failed" }
	| { status: "manual_review" };

export interface OrderSummaryIslandProps {
	orderDraftId: string;
	pollIntervalMs?: number;
	maxDurationMs?: number;
}

function formatMoney(m: Money, locale = "en-US") {
	try {
		return new Intl.NumberFormat(locale, { style: "currency", currency: m.currency }).format(
			m.amount / 100,
		);
	} catch {
		return `${m.currency} ${m.amount / 100}`;
	}
}

function optionLabel(key: string) {
	const spaced = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function isTestOrder(result: Extract<PollResponse, { status: "ready" }>) {
	return (
		result.testMode === true ||
		result.order.paymentProvider === "paystack-test" ||
		result.order.metadata?.testMode === true
	);
}

export default function OrderSummaryIsland({
	orderDraftId,
	pollIntervalMs = 800,
	maxDurationMs = 60_000,
}: OrderSummaryIslandProps) {
	const [result, setResult] = useState<PollResponse | null>(null);
	const [timedOut, setTimedOut] = useState(false);
	const timerRef = useRef<number | null>(null);
	const notifiedRef = useRef(false);

	useEffect(() => {
		if (!orderDraftId) return;
		const deadline = Date.now() + maxDurationMs;
		function notifyCart() {
			if (notifiedRef.current) return;
			notifiedRef.current = true;
			window.dispatchEvent(
				new CustomEvent("dashcommerce:cart-updated", { detail: { silent: true } }),
			);
		}
		async function poll() {
			if (Date.now() > deadline) {
				setTimedOut(true);
				return;
			}
			try {
				const res = await fetch(
					`/_emdash/api/plugins/dashcommerce/orders/by-draft?id=${encodeURIComponent(orderDraftId)}`,
					{ credentials: "include", headers: { Accept: "application/json" } },
				);
				if (!res.ok) throw new Error(`Order lookup failed (${res.status})`);
				const body = (await res.json()) as PollResponse;
				setResult(body);
				if (body.status === "failed" || body.status === "manual_review") return;
				if (body.status === "ready") {
					if (body.order.paymentStatus === "paid") {
						notifyCart();
						return;
					}
					if (body.order.paymentStatus === "failed") return;
				}
			} catch {
				// A transient lookup failure must never be presented as payment success.
			}
			timerRef.current = window.setTimeout(poll, pollIntervalMs);
		}
		void poll();
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, [orderDraftId, pollIntervalMs, maxDurationMs]);

	if (!orderDraftId) {
		return (
			<div role="alert">
				<h2>Receipt link is incomplete</h2>
				<p>Return to the shop and open the complete receipt link.</p>
			</div>
		);
	}

	if (timedOut) {
		return (
			<div role="status" className="dc-payment-pending">
				<h2>Payment verification is still pending</h2>
				<p>
					We have not marked this order paid. Keep this private reference and check again later:
				</p>
				<code>{orderDraftId}</code>
			</div>
		);
	}

	if (result?.status === "manual_review") {
		return (
			<div role="alert">
				<h2>Payment needs review</h2>
				<p>
					Payment has not been confirmed. Do not start another payment; contact the shop with this
					private reference:
				</p>
				<code>{orderDraftId}</code>
			</div>
		);
	}

	if (
		!result ||
		result.status === "pending" ||
		(result.status === "ready" &&
			result.order.paymentStatus !== "paid" &&
			result.order.paymentStatus !== "failed")
	) {
		return (
			<div role="status" className="dc-payment-pending">
				<h2>Verifying payment…</h2>
				<p>This order is pending until the shop confirms the payment with the payment provider.</p>
			</div>
		);
	}

	if (result.status === "failed" || result.order.paymentStatus === "failed") {
		return (
			<div role="alert" className="dc-payment-failed">
				<h2>Payment was not confirmed</h2>
				<p>
					No paid receipt is available. Contact support with private reference{" "}
					<code>{orderDraftId}</code> if you need help.
				</p>
			</div>
		);
	}

	const { order, items } = result;
	const testMode = isTestOrder(result);
	return (
		<section className={`dc-order-summary${testMode ? " dc-order-summary--test" : ""}`}>
			{testMode && <div className="dc-test-badge">TEST MODE · NO REAL PAYMENT</div>}
			<h2>{testMode ? "Test payment verified" : "Payment confirmed"}</h2>
			<p>
				Order <strong>#{order.orderNumber}</strong>
			</p>
			{testMode ? (
				<p>
					This is a preview receipt for a verified Paystack test transaction. No real money moved
					and no receipt email was sent.
				</p>
			) : (
				<p>
					Your paid order is confirmed for <strong>{order.customerEmail}</strong>.
				</p>
			)}
			{result.manualReview && (
				<p role="alert">
					Stock needs manual review. This order is on hold and will not be automatically fulfilled.
				</p>
			)}
			<ul>
				{items.map((item) => (
					<li key={item.id}>
						<div>
							{item.quantity} × {item.name} — {formatMoney(item.total)}
						</div>
						{item.customisation && Object.keys(item.customisation).length > 0 && (
							<dl>
								{Object.entries(item.customisation).map(([key, value]) => (
									<div key={key}>
										<dt>{optionLabel(key)}</dt>
										<dd>{value}</dd>
									</div>
								))}
							</dl>
						)}
					</li>
				))}
			</ul>
			<p className="dc-total">
				<strong>Total:</strong> {formatMoney(order.total)}
			</p>
			<style>{`
				.dc-order-summary, .dc-payment-pending, .dc-payment-failed { max-width: 36rem; margin: 2rem auto; padding: 2rem; border: 1px solid var(--border-mid, #d4d4d8); border-radius: var(--radius-lg, 8px); color: var(--text, #111); }
				.dc-order-summary { background: var(--success-bg, rgba(76, 175, 120, 0.08)); border-color: var(--success, #b8d9bf); }
				.dc-order-summary--test { background: var(--gold-dim, #fff7e0); border-color: var(--gold, #d9b800); }
				.dc-test-badge { display: inline-block; margin-bottom: 0.75rem; padding: 0.3rem 0.55rem; border-radius: 4px; background: var(--gold, #d9b800); color: #111; font-weight: 800; font-size: 0.75rem; letter-spacing: 0.06em; }
				.dc-order-summary ul { list-style: none; padding: 0; }
				.dc-order-summary li { padding: 0.65rem 0; border-bottom: 1px solid var(--border-mid, rgba(76, 175, 120, 0.25)); color: var(--text, #111); }
				.dc-order-summary dl { margin: 0.35rem 0 0; color: var(--text-muted, #666); font-size: 0.9rem; }
				.dc-order-summary dl div { display: flex; gap: 0.35rem; overflow-wrap: anywhere; }
				.dc-order-summary dt { font-weight: 600; }
				.dc-order-summary dt::after { content: ":"; }
				.dc-order-summary dd { margin: 0; }
				.dc-total { font-size: 1.2em; margin-top: 1rem; color: var(--text, #111); }
			`}</style>
		</section>
	);
}
