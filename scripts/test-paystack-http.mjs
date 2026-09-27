import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { startFixture, address } from "./fixtures/host-harness.mjs";

async function json(response) {
	const body = await response.json();
	return { status: response.status, body };
}
async function prepare(fixture) {
	for (const name of ["Alice", "Bob"]) {
		const result = await json(
			await fixture.post("cart/items", { productId: fixture.productId, customisation: { name } }),
		);
		assert.equal(result.status, 200, JSON.stringify(result.body));
	}
	assert.equal(
		(
			await fixture.post("cart/contact", {
				email: "buyer@example.invalid",
				shippingAddress: address,
				billingAddress: address,
			})
		).status,
		200,
	);
	assert.equal(
		(await fixture.post("cart/shipping-method", { methodId: "fixture-flat" })).status,
		200,
	);
}
async function begin(fixture, idempotency = randomUUID(), total = 55000) {
	const result = await json(
		await fixture.post(
			"checkout/create-session",
			{ customerEmail: "buyer@example.invalid" },
			{ "Idempotency-Key": idempotency },
		),
	);
	assert.equal(result.status, 200, JSON.stringify(result.body));
	assert.equal(result.body.provider, fixture.providerId);
	assert.equal(result.body.mode, fixture.mode);
	assert.deepEqual(result.body.total, { currency: "ZAR", amount: total });
	assert.equal(new URL(result.body.url).origin, "https://checkout.paystack.com");
	return result.body;
}
async function lookup(fixture, checkout) {
	return json(
		await fetch(
			fixture.endpoint(`orders/by-draft?id=${encodeURIComponent(checkout.orderDraftId)}`),
			{ headers: { cookie: fixture.cookie } },
		),
	);
}
async function webhook(fixture, checkout, valid = true) {
	const state = await fixture.provider();
	const tx = state.transactions[checkout.reference];
	const raw = JSON.stringify(
		{
			event: "charge.success",
			data: { ...tx, status: "success", domain: fixture.mode, customer: { email: tx.email } },
		},
		null,
		2,
	);
	const signature = valid
		? createHmac("sha512", fixture.key).update(raw).digest("hex")
		: "0".repeat(128);
	return json(
		await fetch(fixture.endpoint("checkout/paystack-webhook"), {
			method: "POST",
			headers: { "content-type": "application/json", "x-paystack-signature": signature },
			body: raw,
		}),
	);
}
async function run(label, test, options = {}) {
	const fixture = await startFixture({ providerStatus: "pending", ...options });
	try {
		await test(fixture);
		console.log(`PASS: ${label}`);
	} catch (error) {
		console.error(fixture.logs());
		throw error;
	} finally {
		await fixture.close();
	}
}

await run(
	"real HTTP checkout, authoritative verification, concurrency, stock, durable order and restart",
	async (f) => {
		await prepare(f);
		assert.equal(
			(await f.post("checkout/create-session", { amount: 1 })).status,
			400,
			"Client-supplied totals must be rejected",
		);
		const idempotency = randomUUID();
		const checkout = await begin(f, idempotency);
		const retry = await begin(f, idempotency);
		assert.equal(
			retry.reference,
			checkout.reference,
			"Retry must reuse the original provider reference",
		);
		assert.equal(
			(await f.provider()).calls.filter((call) => call.path === "/transaction/initialize").length,
			1,
		);
		assert.equal((await lookup(f, checkout)).body.status, "pending");
		assert.equal(f.documents("orders").length, 0);
		await f.setProvider({ status: "success", verificationOverrides: { amount: 1 } });
		assert.notEqual((await lookup(f, checkout)).body.status, "ready");
		assert.equal(
			f.documents("orders").length,
			0,
			"Wrong provider amount cannot create a paid order",
		);
		await f.setProvider({ verificationOverrides: {} });
		assert.equal((await webhook(f, checkout, false)).status, 400);
		const results = await Promise.all([
			lookup(f, checkout),
			webhook(f, checkout),
			lookup(f, checkout),
			webhook(f, checkout),
		]);
		assert(
			results.some(
				(result) =>
					result.body.status === "ready" ||
					result.body.finalized === true ||
					result.body.received === true,
			),
		);
		const receipt = await lookup(f, checkout);
		assert.equal(receipt.status, 200);
		assert.equal(receipt.body.status, "ready", JSON.stringify(receipt.body));
		assert.equal(receipt.body.testMode, true);
		assert.deepEqual(receipt.body.items.map((item) => item.customisation.name).sort(), [
			"Alice",
			"Bob",
		]);
		assert.equal(f.documents("orders").length, 1);
		assert.equal(f.documents("order_items").length, 2);
		assert.equal(f.documents("payments").length, 1);
		assert.equal(f.documents("commerce_outbox").length, 1);
		assert.equal(f.documents("commerce_outbox")[0].status, "suppressed");
		assert.equal(receipt.body.order.status, "processing");
		assert.equal(receipt.body.order.paymentMode, "test");
		const statusPage = await fetch(`${f.origin}/thank-you/${checkout.orderDraftId}`);
		assert.equal(statusPage.headers.get("cache-control"), "private, no-store");
		assert.equal(statusPage.headers.get("referrer-policy"), "no-referrer");
		const projection = JSON.parse(
			f.db
				.prepare("SELECT value FROM options WHERE name=?")
				.get("plugin:dashcommerce:state:inventory:projection:v1").value,
		);
		assert.equal(projection.reservations[checkout.orderDraftId].status, "consumed");
		assert.equal(Object.values(projection.buckets)[0].available, 0);
		const before = (await f.provider()).calls.length;
		await f.restart();
		assert.equal((await lookup(f, checkout)).body.status, "ready");
		assert.equal(
			(await f.provider()).calls.length,
			before,
			"Completed lookup must not repeatedly query the provider",
		);
		assert.equal(f.documents("orders").length, 1);
	},
);

