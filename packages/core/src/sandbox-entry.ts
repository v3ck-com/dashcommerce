/**
 * DashCommerce — runtime entry point.
 *
 * Loaded by the emdash runtime on the deployed server (or local dev). This
 * module and everything it transitively imports MUST remain sandbox-safe:
 *
 *   - No Node built-ins (`fs`, `path`, `crypto`, `child_process`, …).
 *   - No `require`.
 *   - All HTTP via `ctx.http.fetch` (honors `allowedHosts`).
 *   - All crypto via `crypto.subtle` (Web Crypto).
 *
 * Emdash's astro integration calls `createPlugin(options)` at build time
 * for native-format plugins (`format: "native"` + `entrypoint` in the
 * descriptor — see src/index.ts). `options` comes from the descriptor's
 * `options` field. We build a native `ResolvedPlugin` with `definePlugin`.
 *
 * emdash 0.28 note: route handlers are the NATIVE single-arg shape
 * `(ctx: RouteContext) => Promise<unknown>`, where `RouteContext` extends
 * `PluginContext` — so `ctx` carries both the request (`ctx.request`,
 * `ctx.input`) and the plugin surface (`ctx.storage`, `ctx.kv`, `ctx.http`…).
 * DashCommerce's route handlers are authored two-arg `(routeCtx, ctx)`; we
 * adapt them to the single-arg form below (passing the one context as both).
 * Webhooks use EmDash 0.41's declared bytes input, rather than rereading
 * the guarded request stream. Request contracts must survive adaptation.
 */

import {
	definePlugin,
	pluginResponse,
	type FieldWidgetConfig,
	type PluginAdminConfig,
	type PluginAdminPage,
	type PluginCapability,
	type PluginContext,
	type PluginDescriptor,
	type PluginRoute,
	type PortableTextBlockConfig,
	type RouteContext,
} from "emdash";

import { productBeforeSave } from "./hooks/content";
import { cronHandler } from "./hooks/cron";
import { onActivate, onInstall } from "./hooks/install";
import { adminApiRoutes } from "./routes/admin-api";
import { paymentOperationsRoutes } from "./routes/payment-operations";
import { cartRoutes } from "./routes/cart";
import { checkoutRoutes } from "./routes/checkout";
import { configCheckRoutes } from "./routes/config-check";
import { customerPortalRoutes } from "./routes/customer-portal";
import { downloadsRoutes } from "./routes/downloads";
import { ordersPublicRoutes } from "./routes/orders-public";
import { validateEmDashCompatibility } from "./version-check";
import { reviewsPublicRoutes } from "./routes/reviews-public";
import { subscriptionsPublicRoutes } from "./routes/subscriptions-public";
import { paystackWebhookRoutes, webhookRoutes } from "./routes/webhook";
import { DASHCOMMERCE_STORAGE } from "./storage-collections";

const DEFAULT_CAPABILITIES: PluginCapability[] = [
	"content:read",
	"content:write",
	"media:read",
	"users:read",
	"network:request",
	"email:send",
];
const DEFAULT_ALLOWED_HOSTS = ["api.stripe.com", "files.stripe.com", "api.paystack.co"];

/**
 * DashCommerce's route handlers are authored in the two-arg convention
 * `(routeCtx, ctx)` — `routeCtx` for request data (`.request`, `.input`) and
 * `ctx` for the plugin surface. In emdash's native format both are the same
 * `RouteContext` (which extends `PluginContext`), so a single context serves
 * as both. This is the loose entry shape those route maps satisfy.
 */
type CommerceRouteEntry = {
	public?: boolean;
	input?: PluginRoute["input"];
	request?: PluginRoute["request"];
	methods?: PluginRoute["methods"];
	handler: (routeCtx: RouteContext, ctx: PluginContext) => Promise<unknown>;
};

const HOOKS = {
	"content:beforeSave": { handler: productBeforeSave },
	cron: { handler: cronHandler },
	"plugin:install": { handler: onInstall },
	"plugin:activate": { handler: onActivate },
};

const ROUTES = {
	...cartRoutes,
	...checkoutRoutes,
	...configCheckRoutes,
	...customerPortalRoutes,
	...downloadsRoutes,
	...ordersPublicRoutes,
	...reviewsPublicRoutes,
	...subscriptionsPublicRoutes,
	...webhookRoutes,
	...paystackWebhookRoutes,
	...adminApiRoutes,
	...paymentOperationsRoutes,
} as unknown as Record<string, CommerceRouteEntry>;

/**
 * Adapt the authored two-arg route handlers into emdash's native single-arg
 * `PluginRoute` form. `RouteContext` extends `PluginContext`, so the one
 * `ctx` is passed as both arguments. `public` and `input` pass through.
 */
async function toPluginResponse(value: unknown): Promise<unknown> {
	if (!(value instanceof Response)) {
		return pluginResponse({
			headers: { "content-type": "application/json; charset=utf-8" },
			body: { kind: "text", value: JSON.stringify({ success: true, data: value }) },
		});
	}
	const body =
		value.body === null
			? null
			: { kind: "bytes" as const, value: new Uint8Array(await value.arrayBuffer()) };
	return pluginResponse({ status: value.status, headers: value.headers, body });
}

const JSON_POST_ROUTES = new Set([
	"cart/items",
	"cart/contact",
	"cart/coupon",
	"cart/currency",
	"cart/shipping-location",
	"cart/shipping-address",
	"cart/shipping-method",
	"checkout/create-intent",
	"checkout/create-session",
]);

