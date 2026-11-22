/**
 * Two render/display-only repairs for generated SVG strings rendered via `<img src="data:image/svg+xml,...">`.
 * Never mutates stored artifacts or downloads; comments, CDATA, and PIs are copied verbatim.
 */

const SVG_TOKEN_RE =
	/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\?[\s\S]*?(?:\?>|$)|<\/?[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>|&nbsp;/g;
const ATTR_NAME_RE = /\s([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;

function ensureRootXmlns(token: string): string {
	const attrs = token.matchAll(ATTR_NAME_RE);
	const hasNamespace = Array.from(attrs).some((attr) => attr[1] === "xmlns");
	return hasNamespace ? token : token.replace(/^<svg/i, '$& xmlns="http://www.w3.org/2000/svg"');
}

export function svgImageSource(svg: string): string {
	let foundRoot = false;
	return svg.replace(SVG_TOKEN_RE, (raw) => {
		if (raw.startsWith("<!--") || raw.startsWith("<![CDATA[") || raw.startsWith("<?")) return raw;
		let token = raw;
		if (!foundRoot && /^<svg(?=[\s/>])/i.test(token)) {
			foundRoot = true;
			token = ensureRootXmlns(token);
		}
		return token.replace(/&nbsp;/g, "&#160;");
	});
}