await run("partial persistence failure recovers after process restart", async (f) => {
	await prepare(f);
	const checkout = await begin(f);
	await f.setProvider({ status: "success" });
	f.db.exec(
		"CREATE TRIGGER fixture_write_failure BEFORE INSERT ON _plugin_storage WHEN NEW.collection = 'order_items' BEGIN SELECT RAISE(ABORT, 'injected fixture write failure'); END",
	);
	assert.notEqual((await lookup(f, checkout)).body.status, "ready");
	assert(!f.documents("payments").some((payment) => payment.status === "finalized"));
	f.db.exec("DROP TRIGGER fixture_write_failure");
	await f.restart();
	const receipt = await lookup(f, checkout);
	assert.equal(receipt.body.status, "ready", JSON.stringify(receipt.body));
	assert.equal(f.documents("orders").length, 1);
	assert.equal(f.documents("order_items").length, 2);
});

await run("abandoned payment never becomes paid and releases its reservation", async (f) => {
	await prepare(f);
	const checkout = await begin(f);
	await f.setProvider({ status: "abandoned" });
	const result = await lookup(f, checkout);
	assert.equal(result.body.status, "failed", JSON.stringify(result.body));
	assert.equal(f.documents("orders").length, 0);
	const projection = JSON.parse(
		f.db
			.prepare("SELECT value FROM options WHERE name=?")
			.get("plugin:dashcommerce:state:inventory:projection:v1").value,
	);
	assert.equal(projection.reservations[checkout.orderDraftId].status, "released");
});
function available(f) {
	const projection = JSON.parse(
		f.db
			.prepare("SELECT value FROM options WHERE name=?")
			.get(
				f.mode === "live"
					? "plugin:dashcommerce:state:inventory:projection:live:v1"
					: "plugin:dashcommerce:state:inventory:projection:v1",
			).value,
	);
	return Object.values(projection.buckets)[0].available;
}
async function refund(f, order, key, overrides = {}) {
	return json(
		await f.adminRequest(`admin/orders/refund?id=${order.id}`, {
			method: "POST",
			body: JSON.stringify({
				amount: order.paidTotal.amount,
				currency: order.currency,
				idempotencyKey: key,
				restock: true,
				lineItemRefunds: f.documents("order_items").map((item) => ({
					orderItemId: item.id,
					quantity: item.quantity,
					amount: item.total.amount,
					currency: item.total.currency,
				})),
				...overrides,
			}),
		}),
	);
}
for (const mode of ["test", "live"]) {
	await run(
		`normal Paystack ${mode} configuration: native tax/coupons, authenticated refunds and mode binding`,
		async (f) => {
			await prepare(f);
			f.set("settings:taxMode", "table");
			f.put("tax_rates", "fixture-tax", {
				id: "fixture-tax",
				country: "ZA",
				taxClass: "standard",
				rate: 15,
				name: "Fixture tax",
				compound: false,
				appliesToShipping: false,
				priority: 1,
			});
			f.put("coupons", "fixture-coupon", {
				id: "fixture-coupon",
				code: "FIXTURE10",
				discountType: "percent_cart",
				discountValue: 10,
				status: "active",
				excludeSaleItems: false,
				individualUse: false,
				usageCount: 0,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
			const applied = await json(await f.post("cart/coupon", { code: "FIXTURE10" }));
			assert.equal(applied.status, 200, JSON.stringify(applied.body));
			const checkout = await begin(f, randomUUID(), 56750);
			await f.setProvider({ status: "success" });
			const hook = await webhook(f, checkout);
			assert.equal(hook.status, 200, JSON.stringify(hook.body));
			const receipt = await lookup(f, checkout);
			assert.equal(receipt.body.status, "ready", JSON.stringify(receipt.body));
			const order = receipt.body.order;
			assert.equal(order.paymentMode, mode);
			assert.equal(order.status, "processing");
			assert.equal(order.taxTotal.amount, 6750);
			assert.equal(order.discountTotal.amount, 5000);
			assert.equal(order.shippingTotal.amount, 5000);
			assert.equal(available(f), 0);
			assert.equal(f.documents("coupons")[0].usageCount, mode === "live" ? 1 : 0);
			assert.equal(
				f.documents("commerce_outbox")[0].status,
				mode === "live" ? "pending" : "suppressed",
			);
			const report = await json(await f.adminRequest("admin/reports/revenue"));
			assert.equal(report.status, 200, JSON.stringify(report.body));
			assert.equal(report.body.series.length, mode === "live" ? 1 : 0);
			assert.equal(
				(
					await fetch(f.endpoint(`admin/orders/refund?id=${order.id}`), {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					})
				).status,
				401,
			);
			// Historical transactions remain tied to their original mode after a settings change.
			f.set("settings:paystackMode", mode === "test" ? "live" : "test");
			const key = `fixture_${randomUUID()}`;
			const pending = await refund(f, order, key);
			assert.equal(pending.status, 200, JSON.stringify(pending.body));
			assert.equal(pending.body.refund.status, "pending");
			assert.equal(pending.body.refund.clientRequestId, key);
			assert.equal(f.documents("orders")[0].refundedTotal.amount, 0);
			assert.equal(available(f), 0, "Pending refunds must not restore stock");
			assert.equal((await refund(f, order, key)).body.refund.id, pending.body.refund.id);
			assert.equal(
				(await refund(f, order, `another_${randomUUID()}`)).status,
				400,
				"Pending money is reserved against over-refunds",
			);
			await f.setProvider({ refundStatus: "processed" });
			const done = await refund(f, order, key);
			assert.equal(done.status, 200, JSON.stringify(done.body));
			assert.equal(done.body.refund.status, "succeeded");
			assert.equal(f.documents("orders")[0].refundedTotal.amount, 56750);
			assert.equal(f.documents("orders")[0].status, "refunded");
			assert.equal(available(f), 2);
			assert.equal(
				(await f.provider()).calls.filter(
					(call) => call.path === "/refund" && call.method === "POST",
				).length,
				1,
			);
			await f.restart();
			assert.equal((await refund(f, order, key)).body.refund.status, "succeeded");
			assert.equal(available(f), 2, "Refund restock is durable and idempotent");
			assert.equal(f.documents("commerce_outbox").length, 2);
		},
		{ provider: "paystack", mode, admin: true },
	);
}
await run(
	"ambiguous refund POST survives restart and requires independently verified operator recovery",
	async (f) => {
		await prepare(f);
		const checkout = await begin(f);
		await f.setProvider({ status: "success", loseRefundResponseOnce: true });
		const order = (await lookup(f, checkout)).body.order;
		const key = `uncertain_${randomUUID()}`;
		const initial = await refund(f, order, key);
		assert.equal(initial.status, 202, JSON.stringify(initial.body));
		assert.equal(initial.body.recoveryRequired, true);
		assert.equal(initial.body.refund.transportState, "uncertain");
		await f.restart();
		assert.equal((await refund(f, order, key)).body.refund.transportState, "uncertain");
		assert.equal(
			(await f.provider()).calls.filter((call) => call.path === "/refund" && call.method === "POST")
				.length,
			1,
		);
		assert.equal(available(f), 0);
		const providerRefundId = String(Object.values((await f.provider()).refunds)[0].id);
		await f.setProvider({ refundStatus: "processed" });
		const recovered = await json(
			await f.adminRequest("admin/payment-operations/reconcile-refund", {
				method: "POST",
				body: JSON.stringify({ refundId: initial.body.refund.id, providerRefundId }),
			}),
		);
		assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
		assert.equal(recovered.body.status, "succeeded");
		assert.equal(available(f), 2);
	},
	{ provider: "paystack", admin: true },
);
await run(
	"native inventory preview CAS and refund-effect recovery survive an interrupted notification write",
	async (f) => {
		const inspect = () =>
			f.adminRequest(`admin/payment-operations/inventory?productId=${f.productId}`);
		const preview = (await json(await inspect())).body;
		assert.equal(preview.availability.effectiveStock, 2);
		await prepare(f);
		const checkout = await begin(f);
		await f.setProvider({ status: "success", refundStatus: "processed" });
		const order = (await lookup(f, checkout)).body.order;
		const adopt = (expected) =>
			f.adminRequest("admin/payment-operations/reconcile-inventory", {
				method: "POST",
				body: JSON.stringify({ productId: f.productId, expected, confirm: true }),
			});
		assert.equal(
			(await adopt(preview.availability)).status,
			409,
			"A stale stock preview cannot overwrite a later sale",
		);
		assert.equal(available(f), 0);
		f.db.prepare("UPDATE ec_products SET stock_quantity=5 WHERE id=?").run(f.productId);
		await f.restart();
		const fresh = (await json(await inspect())).body;
		assert.equal(fresh.availability.catalogStock, 5);
		assert.equal((await adopt(fresh.availability)).status, 200);
		assert.equal(available(f), 5);
		f.db.exec(
			"CREATE TRIGGER fixture_refund_receipt_failure BEFORE INSERT ON _plugin_storage WHEN NEW.collection='commerce_outbox' AND NEW.id LIKE 'refund:%' BEGIN SELECT RAISE(ABORT, 'injected refund notification persistence failure'); END",
		);
		const result = await refund(f, order, `recovery_${randomUUID()}`);
		assert.equal(result.status, 202, JSON.stringify(result.body));
		assert.equal(result.body.refund.status, "succeeded");
		assert.notEqual(f.documents("refunds")[0].effectsFinalized, true);
		assert.equal(available(f), 7);
		f.db.exec("DROP TRIGGER fixture_refund_receipt_failure");
		await f.restart();
		const recovered = await json(
			await f.adminRequest("admin/payment-operations/reconcile-refund", {
				method: "POST",
				body: JSON.stringify({
					refundId: result.body.refund.id,
					providerRefundId: result.body.refund.providerRefundId,
				}),
			}),
		);
		assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
		assert.equal(f.documents("refunds")[0].effectsFinalized, true);
		assert.equal(f.documents("commerce_outbox").length, 2);
		assert.equal(available(f), 7, "Recovery must not restock twice");
	},
	{ provider: "paystack", admin: true },
);
await run(
	"live coupon capacity is held before initialization, released on confirmed failure, and survives native code edits",
	async (f) => {
		await prepare(f);
		const coupon = {
			id: "fixture-coupon",
			code: "FIXTURE10",
			discountType: "percent_cart",
			discountValue: 10,
			status: "active",
			excludeSaleItems: false,
			individualUse: false,
			usageCount: 0,
			usageLimit: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		f.put("coupons", coupon.id, coupon);
		assert.equal((await f.post("cart/coupon", { code: coupon.code })).status, 200);
		const first = await begin(f, randomUUID(), 50000);
		await prepare(f); // A distinct four-unit checkout, with ample independent stock.
		const blocked = await json(
			await f.post(
				"checkout/create-session",
				{ customerEmail: "buyer@example.invalid" },
				{ "Idempotency-Key": randomUUID() },
			),
		);
		assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
		assert.equal(blocked.body.code, "coupon_quota");
		assert.equal(
			(await f.provider()).calls.filter((c) => c.path === "/transaction/initialize").length,
			1,
		);
		await f.setProvider({ status: "failed" });
		assert.equal((await lookup(f, first)).body.status, "failed");
		const second = await begin(f, randomUUID(), 95000);
		const edited = await json(
			await f.adminRequest(`admin/coupons/item?id=${coupon.id}`, {
				method: "POST",
				body: JSON.stringify({ ...coupon, code: "RENAMED10" }),
			}),
		);
		assert.equal(edited.status, 200, JSON.stringify(edited.body));
		await f.setProvider({ status: "success" });
		const receipt = await lookup(f, second);
		assert.equal(receipt.body.status, "ready", JSON.stringify(receipt.body));
		assert.equal(receipt.body.order.status, "processing");
		assert.equal(f.documents("coupons")[0].usageCount, 1);
		assert.equal(f.documents("coupon_usage")[0].couponId, coupon.id);
		assert.equal(
			(await f.provider()).calls.filter((c) => c.path === "/transaction/initialize").length,
			2,
		);
	},
	{ provider: "paystack", mode: "live", admin: true, stock: 6 },
);
console.log(
	"All HTTP checks, including live-mode code paths, used synthetic credentials and a fixed-origin local provider fixture; no external payments or email.",
);
