import { describe, expect, it } from "bun:test";
import { money } from "../src/money";
import { calculateRates, matchesZone, pickZone } from "../src/shipping/calculate";
import type { Address, ShippingZone } from "../src/types";

function zone(
	id: string,
	locations: Array<{ country: string; regions?: string[] }>,
	order = 0,
): ShippingZone {
	return {
		id,
		name: `Zone ${id}`,
		locations,
		order,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function address(country: string, region = "", postalCode = "12345"): Address {
	return {
		firstName: "Test",
		lastName: "User",
		line1: "123 Main St",
		city: "City",
		region,
		postalCode,
		country,
	};
}

describe("shipping zone matching", () => {
	it("matches zone with country-only location (no regions)", () => {
		const z = zone("us", [{ country: "US" }]);
		expect(matchesZone(address("US", "NY"), z)).toBe(true);
		expect(matchesZone(address("US", "CA"), z)).toBe(true);
		expect(matchesZone(address("CA", "ON"), z)).toBe(false);
	});

	it("matches zone with specific regions", () => {
		const z = zone("us-east", [{ country: "US", regions: ["NY", "NJ", "CT"] }]);
		expect(matchesZone(address("US", "NY"), z)).toBe(true);
		expect(matchesZone(address("US", "NJ"), z)).toBe(true);
		expect(matchesZone(address("US", "CA"), z)).toBe(false);
	});

	it("does not match zone with empty locations array", () => {
		const z = zone("empty", []);
		expect(matchesZone(address("US", "NY"), z)).toBe(false);
		expect(matchesZone(address("CA", "ON"), z)).toBe(false);
	});

	it("matches zone with multiple location entries", () => {
		const z = zone("us-ca", [
			{ country: "US", regions: ["CA"] },
			{ country: "CA", regions: ["BC", "ON"] },
		]);
		expect(matchesZone(address("US", "CA"), z)).toBe(true);
		expect(matchesZone(address("CA", "BC"), z)).toBe(true);
		expect(matchesZone(address("US", "NY"), z)).toBe(false);
	});

	it("picks first matching zone by order", () => {
		const zones = [
			zone("all", [{ country: "US" }], 10),
			zone("west", [{ country: "US", regions: ["CA", "OR"] }], 0),
		];
		const caAddr = address("US", "CA");
		const nyAddr = address("US", "NY");
		// CA should match the west zone (order 0) first
		expect(pickZone(caAddr, zones)?.id).toBe("west");
		// NY should match the all zone (order 10) since west doesn't match
		expect(pickZone(nyAddr, zones)?.id).toBe("all");
	});

	it("returns null when no zone matches", () => {
		const zones = [zone("canada", [{ country: "CA" }])];
		expect(pickZone(address("US", "NY"), zones)).toBeNull();
	});

	it("keeps configured flat, free, pickup and weight methods available", () => {
		const items = [
			{
				lineId: "line",
				productId: "p",
				quantity: 2,
				unitPrice: money("USD", 1000),
				lineSubtotal: money("USD", 2000),
				title: "Widget",
				isDigital: false,
				weightGrams: 500,
			},
		];
		const options = calculateRates({
			items,
			currency: "USD",
			methods: [
				{
					id: "flat",
					zoneId: "z",
					type: "flat_rate",
					title: "Flat",
					enabled: true,
					order: 0,
					config: { type: "flat_rate", amount: money("USD", 300) },
				},
				{
					id: "free",
					zoneId: "z",
					type: "free_shipping",
					title: "Free",
					enabled: true,
					order: 1,
					config: { type: "free_shipping", minimumAmount: money("USD", 1500) },
				},
				{
					id: "pickup",
					zoneId: "z",
					type: "local_pickup",
					title: "Pickup",
					enabled: true,
					order: 2,
					config: { type: "local_pickup", amount: money("USD", 100) },
				},
				{
					id: "weight",
					zoneId: "z",
					type: "weight_based",
					title: "Weight",
					enabled: true,
					order: 3,
					config: { type: "weight_based", currency: "USD", base: money("USD", 50), perGram: 1 },
				},
			],
		});
		expect(options.map((option) => [option.methodId, option.amount.amount])).toEqual([
			["flat", 300],
			["free", 0],
			["pickup", 100],
			["weight", 1050],
		]);
	});

	it("fails closed for an unsupported class-rate override and a mismatched free threshold", () => {
		const items = [
			{
				lineId: "line",
				productId: "p",
				quantity: 1,
				unitPrice: money("USD", 2000),
				lineSubtotal: money("USD", 2000),
				title: "Widget",
				isDigital: false,
			},
		];
		const options = calculateRates({
			items,
			currency: "USD",
			methods: [
				{
					id: "classed",
					zoneId: "z",
					type: "flat_rate",
					title: "Classed",
					enabled: true,
					order: 0,
					config: {
						type: "flat_rate",
						amount: money("USD", 100),
						shippingClassRates: { heavy: money("USD", 500) },
					},
				},
				{
					id: "wrong-currency-threshold",
					zoneId: "z",
					type: "free_shipping",
					title: "Free",
					enabled: true,
					order: 1,
					config: { type: "free_shipping", minimumAmount: money("EUR", 1) },
				},
			],
		});
		expect(options).toEqual([]);
	});

	it("matches common US zip codes to US-wide zone", () => {
		const usZone = zone("us", [{ country: "US" }]);
		// Test case from P1: NY 10001
		expect(matchesZone(address("US", "NY", "10001"), usZone)).toBe(true);
		// Test case from P1: CA 90210
		expect(matchesZone(address("US", "CA", "90210"), usZone)).toBe(true);
	});
});
