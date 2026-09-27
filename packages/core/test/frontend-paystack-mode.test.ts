import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type PollResponse,
	hasPaymentModeConflict,
	isTestOrder,
} from "../src/astro/islands/OrderSummaryIsland";
import {
	DEFAULT_PAYSTACK_MODE,
	SECRET_SETTINGS_KEYS,
	validateSettings,
	validateSettingsKey,
} from "../src/settings/schema";

function ready(
	overrides: Record<string, unknown> = {},
): Extract<PollResponse, { status: "ready" }> {
	return {
		status: "ready",
		order: {
			id: "order-1",
			orderNumber: "1001",
			status: "processing",
			paymentStatus: "paid",
			paymentProvider: "paystack",
			customerEmail: "buyer@example.invalid",
			total: { currency: "ZAR", amount: 1000 },
			currency: "ZAR",
		},
		items: [],
		...overrides,
	} as Extract<PollResponse, { status: "ready" }>;
}

describe("Paystack frontend configuration", () => {
	it("supports the normal gateway and keeps the compatibility alias", () => {
		expect(validateSettingsKey("paymentProvider", "paystack")).toEqual({
			ok: true,
			value: "paystack",
		});
		expect(validateSettingsKey("paymentProvider", "paystack-test").ok).toBe(true);
		expect(DEFAULT_PAYSTACK_MODE).toBe("test");
		expect(validateSettingsKey("paystackMode", "test").ok).toBe(true);
		expect(validateSettingsKey("paystackMode", "live").ok).toBe(true);
		expect(validateSettingsKey("paystackMode", "production").ok).toBe(false);
		expect(validateSettingsKey("receiptEmailEnabled", true).ok).toBe(true);
		expect(validateSettingsKey("receiptEmailEnabled", "true").ok).toBe(false);
	});

	it("cannot put an environment key in the other environment's field", () => {
		expect(validateSettingsKey("paystackTestSecretKey", "sk_test_FAKE000").ok).toBe(true);
		expect(validateSettingsKey("paystackTestSecretKey", "sk_live_FAKE000").ok).toBe(false);
		expect(validateSettingsKey("paystackLiveSecretKey", "sk_live_FAKE000").ok).toBe(true);
		expect(validateSettingsKey("paystackLiveSecretKey", "sk_test_FAKE000").ok).toBe(false);
		expect(validateSettingsKey("paystackSecretKey", "sk_live_FAKE000").ok).toBe(false);
		for (const key of ["paystackTestSecretKey", "paystackLiveSecretKey", "paystackSecretKey"]) {
			expect(SECRET_SETTINGS_KEYS.has(key)).toBe(true);
		}
	});

	it("allows a mode-only save without writing or clearing secrets", () => {
		const report = validateSettings({
			paystackMode: "live",
			paystackTestSecretKey: "••••0000",
			paystackLiveSecretKey: "••••1111",
		});
		expect(report).toEqual({ ok: true, values: { paystackMode: "live" }, errors: {} });
	});

	it("does not read Paystack secrets in the storefront page", () => {
		const source = readFileSync(
			new URL("../../starter/src/pages/checkout.astro", import.meta.url),
			"utf8",
		);
		expect(source).toContain('getPluginSetting("dashcommerce", "paystackMode")');
		expect(source).not.toMatch(/getPluginSetting\([^\n]+paystack(?:Test|Live)?SecretKey/);
	});
});

describe("immutable order mode display", () => {
	it("uses normal copy eligibility for an explicitly live Paystack order", () => {
		const result = ready({
			mode: "live",
			testMode: false,
			order: { ...ready().order, paymentMode: "live", metadata: { testMode: false } },
		});
		expect(hasPaymentModeConflict(result)).toBe(false);
		expect(isTestOrder(result)).toBe(false);
	});

	it("retains test display for new test mode and the legacy alias", () => {
		const explicit = ready({
			mode: "test",
			testMode: true,
			order: { ...ready().order, paymentMode: "test" },
		});
		const legacy = ready({
			order: { ...ready().order, paymentProvider: "paystack-test" },
		});
		expect(isTestOrder(explicit)).toBe(true);
		expect(isTestOrder(legacy)).toBe(true);
	});

	it("refuses to present conflicting or missing Paystack environment fields as confirmed", () => {
		const conflict = ready({
			mode: "live",
			testMode: true,
			order: { ...ready().order, paymentMode: "live" },
		});
		const missing = ready();
		expect(hasPaymentModeConflict(conflict)).toBe(true);
		expect(hasPaymentModeConflict(missing)).toBe(true);
	});
});
