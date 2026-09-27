// Isolated real HTTP smoke for the pinned EmDash/Astro host bridge (Node + SQLite).
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defineProductsCollection } from "../packages/core/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(resolve(tmpdir(), "dashcommerce-host-"));
let child;
let db;
let log = "";
try {
	const probe = createServer();
	await new Promise((done) => probe.listen(0, "127.0.0.1", done));
	const port = probe.address().port;
	await new Promise((done) => probe.close(done));
	const origin = `http://127.0.0.1:${port}`;
	const env = {
		PATH: process.env.PATH,
		HOME: temporary,
		NODE_ENV: "production",
		HOST: "127.0.0.1",
		PORT: String(port),
		SITE_URL: origin,
		EMDASH_SITE_URL: origin,
		EMDASH_ENCRYPTION_KEY: `emdash_enc_v1_${randomBytes(32).toString("base64url")}`,
	};
	const dbPath = resolve(temporary, "data.db");
	const seedPath = resolve(temporary, "seed.json");
	await writeFile(
		seedPath,
		JSON.stringify({
			version: "1",
			meta: { name: "Isolated host compatibility fixture" },
			collections: [defineProductsCollection({ withCategories: false, withTags: false })],
			content: { products: [] },
		}),
	);
	execFileSync(
		process.execPath,
		[
			resolve(root, "packages/core/node_modules/emdash/dist/cli/index.mjs"),
			"seed",
			seedPath,
			"--database",
			dbPath,
			"--uploads-dir",
			resolve(temporary, "uploads"),
		],
		{ cwd: temporary, env, stdio: "pipe", timeout: 30000 },
	);
	db = new DatabaseSync(dbPath);
	const settings = db.prepare(
		"INSERT INTO options (name,value,revision) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, revision=excluded.revision",
	);
	settings.run("emdash:site_url", JSON.stringify(origin), randomUUID());
	child = spawn(process.execPath, [resolve(root, "packages/starter/dist/server/entry.mjs")], {
		cwd: temporary,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk) => {
			log = (log + chunk).slice(-30000);
		});
	const endpoint = `${origin}/_emdash/api/plugins/dashcommerce/cart`;
	let ready = false;
	for (let i = 0; i < 150; i++) {
		if (child.exitCode !== null) throw new Error(`Host exited: ${log}`);
		try {
			if ((await fetch(endpoint)).ok) {
				ready = true;
				break;
			}
		} catch {}
		await new Promise((done) => setTimeout(done, 100));
	}
	assert(ready, `EmDash host did not start: ${log}`);
	const first = await fetch(endpoint);
	assert.equal(first.status, 200);
	assert.equal(first.headers.get("cache-control"), "private, no-store");
	assert.equal(first.headers.get("x-content-type-options"), "nosniff");
	const cookie = first.headers.get("set-cookie");
	assert.match(
		cookie ?? "",
		/^dashcommerce_sid=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
	);
	const cookiePair = cookie.split(";")[0];
	const next = await fetch(endpoint, { headers: { cookie: cookiePair } });
	assert.equal(next.status, 200);
	assert.equal(next.headers.has("set-cookie"), false);
	const head = await fetch(endpoint, { method: "HEAD", headers: { cookie: cookiePair } });
	assert.equal(head.status, 200);
	assert.equal(await head.text(), "");
	const invalidInput = await fetch(`${endpoint}/items`, {
		method: "POST",
		headers: { cookie: cookiePair, "content-type": "application/json" },
		body: "{}",
	});
	assert.equal(invalidInput.status, 400);
	console.log(
		"PASS: real EmDash 0.41 dispatcher over Node HTTP/SQLite; host cookie injected before cart dispatch, valid cookie reused, private cache, HEAD/status, and method policy preserved.",
	);
} catch (error) {
	console.error(log);
	throw error;
} finally {
	db?.close();
	if (child && child.exitCode === null) {
		child.kill("SIGTERM");
		await Promise.race([
			new Promise((done) => child.once("exit", done)),
			new Promise((done) => setTimeout(done, 3000)),
		]);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	await rm(temporary, { recursive: true, force: true });
}
