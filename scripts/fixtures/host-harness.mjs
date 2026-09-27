import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defineProductsCollection } from "../../packages/core/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const address = {
	firstName: "Fixture",
	lastName: "Buyer",
	line1: "1 Test Street",
	city: "Cape Town",
	region: "WC",
	postalCode: "8000",
	country: "ZA",
};

/** Real built application; all data, keys, and provider responses are synthetic. */
export async function startFixture({
	stock = 2,
	providerStatus = "success",
	provider = "paystack-test",
	mode = "test",
	admin = false,
	product = {},
} = {}) {
	const temporary = await mkdtemp(resolve(tmpdir(), "dashcommerce-http-"));
	let child;
	let db;
	let logs = "";
	const stop = async () => {
		if (child && child.exitCode === null) {
			const exited = new Promise((done) => child.once("exit", done));
			child.kill("SIGTERM");
			await Promise.race([exited, new Promise((done) => setTimeout(done, 3000))]);
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
		}
	};
	const close = async () => {
		await stop();
		db?.close();
		await rm(temporary, { recursive: true, force: true });
	};
	try {
		const listener = createServer();
		await new Promise((done) => listener.listen(0, "127.0.0.1", done));
		const port = listener.address().port;
		await new Promise((done) => listener.close(done));
		const origin = `http://127.0.0.1:${port}`;
		const canonical = mode === "live" ? "https://shop.example.invalid" : origin;
		const key = `sk_${mode}_${randomBytes(20).toString("hex")}`;
		const providerPath = resolve(temporary, "provider.json");
		await writeFile(
			providerPath,
			JSON.stringify({ transactions: {}, refunds: {}, status: providerStatus, mode, calls: [] }),
		);
		const env = {
			PATH: process.env.PATH,
			HOME: temporary,
			NODE_ENV: "production",
			HOST: "127.0.0.1",
			PORT: String(port),
			SITE_URL: canonical,
			EMDASH_SITE_URL: canonical,
			EMDASH_ENCRYPTION_KEY: `emdash_enc_v1_${randomBytes(32).toString("base64url")}`,
			DASHCOMMERCE_NETWORK_FIXTURE: "1",
			DASHCOMMERCE_PROVIDER_FIXTURE: providerPath,
			DASHCOMMERCE_FIXTURE_KEY: key,
		};
		const seedPath = resolve(temporary, "seed.json");
		const databasePath = resolve(temporary, "data.db");
		const base = JSON.parse(
			await readFile(resolve(root, "packages/starter/.emdash/seed.json"), "utf8"),
		);
		await writeFile(
			seedPath,
			JSON.stringify({
				version: "1",
				meta: { name: "Disposable test fixture" },
				settings: { title: "Fixture shop" },
				collections: [
					...base.collections.filter((collection) => collection.slug !== "products"),
					defineProductsCollection(),
				],
				taxonomies: base.taxonomies,
				content: {
					products: [
						{
							id: "fixture-planner",
							slug: "fixture-planner",
							status: "published",
							data: {
								title: "Personalised fixture planner",
								sku: "FIXTURE-ONLY",
								type: "simple",
								prices: { ZAR: { amount: 25000 } },
								manage_stock: true,
								stock_quantity: stock,
								stock_status: "instock",
								backorders: "no",
								is_virtual: false,
								customisation_definition: {
									fields: [{ key: "name", required: true, maxLength: 30 }],
								},
								...product,
							},
						},
					],
				},
			}),
		);
		execFileSync(
			process.execPath,
			[
				resolve(root, "packages/core/node_modules/emdash/dist/cli/index.mjs"),
				"seed",
				seedPath,
				"--database",
				databasePath,
				"--uploads-dir",
				resolve(temporary, "uploads"),
			],
			{ cwd: temporary, env, stdio: "pipe", encoding: "utf8", timeout: 30000 },
		);
		db = new DatabaseSync(databasePath);
		const option = db.prepare(
			"INSERT INTO options (name,value,revision) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, revision=excluded.revision",
		);
		const setOption = (name, value) => option.run(name, JSON.stringify(value), randomUUID());
		setOption("emdash:site_url", canonical);
		setOption("emdash:setup_complete", true);
		// Real native bearer authentication when requested; no auth bypass route.
		const owner = randomUUID();
		db.prepare(
			"INSERT INTO users (id,email,name,role,email_verified,disabled) VALUES (?,?,?,?,?,?)",
		).run(owner, "owner@example.invalid", "Synthetic fixture owner", 50, 0, admin ? 0 : 1);
		const adminToken = `ec_pat_${randomBytes(32).toString("base64url")}`;
		if (admin)
			db.prepare(
				"INSERT INTO _emdash_api_tokens (id,name,token_hash,prefix,user_id,scopes,expires_at) VALUES (?,?,?,?,?,?,?)",
			).run(
				randomUUID(),
				"Disposable fixture token",
				createHash("sha256").update(adminToken).digest("base64url"),
				adminToken.slice(0, 10),
				owner,
				JSON.stringify(["admin"]),
				new Date(Date.now() + 600000).toISOString(),
			);
		const set = (keyName, value) => setOption(`plugin:dashcommerce:${keyName}`, value);
		set("settings:defaultCurrency", "ZAR");
		set("settings:enabledCurrencies", ["ZAR"]);
		set("settings:paymentProvider", provider);
		set("settings:paystackMode", mode);
		set(mode === "live" ? "settings:paystackLiveSecretKey" : "settings:paystackTestSecretKey", key);
		if (mode === "test") set("settings:paystackSecretKey", key);
		set("settings:checkoutMode", "hosted");
		set("settings:taxMode", "flat");
		set("settings:flatTaxRatePercent", 0);
		const document = db.prepare(
			"INSERT INTO _plugin_storage (plugin_id,collection,id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(plugin_id,collection,id) DO UPDATE SET data=excluded.data, revision=excluded.revision",
		);
		const put = (collection, id, value) => {
			const now = new Date().toISOString();
			document.run("dashcommerce", collection, id, JSON.stringify(value), randomUUID(), now, now);
		};
		put("shipping_zones", "zone-za", {
			id: "zone-za",
			name: "Fixture ZA",
			locations: [{ country: "ZA" }],
			order: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		put("shipping_methods", "fixture-flat", {
			id: "fixture-flat",
			zoneId: "zone-za",
			type: "flat_rate",
			title: "Fixture delivery",
			enabled: true,
			config: { type: "flat_rate", amount: { currency: "ZAR", amount: 5000 } },
			order: 0,
		});
		const productId = db
			.prepare("SELECT id FROM ec_products WHERE slug=?")
			.get("fixture-planner").id;
		const endpoint = (route) => `${origin}/_emdash/api/plugins/dashcommerce/${route}`;
		const start = async () => {
			child = spawn(
				process.execPath,
				[
					"--import",
					resolve(root, "scripts/fixtures/paystack-network.mjs"),
					resolve(root, "packages/starter/dist/server/entry.mjs"),
				],
				{ cwd: temporary, env, stdio: ["ignore", "pipe", "pipe"] },
			);
			for (const stream of [child.stdout, child.stderr])
				stream.on("data", (chunk) => {
					logs = (logs + chunk).slice(-60000);
				});
			for (let attempt = 0; attempt < 150; attempt++) {
				if (child.exitCode !== null) throw new Error(`Fixture server exited: ${logs}`);
				try {
					if ((await fetch(endpoint("cart"))).ok) return;
				} catch {}
				await new Promise((done) => setTimeout(done, 100));
			}
			throw new Error(`Fixture server did not start: ${logs}`);
		};
		await start();
		const first = await fetch(endpoint("cart"));
		assert.equal(first.status, 200);
		const cookie = first.headers.get("set-cookie")?.split(";")[0];
		assert(cookie?.startsWith("dashcommerce_sid="));
		const post = (route, body, headers = {}) =>
			fetch(endpoint(route), {
				method: "POST",
				headers: { "content-type": "application/json", origin, cookie, ...headers },
				body: JSON.stringify(body),
			});
		const documents = (collection) =>
			db
				.prepare("SELECT id,data FROM _plugin_storage WHERE plugin_id=? AND collection=?")
				.all("dashcommerce", collection)
				.map((row) => ({ ...JSON.parse(row.data), id: row.id }));
		return {
			origin,
			providerId: provider,
			mode,
			adminRequest: (route, init = {}) => {
				assert(admin, "Fixture administrator was not enabled");
				return fetch(endpoint(route), {
					...init,
					headers: {
						origin,
						"content-type": "application/json",
						...init.headers,
						authorization: `Bearer ${adminToken}`,
					},
				});
			},
			endpoint,
			productId,
			cookie,
			key,
			db,
			set,
			put,
			post,
			documents,
			close,
			logs: () => logs,
			provider: async () => JSON.parse(await readFile(providerPath, "utf8")),
			setProvider: async (patch) => {
				const state = JSON.parse(await readFile(providerPath, "utf8"));
				await writeFile(providerPath, JSON.stringify({ ...state, ...patch }));
			},
			restart: async () => {
				await stop();
				await start();
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
