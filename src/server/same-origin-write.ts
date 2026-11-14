import { browserOnlyMode, desktopAPIAuthorized, subscriptionRequestOrigin } from "./desktop-access.ts";

/** A write that aims the server at a URL needs proof it came from the app
 * itself: the desktop secret in desktop mode, otherwise a same-origin `Origin`.
 * Unlike the general browser-only gate, a missing `Origin` is refused. Never
 * trusts forwarded-origin headers. */
export function sameOriginWriteAllowed(request: Request, env: Record<string, string | undefined> = process.env): boolean {
	if (!browserOnlyMode(env)) return desktopAPIAuthorized(request.headers, env);
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	return origin !== null && origin === subscriptionRequestOrigin(request) && (site === null || site === "same-origin");
}
