import type { CustomisationDefinition, CustomisationOptions } from "../types";

/** Host products may expose this JSON field; it is authored by the merchant, never the cart client. */
export const CUSTOMISATION_FIELD_SLUG = "customisation_definition";

export function validateCustomisation(
	rawDefinition: unknown,
	rawOptions: unknown,
):
	| { ok: true; options: CustomisationOptions | undefined; identity: string }
	| { ok: false; error: string } {
	let definition = rawDefinition;
	if (typeof definition === "string") {
		try {
			definition = JSON.parse(definition);
		} catch {
			return { ok: false, error: "Invalid product customisation definition" };
		}
	}
	if (definition == null) {
		if (rawOptions !== undefined)
			return { ok: false, error: "This product does not accept customisation" };
		return { ok: true, options: undefined, identity: "{}" };
	}
	if (
		!isRecord(definition) ||
		Object.keys(definition).some((key) => key !== "fields") ||
		!Array.isArray(definition.fields) ||
		definition.fields.length < 1 ||
		definition.fields.length > 4
	) {
		return { ok: false, error: "Invalid product customisation definition" };
	}
	const fields = definition.fields as CustomisationDefinition["fields"];
	const keys = new Set<string>();
	for (const field of fields) {
		if (
			!isRecord(field) ||
			Object.keys(field).some((key) => !["key", "maxLength", "required"].includes(key)) ||
			typeof field.key !== "string" ||
			!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(field.key) ||
			keys.has(field.key) ||
			!Number.isInteger(field.maxLength) ||
			(field.maxLength as number) < 1 ||
			(field.maxLength as number) > 120 ||
			(field.required !== undefined && typeof field.required !== "boolean")
		) {
			return { ok: false, error: "Invalid product customisation definition" };
		}
		keys.add(field.key);
	}
	if (rawOptions !== undefined && !isRecord(rawOptions)) {
		return { ok: false, error: "Customisation must be an object" };
	}
	const input = (rawOptions ?? {}) as Record<string, unknown>;
	if (Object.keys(input).some((key) => !keys.has(key))) {
		return { ok: false, error: "Unknown customisation field" };
	}
	const entries: Array<[string, string]> = [];
	for (const field of fields) {
		const value = Object.hasOwn(input, field.key) ? input[field.key] : undefined;
		if (value === undefined) {
			if (field.required) return { ok: false, error: `Customisation ${field.key} is required` };
			continue;
		}
		if (
			typeof value !== "string" ||
			value.trim().length === 0 ||
			value.trim().length > field.maxLength
		) {
			return { ok: false, error: `Invalid customisation ${field.key}` };
		}
		entries.push([field.key, value.trim()]);
	}
	entries.sort(([a], [b]) => a.localeCompare(b));
	const options = entries.length
		? (Object.fromEntries(entries) as CustomisationOptions)
		: undefined;
	return { ok: true, options, identity: JSON.stringify(options ?? {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	);
}

/** Existing persisted lines are already validated; serialize in stable key order. */
export function customisationIdentity(options?: CustomisationOptions): string {
	return JSON.stringify(
		Object.fromEntries(Object.entries(options ?? {}).sort(([a], [b]) => a.localeCompare(b))),
	);
}
