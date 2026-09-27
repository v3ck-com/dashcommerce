import type { PluginContext } from "emdash";
import { normalizeProductFields } from "../products/normalize";
import type { DownloadGrant, Order, OrderItem } from "../types";
import { collection, insertOnce } from "../util/conditional";
import { isTestOrder } from "./outbox";

/** Stable per-file conditional insertion: crashes never mint duplicate entitlements.
 * Test payments never grant an actual downloadable asset. */
export async function ensureOrderGrants(ctx: PluginContext, order: Order, items: OrderItem[]) {
	if (isTestOrder(order)) return;
	const maxUses = (await ctx.kv.get<number>("settings:downloadMaxUses")) ?? 5;
	const expiryDays = (await ctx.kv.get<number>("settings:downloadGrantExpiryDays")) ?? 30;
	for (const item of items) {
		if (!item.isDigital) continue;
		if (!ctx.content) throw new Error("Content required for digital grants");
		const record = await ctx.content.get("products", item.productId);
		if (!record) throw new Error("Digital product missing; retry or manual recovery required");
		const product = normalizeProductFields(record.data as Record<string, unknown>);
		if (!product.isDownloadable) continue;
		for (const [fileIndex, file] of (product.downloadableFiles ?? []).entries()) {
			const id = `${item.id}:file:${fileIndex}`;
			await insertOnce(collection<DownloadGrant>(ctx, "download_grants"), id, {
				id,
				orderId: order.id,
				orderItemId: item.id,
				productId: item.productId,
				customerEmail: order.customerEmail,
				fileIndex,
				fileName: file.name,
				...(file.mediaId ? { mediaId: file.mediaId } : {}),
				...(file.url ? { externalUrl: file.url } : {}),
				maxUses,
				usesCount: 0,
				expiresAt: new Date(Date.parse(order.createdAt) + expiryDays * 86400000).toISOString(),
				createdAt: order.createdAt,
			});
		}
	}
}
