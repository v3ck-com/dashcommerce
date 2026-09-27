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
async function begin(fixture, idempotency = randomUUID()) {
	const result = await json(
		await fixture.post(
			"checkout/create-session",
			{ customerEmail: "buyer@example.invalid" },
			{ "Idempotency-Key": idempotency },
		),
	);
	assert.equal(result.status, 200, JSON.stringify(result.body));
	assert.equal(result.body.provider, "paystack-test");
	assert.deepEqual(result.body.total, { currency: "ZAR", amount: 55000 });
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
			data: { ...tx, status: "success", domain: "test", customer: { email: tx.email } },
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
async function run(label, test) {
	const fixture = await startFixture({ providerStatus: "pending" });
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
		assert.equal(
			f.db
				.prepare(
					"SELECT count(*) AS count FROM options WHERE name LIKE 'plugin:dashcommerce:receipt-preview:%'",
				)
				.get().count,
			1,
		);
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
	assert(!f.documents("payments").some((payment) => payment.status === "finalized_test"));
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
console.log(
	"All HTTP checks used a fixed-origin in-process Paystack fixture; no external payments or email.",
);
