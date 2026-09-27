// TEST PROCESS ONLY. Loaded with Node --import by the disposable HTTP harness.
// Intercepts every outbound fetch; it can never send a real payment request.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, renameSync } from "node:fs";

assert.equal(process.env.DASHCOMMERCE_NETWORK_FIXTURE, "1", "Explicit fixture opt-in required");
const statePath = process.env.DASHCOMMERCE_PROVIDER_FIXTURE;
assert(statePath && process.env.DASHCOMMERCE_FIXTURE_KEY, "Missing isolated fixture configuration");
const read = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => {
	writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
	renameSync(`${statePath}.tmp`, statePath);
};
const json = (data, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const fixtureFetch = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	// EmDash's native SSRF guard resolves allowlisted hosts through DoH.
	// Supply a public DNS fixture without weakening that guard or using the network.
	if (url.origin === "https://cloudflare-dns.com" && url.pathname === "/dns-query") {
		assert.equal(url.searchParams.get("name"), "api.paystack.co");
		assert.equal(request.method, "GET");
		const type = url.searchParams.get("type");
		assert(["A", "AAAA", "1", "28"].includes(type));
		return json({
			Status: 0,
			Answer: [
				{
					name: "api.paystack.co",
					type: ["A", "1"].includes(type) ? 1 : 28,
					TTL: 60,
					data: ["A", "1"].includes(type) ? "1.1.1.1" : "2606:4700:4700::1111",
				},
			],
		});
	}
	assert.equal(url.origin, "https://api.paystack.co", "All non-fixture outbound HTTP is forbidden");
	assert.equal(
		request.headers.get("authorization"),
		`Bearer ${process.env.DASHCOMMERCE_FIXTURE_KEY}`,
	);
	const state = read();
	state.calls ??= [];
	state.calls.push({ method: request.method, path: url.pathname });
	if (url.pathname === "/transaction/initialize" && request.method === "POST") {
		const body = await request.json();
		assert(Number.isSafeInteger(body.amount) && body.amount > 0);
		assert.equal(body.currency, "ZAR");
		assert.equal(typeof body.reference, "string");
		assert.equal(typeof body.email, "string");
		assert(["127.0.0.1", "localhost"].includes(new URL(body.callback_url).hostname));
		if (state.transactions[body.reference]) {
			save(state);
			return json({ status: false, message: "Duplicate Transaction Reference" }, 400);
		}
		state.transactions[body.reference] = {
			...body,
			metadata: typeof body.metadata === "string" ? JSON.parse(body.metadata) : body.metadata,
		};
		const loseResponse = state.loseInitializeResponseOnce;
		delete state.loseInitializeResponseOnce;
		save(state);
		if (loseResponse) throw new Error("Fixture initialization response lost");
		return json({
			status: true,
			message: "Fixture initialized",
			data: {
				reference: body.reference,
				access_code: `fixture_${body.reference}`,
				authorization_url: `https://checkout.paystack.com/fixture_${body.reference}`,
			},
		});
	}
	if (url.pathname.startsWith("/transaction/verify/") && request.method === "GET") {
		const reference = decodeURIComponent(url.pathname.split("/").at(-1));
		const tx = state.transactions[reference];
		save(state);
		if (!tx) return json({ status: false, message: "Transaction not found" }, 404);
		return json({
			status: true,
			message: "Fixture verified",
			data: {
				id: 12345,
				reference,
				amount: tx.amount,
				currency: tx.currency,
				domain: "test",
				status: state.status ?? "success",
				paid_at: new Date().toISOString(),
				customer: { email: tx.email },
				metadata: tx.metadata,
				...(state.verificationOverrides ?? {}),
			},
		});
	}
	throw new Error(`Unexpected fixture provider endpoint: ${request.method} ${url.pathname}`);
};
globalThis.fetch = async (input, init) => {
	try {
		return await fixtureFetch(input, init);
	} catch (error) {
		const state = read();
		state.fixtureErrors ??= [];
		state.fixtureErrors.push(
			String(error.message).replaceAll(process.env.DASHCOMMERCE_FIXTURE_KEY, "<fixture-key>"),
		);
		save(state);
		throw error;
	}
};
