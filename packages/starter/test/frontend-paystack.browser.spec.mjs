import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { defineProductsCollection } from "../../core/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let temporary;
let origin;
let processUnderTest;
let database;
let output = "";
let providerStatePath;

async function unusedPort() {
	const listener = createServer();
	await new Promise((done) => listener.listen(0, "127.0.0.1", done));
	const { port } = listener.address();
	await new Promise((done) => listener.close(done));
	return port;
}

function setSetting(key, value) {
	const statement = database.prepare(
		"INSERT INTO options (name,value,revision) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, revision=excluded.revision",
	);
	statement.run(`plugin:dashcommerce:${key}`, JSON.stringify(value), randomUUID());
}

async function waitForServer(url) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
		if (processUnderTest.exitCode !== null) throw new Error(`Starter exited early:\n${output}`);
		try {
			if ((await fetch(url)).ok) return;
		} catch {}
		await new Promise((done) => setTimeout(done, 100));
	}
	throw new Error(`Starter did not become ready:\n${output}`);
}

test.beforeAll(async () => {
	temporary = await mkdtemp(resolve(tmpdir(), "dashcommerce-frontend-browser-"));
	const port = await unusedPort();
	origin = `http://127.0.0.1:${port}`;
	providerStatePath = resolve(temporary, "paystack-state.json");
	await writeFile(
		providerStatePath,
		JSON.stringify({ status: "pending", transactions: {}, calls: [] }),
	);
	const databasePath = resolve(temporary, "data.db");
	const seedPath = resolve(temporary, "seed.json");
	await writeFile(
		seedPath,
		JSON.stringify({
			version: "1",
			meta: { name: "Frontend browser fixture" },
			collections: [defineProductsCollection({ withCategories: false, withTags: false })],
			content: {
				products: [
					{
						id: "browser-personalised-planner",
						slug: "browser-personalised-planner",
						status: "published",
						data: {
							title: "Browser personalised planner",
							sku: "BROWSER-ONLY",
							type: "simple",
							prices: { ZAR: { amount: 25000 } },
							manage_stock: true,
							stock_quantity: 2,
							stock_status: "instock",
							backorders: "no",
							is_virtual: false,
							customisation_definition: {
								fields: [
									{ key: "recipient_name", required: true, maxLength: 30 },
									{ key: "gift_message", maxLength: 60 },
								],
							},
						},
					},
				],
			},
		}),
	);
	const environment = {
		PATH: process.env.PATH,
		HOME: temporary,
		NODE_ENV: "production",
		HOST: "127.0.0.1",
		PORT: String(port),
		SITE_URL: origin,
		EMDASH_SITE_URL: origin,
		EMDASH_ENCRYPTION_KEY: `emdash_enc_v1_${randomBytes(32).toString("base64url")}`,
		DASHCOMMERCE_NETWORK_FIXTURE: "1",
		DASHCOMMERCE_PROVIDER_FIXTURE: providerStatePath,
		DASHCOMMERCE_FIXTURE_KEY: "sk_test_FrontendBrowserFixtureOnly",
	};
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
		{ cwd: temporary, env: environment, stdio: "pipe", timeout: 30_000 },
	);
	database = new DatabaseSync(databasePath);
	const siteSetting = database.prepare(
		"INSERT INTO options (name,value,revision) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value, revision=excluded.revision",
	);
	siteSetting.run("emdash:site_url", JSON.stringify(origin), randomUUID());
	setSetting("settings:defaultCurrency", "ZAR");
	setSetting("settings:enabledCurrencies", ["ZAR"]);
	setSetting("settings:paymentProvider", "paystack");
	setSetting("settings:paystackMode", "test");
	setSetting("settings:paystackTestSecretKey", environment.DASHCOMMERCE_FIXTURE_KEY);
	setSetting("settings:taxMode", "flat");
	setSetting("settings:flatTaxRatePercent", 0);
	const document = database.prepare(
		"INSERT INTO _plugin_storage (plugin_id,collection,id,data,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
	);
	const now = new Date().toISOString();
	for (const [collection, value] of [
		[
			"shipping_zones",
			{
				id: "fixture-zone",
				name: "Fixture ZA",
				locations: [{ country: "ZA" }],
				order: 0,
				createdAt: now,
				updatedAt: now,
			},
		],
		[
			"shipping_methods",
			{
				id: "fixture-rate",
				zoneId: "fixture-zone",
				type: "flat_rate",
				title: "Fixture delivery",
				enabled: true,
				config: { type: "flat_rate", amount: { currency: "ZAR", amount: 5000 } },
				order: 0,
			},
		],
	])
		document.run(
			"dashcommerce",
			collection,
			value.id,
			JSON.stringify(value),
			randomUUID(),
			now,
			now,
		);

	processUnderTest = spawn(
		process.execPath,
		[
			"--import",
			resolve(root, "scripts/fixtures/paystack-network.mjs"),
			resolve(root, "packages/starter/dist/server/entry.mjs"),
		],
		{ cwd: temporary, env: environment, stdio: ["ignore", "pipe", "pipe"] },
	);
	for (const stream of [processUnderTest.stdout, processUnderTest.stderr]) {
		stream.on("data", (chunk) => {
			output = (output + chunk).slice(-60_000);
		});
	}
	await waitForServer(`${origin}/_emdash/api/plugins/dashcommerce/cart`);
});

