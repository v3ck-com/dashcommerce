import { useMemo, useState } from "react";

export interface VariantOption {
	id: string;
	sku: string;
	attributes: Record<string, string>;
	stockQuantity: number | null;
	priceMinor: number | null;
	currency: string;
}

export interface CustomisationField {
	key: string;
	maxLength: number;
	required?: boolean;
}

export interface AddToCartIslandProps {
	productId: string;
	variantId?: string;
	variants?: VariantOption[];
	attributeKeys?: string[];
	customisationDefinition?: unknown;
	label?: string;
	disabled?: boolean;
}

interface CurrencyMismatch {
	code: "currency_not_priced";
	cartCurrency: string;
	switchableCurrencies: string[];
}

function readCustomisationFields(raw: unknown): { fields: CustomisationField[]; invalid: boolean } {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return { fields: [], invalid: true };
		}
	}
	if (value == null) return { fields: [], invalid: false };
	if (typeof value !== "object" || Array.isArray(value)) return { fields: [], invalid: true };
	if (Object.keys(value).some((key) => key !== "fields")) return { fields: [], invalid: true };
	const fields = (value as { fields?: unknown }).fields;
	if (!Array.isArray(fields) || fields.length < 1 || fields.length > 4)
		return { fields: [], invalid: true };
	const seen = new Set<string>();
	const safe: CustomisationField[] = [];
	for (const candidate of fields) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			return { fields: [], invalid: true };
		const field = candidate as Record<string, unknown>;
		if (
			Object.keys(field).some((key) => !["key", "maxLength", "required"].includes(key)) ||
			typeof field.key !== "string" ||
			!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(field.key) ||
			seen.has(field.key) ||
			!Number.isInteger(field.maxLength) ||
			(field.maxLength as number) < 1 ||
			(field.maxLength as number) > 120 ||
			(field.required !== undefined && typeof field.required !== "boolean")
		)
			return { fields: [], invalid: true };
		seen.add(field.key);
		safe.push({
			key: field.key,
			maxLength: field.maxLength as number,
			...(field.required === true ? { required: true } : {}),
		});
	}
	return { fields: safe, invalid: false };
}

