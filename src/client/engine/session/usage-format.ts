export function formatUsd(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

function subscriptionLabels(subscription: boolean | string | readonly string[] | undefined): string[] {
	if (subscription === true) return ["ChatGPT"];
	if (typeof subscription === "string") return [subscription];
	if (Array.isArray(subscription)) return [...new Set(subscription)];
	return [];
}

export function planCostLabel(
	dollars: number | null,
	subscription: boolean | string | readonly string[] | undefined,
	format = formatUsd,
): string {
	const labels = subscriptionLabels(subscription);
	return [...(dollars === null ? [] : [format(dollars)]), ...labels].join(" + ") || "—";
}

export function formatTokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(n);
}

export function splitQualified(id: string): { provider: string | null; id: string } {
	const colon = id.indexOf(":");
	if (colon === -1) return { provider: null, id };
	return { provider: id.slice(0, colon), id: id.slice(colon + 1) };
}

export function prettyModel(id: string, qualified = false): string {
	const { provider, id: bare } = qualified ? splitQualified(id) : { provider: null, id };
	const short = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
	return provider ? `${short} · ${provider}` : short;
}
