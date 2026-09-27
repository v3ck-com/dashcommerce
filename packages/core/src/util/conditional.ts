import type { PluginContext, StorageCollection } from "emdash";

export function collection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	return (ctx.storage as unknown as Record<string, StorageCollection<T>>)[name]!;
}
/** Native put is an UPSERT. Only conditional insert may create immutable effects. */
export async function insertOnce<T>(store: StorageCollection<T>, id: string, value: T): Promise<T> {
	if (typeof store.compareAndSet !== "function") throw new Error("Conditional storage required");
	if ((await store.compareAndSet(id, null, value)).applied) return value;
	const existing = await store.get(id);
	if (!existing) throw new Error("Conditional insert lost without a record");
	return existing;
}
export async function mutate<T>(
	store: StorageCollection<T>,
	id: string,
	fn: (value: T) => T,
): Promise<T> {
	if (typeof store.getVersioned !== "function" || typeof store.compareAndSet !== "function")
		throw new Error("Conditional storage required");
	for (let i = 0; i < 20; i++) {
		const current = await store.getVersioned(id);
		if (!current) throw new Error("Missing state record");
		const next = fn(current.value);
		if (next === current.value) return next;
		if ((await store.compareAndSet(id, current.revision, next)).applied) return next;
	}
	throw new Error("Concurrent state update; retry");
}
export async function digest(value: unknown): Promise<string> {
	const canonical = (v: any): any =>
		Array.isArray(v)
			? v.map(canonical)
			: v && typeof v === "object"
				? Object.fromEntries(
						Object.keys(v)
							.sort()
							.filter((k) => v[k] !== undefined)
							.map((k) => [k, canonical(v[k])]),
					)
				: v;
	return [
		...new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(JSON.stringify(canonical(value))),
			),
		),
	]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