function fieldLabel(key: string): string {
	const spaced = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export default function AddToCartIsland({
	productId,
	variantId,
	variants = [],
	attributeKeys = [],
	customisationDefinition,
	label = "Add to cart",
	disabled = false,
}: AddToCartIslandProps) {
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mismatch, setMismatch] = useState<CurrencyMismatch | null>(null);
	const [selected, setSelected] = useState<Record<string, string>>({});
	const [customisation, setCustomisation] = useState<Record<string, string>>({});
	const [quantity, setQuantity] = useState(1);
	const customisationSchema = useMemo(
		() => readCustomisationFields(customisationDefinition),
		[customisationDefinition],
	);

	async function switchCurrencyAndRetry(next: string) {
		setError(null);
		const res = await fetch("/_emdash/api/plugins/dashcommerce/cart/currency", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ currency: next }),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? `Could not switch currency to ${next}`);
			return;
		}
		setMismatch(null);
		window.dispatchEvent(
			new CustomEvent("dashcommerce:currency-changed", { detail: { currency: next } }),
		);
		await add();
	}

	const matchedVariant = useMemo(() => {
		if (variantId) return variants.find((variant) => variant.id === variantId) ?? null;
		if (variants.length === 0) return null;
		return (
			variants.find((variant) =>
				attributeKeys.every((key) => variant.attributes[key] === selected[key]),
			) ?? null
		);
	}, [variants, attributeKeys, selected, variantId]);

	const needsVariantPick =
		variants.length > 0 && !variantId && !matchedVariant && attributeKeys.length > 0;
	const missingRequiredCustomisation = customisationSchema.fields.some(
		(field) => field.required && !(customisation[field.key] ?? "").trim(),
	);

	async function add() {
		if (customisationSchema.invalid) {
			setError("Personalisation is unavailable because this product is misconfigured.");
			return;
		}
		const customisationPayload: Record<string, string> = {};
		for (const field of customisationSchema.fields) {
			const value = (customisation[field.key] ?? "").trim();
			if (field.required && !value) {
				setError(`${fieldLabel(field.key)} is required.`);
				return;
			}
			if (value.length > field.maxLength) {
				setError(`${fieldLabel(field.key)} must be ${field.maxLength} characters or fewer.`);
				return;
			}
			if (value) customisationPayload[field.key] = value;
		}
		if (!productId) {
			setError("Missing product id. Check the page that renders this component.");
			return;
		}
		setError(null);
		setMismatch(null);
		setAdding(true);
		try {
			const res = await fetch("/_emdash/api/plugins/dashcommerce/cart/items", {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					productId,
					...(customisationSchema.fields.length > 0 ? { customisation: customisationPayload } : {}),
					...(matchedVariant ? { variantId: matchedVariant.id } : variantId ? { variantId } : {}),
					quantity,
				}),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
					code?: string;
					cartCurrency?: string;
					switchableCurrencies?: string[];
				};
				if (
					body.code === "currency_not_priced" &&
					body.cartCurrency &&
					Array.isArray(body.switchableCurrencies) &&
					body.switchableCurrencies.length > 0
				) {
					setMismatch({
						code: "currency_not_priced",
						cartCurrency: body.cartCurrency,
						switchableCurrencies: body.switchableCurrencies,
					});
					setError(body.error ?? "Product not priced in your currency.");
					return;
				}
				setError(body.error ?? `Could not add to cart (${res.status})`);
				return;
			}
			window.dispatchEvent(new CustomEvent("dashcommerce:cart-updated"));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Network error");
		} finally {
			setAdding(false);
		}
	}

	return (
		<div className="dc-add-to-cart">
			{attributeKeys.length > 0 && (
				<div className="dc-variant-picker">
					{attributeKeys.map((key) => {
						const values = Array.from(
							new Set(variants.map((variant) => variant.attributes[key]).filter(Boolean)),
						) as string[];
						return (
							<label key={key}>
								<span>{key}: </span>
								<select
									value={selected[key] ?? ""}
									onChange={(event) =>
										setSelected({ ...selected, [key]: event.currentTarget.value })
									}
								>
									<option value="">Pick {key}</option>
									{values.map((value) => (
										<option key={value} value={value}>
											{value}
										</option>
									))}
								</select>
							</label>
						);
					})}
				</div>
			)}
			{customisationSchema.fields.length > 0 && (
				<fieldset className="dc-personalisation">
					<legend>Personalise this item</legend>
					{customisationSchema.fields.map((field) => (
						<label key={field.key}>
							<span>
								{fieldLabel(field.key)}
								{field.required ? " *" : ""}
							</span>
							<input
								type="text"
								name={`customisation-${field.key}`}
								value={customisation[field.key] ?? ""}
								maxLength={field.maxLength}
								required={field.required}
								onChange={(event) =>
									setCustomisation({ ...customisation, [field.key]: event.currentTarget.value })
								}
							/>
							<small>{field.maxLength} characters maximum</small>
						</label>
					))}
				</fieldset>
			)}
			{customisationSchema.invalid && (
				<p role="alert" className="dc-add-to-cart__error">
					Personalisation is unavailable because this product is misconfigured.
				</p>
			)}
			<div className="dc-qty-row">
				<label>
					Qty{" "}
					<input
						type="number"
						min={1}
						value={quantity}
						onChange={(event) => setQuantity(Math.max(1, Number(event.currentTarget.value) || 1))}
					/>
				</label>
				<button
					type="button"
					disabled={
						disabled ||
						adding ||
						needsVariantPick ||
						customisationSchema.invalid ||
						missingRequiredCustomisation
					}
					onClick={add}
				>
					{adding
						? "Adding…"
						: needsVariantPick
							? "Pick a variant"
							: missingRequiredCustomisation
								? "Complete personalisation"
								: label}
				</button>
			</div>
			{error && (
				<p role="alert" className="dc-add-to-cart__error">
					{error}
				</p>
			)}
			{mismatch && (
				<div className="dc-currency-mismatch" role="group" aria-label="Switch currency">
					{mismatch.switchableCurrencies.map((currency) => (
						<button
							key={currency}
							type="button"
							className="dc-currency-mismatch__btn"
							onClick={() => switchCurrencyAndRetry(currency)}
						>
							Switch to {currency} &amp; add
						</button>
					))}
				</div>
			)}
			<style>{`
				.dc-personalisation { display: grid; gap: 0.75rem; padding: 1rem; margin: 1rem 0; border: 1px solid var(--border-mid, #d4d4d8); border-radius: var(--radius, 6px); }
				.dc-personalisation legend { padding: 0 0.35rem; color: var(--text, #111); font-weight: 600; }
				.dc-personalisation label { display: grid; gap: 0.3rem; color: var(--text-mid, #444); font-size: 0.9rem; }
				.dc-personalisation input { padding: 0.65rem 0.75rem; color: var(--text, #111); background: var(--surface, #fff); border: 1px solid var(--border-strong, #d4d4d8); border-radius: var(--radius, 4px); font: inherit; }
				.dc-personalisation input:focus { outline: 2px solid var(--accent, var(--gold, #c08a00)); outline-offset: 1px; }
				.dc-personalisation small { color: var(--text-muted, #666); }
				.dc-add-to-cart__error { color: var(--ember, #a00); margin: 0.5rem 0 0; font-size: 0.9em; }
				.dc-currency-mismatch { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
				.dc-currency-mismatch__btn { padding: 0.45rem 0.9rem; background: transparent; color: var(--accent, var(--gold, #111)); border: 1px solid var(--accent, var(--gold, #111)); border-radius: var(--radius, 4px); font-size: 0.85em; cursor: pointer; transition: background .15s, color .15s; }
				.dc-currency-mismatch__btn:hover { background: var(--accent, var(--gold, #111)); color: var(--accent-on, #fff); }
			`}</style>
		</div>
	);
}