test.afterAll(async () => {
	database?.close();
	if (processUnderTest && processUnderTest.exitCode === null) {
		processUnderTest.kill("SIGTERM");
		await Promise.race([
			new Promise((done) => processUnderTest.once("exit", done)),
			new Promise((done) => setTimeout(done, 3000)),
		]);
		if (processUnderTest.exitCode === null) processUnderTest.kill("SIGKILL");
	}
	if (temporary) await rm(temporary, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
	await page.route("**/*", (route) =>
		new URL(route.request().url()).origin === origin
			? route.continue()
			: route.abort("blockedbyclient"),
	);
});

test("personalises a line and completes the real backend Paystack TEST browser return", async ({
	page,
}) => {
	let providerNavigationIntercepted = false;
	// Real checkout/verification/order endpoints; only provider traffic is faked.
	await page.route("https://checkout.paystack.com/**", async (route) => {
		providerNavigationIntercepted = true;
		const state = JSON.parse(await readFile(providerStatePath, "utf8"));
		const callback = Object.values(state.transactions)[0].callback_url;
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: `<!doctype html><title>Local provider fixture</title><h1>Paystack TEST fixture</h1><a id="return" href="${callback}?status=success&reference=ignored-by-receipt">Return to shop</a>`,
		});
	});

	await page.goto(`${origin}/shop/browser-personalised-planner`);
	await page.getByLabel("Recipient name *").fill("Alice <img onerror=alert(1)>");
	await page.getByLabel("Gift message").fill("For the blue desk");
	await page.getByRole("button", { name: "Add to cart" }).click();
	const drawer = page.getByRole("complementary", { name: "Shopping cart" });
	await expect(drawer.locator("dt", { hasText: "Recipient name" })).toBeVisible();
	await expect(drawer.locator("dd", { hasText: "Alice <img onerror=alert(1)>" })).toBeVisible();
	await expect(drawer.locator("img")).toHaveCount(0);
	await drawer.getByRole("link", { name: "View cart" }).click();
	const cartCell = page.getByRole("cell", { name: /Browser personalised planner/ });
	await expect(cartCell.locator("dt", { hasText: "Gift message" })).toBeVisible();
	await expect(cartCell.locator("dd", { hasText: "For the blue desk" })).toBeVisible();
	await page.getByRole("link", { name: "Checkout" }).click();

	await expect(page.getByText("Paystack test checkout")).toBeVisible();
	await expect(page.getByText("No real money will move")).toBeVisible();
	await page.getByLabel("Email", { exact: true }).fill("browser-buyer@example.invalid");
	await page.getByLabel("First name", { exact: true }).first().fill("Browser");
	await page.getByLabel("Last name", { exact: true }).first().fill("Buyer");
	await page.getByLabel("Address line 1", { exact: true }).first().fill("1 Fixture Street");
	await page.getByLabel("City", { exact: true }).first().fill("Cape Town");
	await page.getByLabel("State / region", { exact: true }).first().fill("Western Cape");
	await page.getByLabel("Postal code", { exact: true }).first().fill("8001");
	await page.getByLabel("Country (ISO-2)", { exact: true }).first().fill("ZA");
	await page.getByLabel("Billing address is the same as shipping").uncheck();
	await page.getByLabel("First name", { exact: true }).nth(1).fill("Billing");
	await page.getByLabel("Last name", { exact: true }).nth(1).fill("Buyer");
	await page.getByLabel("Address line 1", { exact: true }).nth(1).fill("2 Fixture Avenue");
	await page.getByLabel("City", { exact: true }).nth(1).fill("Johannesburg");
	await page.getByLabel("State / region", { exact: true }).nth(1).fill("Gauteng");
	await page.getByLabel("Postal code", { exact: true }).nth(1).fill("2000");
	await page.getByLabel("Country (ISO-2)", { exact: true }).nth(1).fill("ZA");
	await page.getByRole("button", { name: "Continue to shipping" }).click();
	await expect(page.locator('input[name="hc-method"][value="fixture-rate"]')).toBeChecked();
	await expect(page.getByRole("button", { name: "Continue to Paystack TEST" })).toBeEnabled();
	const savedCart = await page.evaluate(
		async () => (await (await fetch("/_emdash/api/plugins/dashcommerce/cart")).json()).cart,
	);
	expect(savedCart.customerEmail).toBe("browser-buyer@example.invalid");
	expect(savedCart.shippingAddress.line1).toBe("1 Fixture Street");
	expect(savedCart.billingAddress.line1).toBe("2 Fixture Avenue");
	const checkoutResponse = page.waitForResponse((response) =>
		response.url().endsWith("/checkout/create-session"),
	);
	await page.getByRole("button", { name: "Continue to Paystack TEST" }).click();
	const response = await checkoutResponse;
	expect(response.status()).toBe(200);
	expect(response.request().postDataJSON()).toEqual({
		customerEmail: "browser-buyer@example.invalid",
	});
	await expect(page.getByRole("heading", { name: "Paystack TEST fixture" })).toBeVisible();
	expect(providerNavigationIntercepted).toBe(true);
	await page.getByRole("link", { name: "Return to shop" }).click();
	await expect(page.getByRole("heading", { name: "Verifying payment…" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Test payment verified" })).toHaveCount(0);
	const state = JSON.parse(await readFile(providerStatePath, "utf8"));
	await writeFile(`${providerStatePath}.tmp`, JSON.stringify({ ...state, status: "success" }));
	await rename(`${providerStatePath}.tmp`, providerStatePath);
	await expect(page.getByText("TEST MODE · NO REAL PAYMENT")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Test payment verified" })).toBeVisible();
	await expect(page.getByText("No real money moved and no receipt email was sent.")).toBeVisible();
	await expect(page.locator("dt", { hasText: "Recipient name" })).toBeVisible();
	await expect(page.locator("dd", { hasText: "Alice <img onerror=alert(1)>" })).toBeVisible();
	expect(
		database
			.prepare("SELECT count(*) AS count FROM _plugin_storage WHERE collection='orders'")
			.get().count,
	).toBe(1);
	expect(
		database
			.prepare(
				"SELECT count(*) AS count FROM _plugin_storage WHERE collection='commerce_outbox' AND json_extract(data, '$.status')='suppressed'",
			)
			.get().count,
	).toBe(1);
});

test("keeps a provider-looking return query pending until backend authority is paid", async ({
	page,
}) => {
	let backendPaid = false;
	await page.route("**/_emdash/api/plugins/dashcommerce/orders/by-draft?**", async (route) => {
		if (!backendPaid) {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ status: "pending" }),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				status: "ready",
				testMode: true,
				order: {
					id: "test-order",
					orderNumber: "TEST-BROWSER",
					status: "on-hold",
					paymentStatus: "paid",
					paymentProvider: "paystack-test",
					customerEmail: "browser-buyer@example.invalid",
					total: { currency: "ZAR", amount: 25000 },
					currency: "ZAR",
					metadata: { testMode: true },
				},
				items: [
					{
						id: "test-item",
						name: "Browser personalised planner",
						quantity: 1,
						total: { currency: "ZAR", amount: 25000 },
						customisation: { recipient_name: "<script>not markup</script>" },
					},
				],
			}),
		});
	});
	await page.goto(
		`${origin}/thank-you/private-browser-capability?status=success&reference=provider-looking-value`,
	);
	await expect(page.getByRole("heading", { name: "Verifying payment…" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Test payment verified" })).toHaveCount(0);
	backendPaid = true;
	await expect(page.getByRole("heading", { name: "Test payment verified" })).toBeVisible();
	await expect(page.getByText("TEST MODE · NO REAL PAYMENT")).toBeVisible();
	await expect(page.locator("dd", { hasText: "<script>not markup</script>" })).toBeVisible();
	await expect(page.locator("script", { hasText: "not markup" })).toHaveCount(0);
});

test("renders provider review without claiming payment or crashing", async ({ page }) => {
	await page.route("**/_emdash/api/plugins/dashcommerce/orders/by-draft?**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ status: "manual_review" }),
		}),
	);
	await page.goto(`${origin}/thank-you/${"a".repeat(32)}?status=success`);
	await expect(page.getByRole("heading", { name: "Payment needs review" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Test payment verified" })).toHaveCount(0);
});

test("recovers an uncertain initialization through its private status link", async ({ page }) => {
	const state = JSON.parse(await readFile(providerStatePath, "utf8"));
	await writeFile(
		`${providerStatePath}.tmp`,
		JSON.stringify({ ...state, status: "pending", loseInitializeResponseOnce: true }),
	);
	await rename(`${providerStatePath}.tmp`, providerStatePath);
	const product = database
		.prepare("SELECT id FROM ec_products WHERE slug=?")
		.get("browser-personalised-planner");
	const added = await page.request.post(`${origin}/_emdash/api/plugins/dashcommerce/cart/items`, {
		data: { productId: product.id, customisation: { recipient_name: "Recovery fixture" } },
		headers: { origin },
	});
	expect(added.status()).toBe(200);
	await page.goto(`${origin}/checkout`);
	for (const [label, value] of [
		["Email", "recovery@example.invalid"],
		["First name", "Recovery"],
		["Last name", "Fixture"],
		["Address line 1", "3 Fixture Street"],
		["City", "Cape Town"],
		["State / region", "WC"],
		["Postal code", "8000"],
		["Country (ISO-2)", "ZA"],
	]) {
		await page.getByLabel(label, { exact: true }).first().fill(value);
	}
	await page.getByRole("button", { name: "Continue to shipping" }).click();
	await expect(page.getByRole("button", { name: "Continue to Paystack TEST" })).toBeEnabled();
	await page.getByRole("button", { name: "Continue to Paystack TEST" }).click();
	await expect(page.getByRole("link", { name: "Check payment status" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Check payment status before retrying" }),
	).toBeDisabled();
	await page.getByRole("link", { name: "Check payment status" }).click();
	await expect(page.getByRole("heading", { name: "Verifying payment…" })).toBeVisible();
	const pending = JSON.parse(await readFile(providerStatePath, "utf8"));
	await writeFile(`${providerStatePath}.tmp`, JSON.stringify({ ...pending, status: "success" }));
	await rename(`${providerStatePath}.tmp`, providerStatePath);
	await expect(page.getByRole("heading", { name: "Test payment verified" })).toBeVisible();
	expect(
		database
			.prepare("SELECT count(*) AS count FROM _plugin_storage WHERE collection='orders'")
			.get().count,
	).toBe(2);
});

test("refuses an unsupported provider instead of silently falling back", async ({ page }) => {
	setSetting("settings:paymentProvider", "unsupported-browser-fixture");
	await page.goto(`${origin}/checkout`);
	await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
	await expect(page.getByText("The configured payment provider is not supported.")).toBeVisible();
	await expect(page.getByRole("button", { name: /Pay with Stripe|Paystack/i })).toHaveCount(0);
});

test("keeps the existing hosted Stripe UI when Stripe is selected", async ({ page }) => {
	setSetting("settings:paymentProvider", "stripe");
	setSetting("settings:stripeSecretKey", "sk_test_browser_fixture_not_sent");
	setSetting("settings:stripeWebhookSecret", "whsec_browser_fixture_not_sent");
	setSetting("settings:checkoutMode", "hosted");
	await page.goto(`${origin}/checkout`);
	await expect(page.getByText("Secure · Encrypted · Stripe-powered")).toBeVisible();
	await expect(page.getByRole("button", { name: "Pay with Stripe" })).toBeVisible();
	await expect(page.getByText("Paystack test checkout")).toHaveCount(0);
});
