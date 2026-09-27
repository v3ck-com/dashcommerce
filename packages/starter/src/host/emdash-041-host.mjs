const SID_COOKIE = "dashcommerce_sid";
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_ROUTE =
	/^\/_emdash\/api\/plugins\/dashcommerce\/(?:cart(?:\/.*)?|checkout\/(?:create-intent|create-session))$/;
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function parseSessionId(cookieHeader, name) {
	for (const item of cookieHeader.split(";")) {
		const separator = item.indexOf("=");
		if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
		const value = item.slice(separator + 1).trim();
		return SESSION_ID_PATTERN.test(value) ? value : null;
	}
	return null;
}

function newSessionId() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieHeader(id, secure) {
	return `${secure ? "__Host-dashcommerce_sid" : SID_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure ? "; Secure" : ""}`;
}

/** Astro middleware: inject only the validated cart SID into the dispatch request. */
export async function onRequest(context, next) {
	const url = new URL(context.request.url);
	if (!SESSION_ROUTE.test(url.pathname)) return next();

	const route = url.pathname.split("/dashcommerce/")[1];
	const methods =
		route === "cart"
			? ["GET", "HEAD"]
			: route === "cart/item"
				? ["PATCH", "DELETE"]
				: route === "cart/clear"
					? ["POST", "DELETE"]
					: route === "cart/coupon/remove"
						? ["DELETE"]
						: route === "cart/restore"
							? ["GET"]
							: route === "cart/shipping-methods"
								? ["GET", "POST"]
								: ["POST"];
	const method = context.request.method.toUpperCase();
	if (!methods.includes(method))
		return Response.json(
			{ error: "Method not allowed" },
			{
				status: 405,
				headers: { Allow: methods.join(", "), "Cache-Control": "private, no-store" },
			},
		);
	if (!["GET", "HEAD"].includes(method)) {
		const origin = context.request.headers.get("origin");
		if (
			(origin && origin !== url.origin) ||
			context.request.headers.get("sec-fetch-site") === "cross-site"
		) {
			return Response.json(
				{ error: "Cross-origin cart request rejected" },
				{
					status: 403,
					headers: { "Cache-Control": "private, no-store" },
				},
			);
		}
	}

	const secure = url.protocol === "https:";
	// The HTTPS __Host- prefix prevents sibling-domain cookie fixation.
	const current = parseSessionId(
		context.request.headers.get("cookie") ?? "",
		secure ? "__Host-dashcommerce_sid" : SID_COOKIE,
	);
	const sessionId = current ?? newSessionId();
	const headers = new Headers(context.request.headers);
	const remainingCookies = (headers.get("cookie") ?? "")
		.split(";")
		.filter(
			(part) =>
				part.trim() &&
				![SID_COOKIE, "__Host-dashcommerce_sid"].includes(part.slice(0, part.indexOf("=")).trim()),
		);
	remainingCookies.push(`${SID_COOKIE}=${sessionId}`);
	headers.set("cookie", remainingCookies.join("; "));

	// Astro's immutable incoming Headers must not be mutated in-place. Rewriting
	// with a fresh Request makes the exact injected cookie reach EmDash dispatch.
	const request = new Request(context.request, { headers });
	const response = await next(request);
	const output = new Response(response.body, response);
	// Never forward a plugin-controlled cookie; this middleware owns this one cookie.
	output.headers.delete("Set-Cookie");
	output.headers.set("Cache-Control", "private, no-store");
	if (!current) output.headers.append("Set-Cookie", cookieHeader(sessionId, secure));
	return output;
}

/** Astro integration to register the trusted pre-dispatch middleware. */
export function emdash041Host() {
	return {
		name: "dashcommerce:emdash-041-host",
		hooks: {
			"astro:config:setup"({ addMiddleware }) {
				addMiddleware({
					entrypoint: new URL("./emdash-041-host.mjs", import.meta.url),
					order: "pre",
				});
			},
		},
	};
}
