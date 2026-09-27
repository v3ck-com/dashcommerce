import assert from "node:assert/strict";
import test from "node:test";
import { onRequest } from "../src/host/emdash-041-host.mjs";

const url = "https://shop.test/_emdash/api/plugins/dashcommerce/cart";

test("injects one secure host-owned session before route execution", async () => {
	const request = new Request(url, { headers: { cookie: "theme=dark" } });
	let received;
	const response = await onRequest({ request }, async (rewritten) => {
		received = rewritten;
		return new Response("ok", { headers: { "set-cookie": "attacker=1", "x-test": "kept" } });
	});
	const sid = received.headers
		.get("cookie")
		.match(/(?:^|; )dashcommerce_sid=([a-f0-9]{64})(?:;|$)/)?.[1];
	assert.ok(sid);
	assert.match(
		response.headers.get("set-cookie"),
		new RegExp(
			`^__Host-dashcommerce_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure`,
		),
	);
	assert.doesNotMatch(response.headers.get("set-cookie"), /attacker/);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(response.headers.get("x-test"), "kept");
});

test("preserves valid supplied session and does not emit a cookie", async () => {
	const sid = "a".repeat(64);
	let received;
	const response = await onRequest(
		{
			request: new Request(url, {
				headers: { cookie: `theme=dark; __Host-dashcommerce_sid=${sid}` },
			}),
		},
		async (req) => {
			received = req;
			return new Response("ok");
		},
	);
	assert.match(received.headers.get("cookie"), new RegExp(`dashcommerce_sid=${sid}`));
	assert.equal(response.headers.has("set-cookie"), false);
});

test("replaces malformed IDs and leaves non-cart/plugin requests untouched", async () => {
	let received;
	const response = await onRequest(
		{ request: new Request(url, { headers: { cookie: "__Host-dashcommerce_sid=../../bad" } }) },
		async (req) => {
			received = req;
			return new Response("ok");
		},
	);
	assert.match(received.headers.get("cookie"), /dashcommerce_sid=[a-f0-9]{64}/);
	assert.match(response.headers.get("set-cookie"), /HttpOnly/);

	const untouched = new Request("https://shop.test/_emdash/api/plugins/other/cart/items");
	let original;
	await onRequest({ request: untouched }, async () => {
		original = untouched;
		return new Response("ok");
	});
	assert.equal(original, untouched);
});

test("rejects cross-origin mutations and unsafe methods before dispatch", async () => {
	const next = async () => {
		throw new Error("Must not dispatch rejected request");
	};
	assert.equal((await onRequest({ request: new Request(`${url}/items`) }, next)).status, 405);
	for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
		assert.equal(
			(await onRequest({ request: new Request(`${url}/items`, { method: "POST", headers }) }, next))
				.status,
			403,
		);
	}
});

test("non-HTTPS sessions omit Secure and never scope beyond the default plugin", async () => {
	let response = await onRequest(
		{ request: new Request(url.replace("https:", "http:")) },
		async () => new Response("ok"),
	);
	assert.doesNotMatch(response.headers.get("set-cookie"), /; Secure/);
	const unrelated = new Request("https://shop.test/cart");
	let called = false;
	await onRequest({ request: unrelated }, async () => {
		called = true;
		return new Response("ok");
	});
	assert.equal(called, true);
});
