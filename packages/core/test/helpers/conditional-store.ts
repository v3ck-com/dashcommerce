/** Native-like UPSERT + revision CAS, with clone isolation and failure hooks. */
export function conditionalStore(uniqueFields: string[] = []) {
	const rows = new Map<string, any>();
	const revisions = new Map<string, number>();
	const clone = (v: any) => structuredClone(v);
	const store = {
		rows,
		revisions,
		writes: 0,
		beforeWrite: undefined as undefined | ((id: string, data: any) => void),
		afterWrite: undefined as undefined | ((id: string, data: any) => void),
		async get(id: string) {
			return rows.has(id) ? clone(rows.get(id)) : null;
		},
		async put(id: string, data: any) {
			store.beforeWrite?.(id, data);
			for (const [k, row] of rows)
				if (k !== id && uniqueFields.some((f) => data[f] && row[f] === data[f]))
					throw new Error("unique constraint");
			rows.set(id, clone(data));
			revisions.set(id, (revisions.get(id) ?? 0) + 1);
			store.writes++;
			store.afterWrite?.(id, data);
		},
		async getVersioned(id: string) {
			return rows.has(id)
				? { value: clone(rows.get(id)), revision: String(revisions.get(id) ?? 0) }
				: null;
		},
		async compareAndSet(id: string, expected: string | null, data: any) {
			const revision = rows.has(id) ? String(revisions.get(id) ?? 0) : null;
			if (revision !== expected) return { applied: false };
			// put commits synchronously before its promise yields, as a database CAS does.
			await store.put(id, data);
			return { applied: true, revision: String(revisions.get(id)) };
		},
		async query({ where, limit }: any = {}) {
			return {
				items: [...rows.entries()]
					.filter(([, v]) => !where || Object.entries(where).every(([k, val]) => v[k] === val))
					.slice(0, limit ?? 200)
					.map(([id, data]) => ({ id, data: clone(data) })),
				hasMore: false,
			};
		},
		async compareAndDelete(id: string, expected: string) {
			if (!rows.has(id) || String(revisions.get(id) ?? 0) !== expected) return { applied: false };
			rows.delete(id);
			revisions.set(id, (revisions.get(id) ?? 0) + 1);
			store.writes++;
			return { applied: true };
		},
		async delete(id: string) {
			revisions.set(id, (revisions.get(id) ?? 0) + 1);
			return rows.delete(id);
		},
		async putMany(items: any[]) {
			for (const { id, data } of items) await store.put(id, data);
		},
	};
	return store;
}
