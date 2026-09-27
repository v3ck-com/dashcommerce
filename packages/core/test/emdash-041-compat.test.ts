import { describe, expect, it, spyOn } from "bun:test";
import { pluginResponse } from "emdash";
import { createPlugin } from "../src/sandbox-entry";
import { dashcommerce } from "../src/index";
import { checkEmDashVersion, validateEmDashCompatibility } from "../src/version-check";
import { detectEmDashVersionAtBuildTime } from "../src/version-detect";

const { t: dispatch } = await import(
	"../node_modules/emdash/dist/http-route-dispatch-CAdp2onn.mjs"
);

async function dispatchFixture(
	pluginId: string,
	result: unknown,
	meta: Record<string, unknown>,
	method = "GET",
) {
	return dispatch({
		pluginId,
		path: "probe",
		request: new Request("https://spike.invalid/probe", { method }),
		runtime: {
			getPluginRouteMeta: () => meta,
			handlePluginApiRoute: async () => ({ success: true, status: 200, data: result }),
		},
	});
}

describe("EmDash 0.41 native host compatibility", () => {
	it("detects and enforces the exact installed package", () => {
		expect(detectEmDashVersionAtBuildTime()).toBe("0.41.0");
		expect(dashcommerce().options?.emdashVersion).toBe("0.41.0");
		for (const version of ["0.37.0", "0.41.1", "0.42.0", "0.41.0-beta.1", "unknown"]) {
			expect(() => checkEmDashVersion(version)).toThrow();
		}
		expect(() => validateEmDashCompatibility()).toThrow();
		expect(() => dashcommerce({ id: "other-store" })).toThrow();
	});

	it("declares raw native responses while retaining method and bounded request metadata", () => {
		const plugin = createPlugin({ emdashVersion: "0.41.0" });
		const routes = plugin.routes as Record<
			string,
			{ response?: string; methods?: string[]; request?: { body: string; maxBytes?: number } }
		>;
		expect(routes["cart/items"]?.response).toBe("raw");
		expect(routes["checkout/webhook"]?.request).toEqual({ body: "bytes", maxBytes: 262144 });
		expect(routes["checkout/webhook"]?.methods).toEqual(["POST"]);
		expect(routes["checkout/paystack-webhook"]?.request).toEqual({
			body: "bytes",
			maxBytes: 262144,
		});
	});

	it("uses installed EmDash raw response policy for status, HEAD and cookie filtering", async () => {
		const result = pluginResponse({
			status: 201,
			headers: {
				"set-cookie": "forbidden=1",
				"content-type": "application/json",
				"cache-control": "public",
			},
			body: { kind: "text", value: '{"ok":true}' },
		});
		const response = await dispatchFixture("dashcommerce", result, {
			public: true,
			response: "raw",
		});
		expect(response.status).toBe(201);
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.text()).toBe('{"ok":true}');
		const head = await dispatchFixture(
			"dashcommerce",
			result,
			{ public: true, response: "raw" },
			"HEAD",
		);
		expect(head.status).toBe(201);
		expect(await head.text()).toBe("");
	});

	it("does not weaken native active-content and public external-redirect rejection", async () => {
		const silence = spyOn(console, "error").mockImplementation(() => {});
		try {
			const html = pluginResponse({
				headers: { "content-type": "text/html" },
				body: { kind: "text", value: "<p>blocked</p>" },
			});
			const redirect = pluginResponse({
				status: 302,
				headers: { location: "https://elsewhere.invalid/" },
			});
			expect(
				(await dispatchFixture("dashcommerce", html, { public: true, response: "raw" })).status,
			).toBe(500);
			expect(
				(await dispatchFixture("dashcommerce", redirect, { public: true, response: "raw" })).status,
			).toBe(500);
		} finally {
			silence.mockRestore();
		}
	});
});
