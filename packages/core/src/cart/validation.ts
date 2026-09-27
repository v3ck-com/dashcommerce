import type { Address } from "../types";
export function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
export function validEmail(value: unknown): value is string {
	return (
		typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
	);
}
export function validAddress(value: unknown): value is Address {
	if (!isObject(value)) return false;
	const required = ["firstName", "lastName", "line1", "city", "region", "postalCode", "country"];
	const optional = ["line2", "company", "phone"];
	return (
		Object.keys(value).every((k) => required.includes(k) || optional.includes(k)) &&
		required.every(
			(k) => typeof value[k] === "string" && value[k].trim().length > 0 && value[k].length <= 200,
		) &&
		optional.every(
			(k) => value[k] === undefined || (typeof value[k] === "string" && value[k].length <= 200),
		) &&
		/^[A-Z]{2}$/.test(value.country as string)
	);
}
export function validContactInput(value: unknown): boolean {
	if (!isObject(value)) return false;
	return (
		Object.keys(value).every((k) =>
			["email", "billingAddress", "shippingAddress", "notes"].includes(k),
		) &&
		(value.email === undefined || validEmail(value.email)) &&
		(value.billingAddress === undefined || validAddress(value.billingAddress)) &&
		(value.shippingAddress === undefined || validAddress(value.shippingAddress)) &&
		(value.notes === undefined || (typeof value.notes === "string" && value.notes.length <= 2000))
	);
}