function toNativeRoutes(routes: Record<string, CommerceRouteEntry>): Record<string, PluginRoute> {
	const out: Record<string, PluginRoute> = {};
	for (const [name, route] of Object.entries(routes)) {
		out[name] = {
			public: route.public,
			input: route.input,
			request:
				route.request ??
				(JSON_POST_ROUTES.has(name) ? { body: "json", maxBytes: 32768 } : undefined),
			methods: route.methods ?? (JSON_POST_ROUTES.has(name) ? ["POST"] : undefined),
			response: "raw",
			handler: async (ctx) => toPluginResponse(await route.handler(ctx, ctx)),
		};
	}
	return out;
}

/**
 * emdash's `PluginDefinition.storage` requires an `indexes` array on every
 * collection; the descriptor's `storage` declaration leaves it optional.
 * Normalize to the runtime shape.
 */
function toStorageConfig(
	decl: NonNullable<PluginDescriptor["storage"]>,
): Record<string, { indexes: string[]; uniqueIndexes?: string[] }> {
	const out: Record<string, { indexes: string[]; uniqueIndexes?: string[] }> = {};
	for (const [name, cfg] of Object.entries(decl)) {
		out[name] = { indexes: cfg.indexes ?? [], uniqueIndexes: cfg.uniqueIndexes };
	}
	return out;
}

export interface CreatePluginOptions {
	id?: string;
	version?: string;
	capabilities?: PluginCapability[];
	allowedHosts?: string[];
	/**
	 * EmDash version for runtime compatibility check.
	 * Passed from the descriptor after build-time detection.
	 */
	emdashVersion?: string;
}

/**
 * Static admin page list — must match src/index.ts adminPages. Populates
 * `admin.pages`, which the emdash plugin-manager API reads to set
 * `hasAdminPages` and show the Settings gear link on the Plugins page.
 */
const ADMIN_PAGES: PluginAdminPage[] = [
	{ path: "/orders", label: "Orders", icon: "shopping-bag" },
	{ path: "/customers", label: "Customers", icon: "users" },
	{ path: "/coupons", label: "Coupons", icon: "tag" },
	{ path: "/shipping", label: "Shipping", icon: "truck" },
	{ path: "/tax", label: "Tax", icon: "percent" },
	{ path: "/subscriptions", label: "Subscriptions", icon: "repeat" },
	{ path: "/reviews", label: "Reviews", icon: "message-square" },
	{ path: "/vendors", label: "Vendors", icon: "store" },
	{ path: "/menus", label: "Menus", icon: "list" },
	{ path: "/reports", label: "Reports", icon: "bar-chart" },
	{ path: "/payment-operations", label: "Payment operations", icon: "credit-card" },
	{ path: "/settings", label: "Settings", icon: "settings" },
];

const ADMIN_WIDGETS: NonNullable<PluginAdminConfig["widgets"]> = [
	{ id: "revenue-snapshot", title: "Revenue", size: "half" },
	{ id: "low-stock-alerts", title: "Low Stock", size: "half" },
	{ id: "recent-orders", title: "Recent Orders", size: "full" },
	{ id: "pending-reviews", title: "Pending Reviews", size: "third" },
	{ id: "failed-subscriptions", title: "Failed Renewals", size: "third" },
];

// Custom content-field widgets this plugin provides. The content editor
// resolves `widget: "dashcommerce:<name>"` on a field to the React
// component exported from `admin/entry.tsx` under `fields[name]`.
const FIELD_WIDGETS: FieldWidgetConfig[] = [
	{
		name: "vendor-select",
		label: "Vendor picker",
		fieldTypes: ["string"],
	},
	{
		name: "price-map",
		label: "Price map (multi-currency)",
		fieldTypes: ["json"],
	},
];

const PORTABLE_TEXT_BLOCKS: PortableTextBlockConfig[] = [
	{
		type: "product-embed",
		label: "Embed Product",
		icon: "package",
		description: "Embed a single product card inline.",
	},
	{
		type: "product-grid",
		label: "Product Grid",
		icon: "grid",
		description: "Grid of products from a category.",
	},
	{
		type: "review-quote",
		label: "Review Quote",
		icon: "message-circle",
		description: "Inline quote from an approved review.",
	},
];

/**
 * Native-format entry called by emdash with the options serialized from the
 * descriptor (see src/index.ts). Returns a `ResolvedPlugin` ready for the
 * HookPipeline.
 */
export function createPlugin(options: CreatePluginOptions = {}) {
	// Validate EmDash version compatibility before initializing the plugin
	// The version is detected at build time in the descriptor and passed here
	validateEmDashCompatibility(options.emdashVersion);

	return definePlugin({
		id: options.id ?? "dashcommerce",
		version: options.version ?? "0.0.0",
		capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
		allowedHosts: options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS,
		storage: toStorageConfig(DASHCOMMERCE_STORAGE),
		hooks: HOOKS,
		routes: toNativeRoutes(ROUTES),
		admin: {
			// EmDash encrypts declared secrets at rest and registers log redaction.
			settingsSchema: {
				paystackSecretKey: { type: "secret", label: "Legacy Paystack test secret key" },
				paystackTestSecretKey: { type: "secret", label: "Paystack test secret key" },
				paystackLiveSecretKey: { type: "secret", label: "Paystack live secret key" },
				stripeSecretKey: { type: "secret", label: "Stripe secret key" },
				stripeWebhookSecret: { type: "secret", label: "Stripe webhook signing secret" },
			},
			pages: ADMIN_PAGES,
			widgets: ADMIN_WIDGETS,
			fieldWidgets: FIELD_WIDGETS,
			portableTextBlocks: PORTABLE_TEXT_BLOCKS,
		},
	});
}

/**
 * Default export kept for direct-import consumers + tests that read the raw
 * `{ hooks, routes }` definition without going through `createPlugin`.
 */
export default { hooks: HOOKS, routes: ROUTES };
