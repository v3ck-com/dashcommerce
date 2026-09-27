import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { startFixture } from "../../../scripts/fixtures/host-harness.mjs";

test("synthetic live-mode checkout and refunds use normal customer language and authoritative states", async ({
	page,
}) => {
	const f = await startFixture({
		provider: "paystack",
		mode: "live",
		admin: true,
		providerStatus: "pending",
	});
	try {
		await page.route("**/*", (route) =>
			new URL(route.request().url()).origin === f.origin
				? route.continue()
				: route.abort("blockedbyclient"),
		);
		await page.route("https://checkout.paystack.com/**", async (route) => {
			const tx = Object.values((await f.provider()).transactions)[0];
			// Synthetic provider handoff: rewrite only the fixture return host to
			// the local HTTP browser server. The gateway generated an HTTPS callback.
			expect(new URL(tx.callback_url).origin).toBe("https://shop.example.invalid");
			const callback = `${f.origin}${new URL(tx.callback_url).pathname}?status=success`;
			await route.fulfill({
				contentType: "text/html",
				body: `<h1>Local provider fixture</h1><a href="${callback}">Return to shop</a>`,
			});
		});
		await page.goto(`${f.origin}/shop/fixture-planner`);
		await page.getByLabel("Name *").fill("Personalised live-path fixture");
		await page.getByRole("button", { name: "Add to cart" }).click();
		await expect(page.getByRole("complementary", { name: "Shopping cart" })).toBeVisible();
		await page.goto(`${f.origin}/checkout`);
		await expect(page.getByText("Paystack test checkout")).toHaveCount(0);
		await expect(page.getByText("No real money will move")).toHaveCount(0);
		for (const [label, value] of Object.entries({
			Email: "browser@example.invalid",
			"First name": "Browser",
			"Last name": "Buyer",
			"Address line 1": "1 Fixture Street",
			City: "Cape Town",
			"State / region": "Western Cape",
			"Postal code": "8001",
			"Country (ISO-2)": "ZA",
		}))
			await page.getByLabel(label, { exact: true }).first().fill(value);
		await page.getByRole("button", { name: "Continue to shipping" }).click();
		await expect(page.getByRole("button", { name: "Pay with Paystack" })).toBeEnabled();
		await page.getByRole("button", { name: "Pay with Paystack" }).click();
		await expect(page.getByRole("heading", { name: "Local provider fixture" })).toBeVisible();
		await page.getByRole("link", { name: "Return to shop" }).click();
		await expect(page.getByRole("heading", { name: "Verifying payment…" })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Payment confirmed", exact: true })).toHaveCount(
			0,
		);
		await f.setProvider({ status: "success" });
		await expect(
			page.getByRole("heading", { name: "Payment confirmed", exact: true }),
		).toBeVisible();
		await expect(page.getByText("TEST MODE · NO REAL PAYMENT")).toHaveCount(0);
		expect(f.documents("orders")[0].paymentMode).toBe("live");
		expect(f.documents("commerce_outbox")[0].status).toBe("pending");
		const order = f.documents("orders")[0];
		const payload = {
			amount: order.paidTotal.amount,
			currency: "ZAR",
			idempotencyKey: `browser_${randomUUID()}`,
			restock: true,
			lineItemRefunds: f
				.documents("order_items")
				.map((item) => ({
					orderItemId: item.id,
					quantity: item.quantity,
					amount: item.total.amount,
					currency: "ZAR",
				})),
		};
		const issue = () =>
			f.adminRequest(`admin/orders/refund?id=${order.id}`, {
				method: "POST",
				body: JSON.stringify(payload),
			});
		expect((await issue()).status).toBe(200);
		await page.reload();
		await expect(
			page.getByText("A refund request is awaiting confirmation.", { exact: false }),
		).toBeVisible();
		await expect(page.getByRole("heading", { name: "Payment refunded", exact: true })).toHaveCount(
			0,
		);
		await f.setProvider({ refundStatus: "processed" });
		expect((await issue()).status).toBe(200);
		await page.reload();
		await expect(
			page.getByRole("heading", { name: "Payment refunded", exact: true }),
		).toBeVisible();
		await expect(page.getByRole("heading", { name: "Verifying payment…" })).toHaveCount(0);
		expect(f.documents("refunds")[0].effectsFinalized).toBe(true);
	} catch (error) {
		console.error(f.logs());
		throw error;
	} finally {
		await f.close();
	}
});
