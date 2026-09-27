import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, Loading, Table, usePluginAPI } from "../kit";
import type { InventoryAvailability } from "../../inventory";

interface InventoryPreview {
	line: { productId: string; variantId?: string };
	availability: InventoryAvailability;
	note: string;
}

interface Row {
	id: string;
	[key: string]: unknown;
}
interface Page {
	items: Row[];
	cursor?: string;
}
type ListName = "attempts" | "refunds" | "outbox";
const LISTS: ListName[] = ["attempts", "refunds", "outbox"];
const endpoint = (name: ListName, cursor?: string) =>
	`admin/payment-operations/${name}?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
function display(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "object" && "amount" in value && "currency" in value) {
		const money = value as { amount: unknown; currency: unknown };
		return `${String(money.amount)} minor units ${String(money.currency)}`;
	}
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function PaymentOperationsPage() {
	const api = usePluginAPI();
	const [data, setData] = useState<Record<string, Page> | null>(null);
	const [history, setHistory] = useState<Record<ListName, string[]>>({
		attempts: [],
		refunds: [],
		outbox: [],
	});
	const [error, setError] = useState("");
	const [busy, setBusy] = useState("");
	const [refundIds, setRefundIds] = useState<Record<string, string>>({});
	const [message, setMessage] = useState("");
	const [productId, setProductId] = useState("");
	const [variantId, setVariantId] = useState("");
	const [inventory, setInventory] = useState<InventoryPreview | null>(null);
	const fetchList = useCallback(
		async (name: ListName, cursor?: string) => api.get<Page>(endpoint(name, cursor)),
		[api],
	);
	const reload = useCallback(async () => {
		try {
			const pages = await Promise.all(LISTS.map((name) => fetchList(name)));
			setData({
				attempts: pages[0] ?? { items: [] },
				refunds: pages[1] ?? { items: [] },
				outbox: pages[2] ?? { items: [] },
			});
			setHistory({ attempts: [], refunds: [], outbox: [] });
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Operations data unavailable");
		}
	}, [fetchList]);
	useEffect(() => {
		void reload();
	}, [reload]);
	async function navigate(name: ListName, direction: "next" | "previous") {
		if (!data) return;
		const current = data[name];
		const stack = history[name];
		const cursor = direction === "next" ? current?.cursor : stack.at(-1);
		if (!cursor) return;
		try {
			const page = await fetchList(name, direction === "next" ? cursor : stack.at(-2));
			setData((previous) => (previous ? { ...previous, [name]: page } : previous));
			setHistory((previous) => ({
				...previous,
				[name]: direction === "next" ? [...stack, cursor] : stack.slice(0, -1),
			}));
		} catch (e) {
			setMessage(e instanceof Error ? e.message : `Could not load ${name}`);
		}
	}
	async function reconcileAttempt(id: string) {
		if (
			!window.confirm(
				"Independently verify this payment attempt? No supplied status will be trusted.",
			)
		)
			return;
		setBusy(id);
		setMessage("");
		try {
			const result = await api.post<{ message: string }>(
				"admin/payment-operations/reconcile-attempt",
				{ attemptId: id },
			);
			setMessage(result.message);
			await reload();
		} catch (e) {
			setMessage(
				e instanceof Error ? e.message : "Verification failed; attempt remains unresolved.",
			);
		} finally {
			setBusy("");
		}
	}
	async function inspectInventory() {
		if (!productId.trim()) {
			setMessage("Enter a product ID to inspect inventory.");
			return;
		}
		try {
			const result = await api.get<InventoryPreview>(
				`admin/payment-operations/inventory?productId=${encodeURIComponent(productId.trim())}${variantId.trim() ? `&variantId=${encodeURIComponent(variantId.trim())}` : ""}`,
			);
			setInventory(result);
		} catch (e) {
			setMessage(e instanceof Error ? e.message : "Inventory availability could not be read.");
		}
	}
	async function adoptInventory() {
		if (
			!inventory ||
			!window.confirm(
				`Adopt the current CMS stock quantity for ${inventory.line.productId}${inventory.line.variantId ? ` / ${inventory.line.variantId}` : ""} as a NEW available-stock baseline? This intentionally replaces prior stock accounting, retaining active reservations. Use only after a deliberate stock count or replenishment.`,
			)
		)
			return;
		setBusy("inventory");
		try {
			await api.post("admin/payment-operations/reconcile-inventory", {
				...inventory.line,
				expected: inventory.availability,
				confirm: true,
			});
			setMessage("CMS inventory baseline adopted. Active reservations were retained.");
			setInventory(null);
			await inspectInventory();
		} catch (error) {
			setInventory(null);
			setMessage(
				error instanceof Error
					? error.message
					: "Inventory changed; obtain a fresh preview before retrying.",
			);
		} finally {
			setBusy("");
		}
	}
	async function reconcileRefund(id: string) {
		const row = refunds.find((item) => item.id === id);
		const providerRefundId = (refundIds[id] ?? String(row?.providerRefundId ?? "")).trim();
		if (!providerRefundId) {
			setMessage(
				"Enter the existing provider refund ID. This action performs GET verification only; it never submits another refund.",
			);
			return;
		}
		if (!window.confirm("Look up this existing provider refund ID? No refund will be created."))
			return;
		setBusy(id);
		setMessage("");
		try {
			const result = await api.post<{ message: string }>(
				"admin/payment-operations/reconcile-refund",
				{ refundId: id, providerRefundId },
			);
			setMessage(result.message);
			await reload();
		} catch (e) {
			setMessage(
				e instanceof Error ? e.message : "Refund remains unresolved; no new refund was submitted.",
			);
		} finally {
			setBusy("");
		}
	}
	if (error)
		return (
			<Alert type="error" title="Payment operations unavailable">
				{error}
			</Alert>
		);
	if (!data) return <Loading />;
	const attempts = data.attempts?.items ?? [];
	const refunds = data.refunds?.items ?? [];
	const outbox = data.outbox?.items ?? [];
	const render = (name: ListName, title: string, rows: Row[], fields: string[]) => (
		<Card title={title}>
			<Table<Row>
				columns={fields.map((field) => ({
					key: field,
					header: field,
					render: (row) =>
						field === "amount" && typeof row[field] !== "object"
							? `${display(row[field])} minor units ${String(row.currency ?? row.paymentCurrency ?? "")}`
							: display(row[field]),
				}))}
				data={rows}
				getRowKey={(row) => row.id}
			/>
			<div className="flex gap-2">
				<Button disabled={!history[name].length} onClick={() => void navigate(name, "previous")}>
					Previous
				</Button>
				<Button disabled={!data[name]?.cursor} onClick={() => void navigate(name, "next")}>
					Next
				</Button>
			</div>
		</Card>
	);
	return (
		<div className="space-y-4">
			<h1>Payment operations</h1>
			<p>
				Private operational tools. Pending or uncertain means unresolved—not paid, refunded, or
				delivered. Customer contacts, notification bodies, and idempotency keys are omitted; listed
				record IDs may identify operational receipts.
			</p>
			{message && (
				<Alert type="info" title="Operation result">
					{message}
				</Alert>
			)}
			<Button onClick={() => void reload()}>Reset lists and refresh</Button>
			{render("attempts", "Payment attempts (all outcomes)", attempts, [
				"id",
				"provider",
				"mode",
				"amount",
				"currency",
				"outcome",
			])}
			<Card title="Attempt actions">
				{attempts.map((row) => (
					<p key={row.id}>
						{row.id} · {String(row.outcome ?? "pending")}{" "}
						<Button disabled={busy === row.id} onClick={() => void reconcileAttempt(row.id)}>
							{busy === row.id
								? "Checking…"
								: row.outcome === "verified"
									? "Check finalization"
									: "Verify provider status"}
						</Button>
					</p>
				))}
			</Card>
			{render("refunds", "Refund requests", refunds, [
				"id",
				"orderId",
				"amount",
				"paymentProvider",
				"paymentMode",
				"status",
				"transportState",
				"effectsFinalized",
			])}
			<Card title="Reconcile existing refund">
				<p>
					For unknown POST outcomes, enter the refund ID found in the provider dashboard. This is a
					GET attach/verification, never a second refund POST.
				</p>
				{refunds.map((row) => (
					<div key={row.id}>
						<label>
							{row.id}{" "}
							{row.providerRefundId
								? `(known ID: ${row.providerRefundId})`
								: "(provider ID not attached)"}{" "}
							<input
								value={refundIds[row.id] ?? String(row.providerRefundId ?? "")}
								onChange={(e) => setRefundIds((v) => ({ ...v, [row.id]: e.target.value }))}
							/>
						</label>
						<Button
							disabled={
								busy === row.id || (row.status !== "pending" && row.needsEffectRecovery !== true)
							}
							onClick={() => void reconcileRefund(row.id)}
						>
							{row.needsEffectRecovery ? "Resume confirmed effects" : "Verify existing provider ID"}
						</Button>
					</div>
				))}
			</Card>
			{render("outbox", "Notification outbox", outbox, [
				"id",
				"orderId",
				"status",
				"testMode",
				"reviewRequired",
			])}
			<p>
				Sending/uncertain notifications require manual review. They are not automatically retried.
			</p>
			<Card title="Inventory availability and reconciliation">
				<label>
					Product ID{" "}
					<input
						value={productId}
						disabled={busy === "inventory"}
						onChange={(e) => {
							setProductId(e.target.value);
							setInventory(null);
						}}
					/>
				</label>
				<label>
					Variant ID (when applicable){" "}
					<input
						value={variantId}
						disabled={busy === "inventory"}
						onChange={(e) => {
							setVariantId(e.target.value);
							setInventory(null);
						}}
					/>
				</label>
				<Button disabled={busy === "inventory"} onClick={() => void inspectInventory()}>
					Read availability
				</Button>
				{inventory !== null && (
					<>
						<pre>{JSON.stringify(inventory, null, 2)}</pre>
						<Button disabled={busy === "inventory"} onClick={() => void adoptInventory()}>
							Adopt CMS baseline…
						</Button>
					</>
				)}
				<p>
					Sales and refunds use the atomic inventory projection. After intentional CMS stock
					changes, preview and explicitly adopt the new baseline here. Active reservations are
					retained; stale previews are rejected. Adoption is not a refresh and must not be used to
					undo sales.
				</p>
			</Card>
		</div>
	);
}
