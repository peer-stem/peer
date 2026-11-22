/**
 * Artifact download helpers (`download.js`).
 * `slugFilename(title)` normalizes demo/artifact titles to safe filename stems;
 * `downloadFile(filename, content, mimeType)` triggers a Blob `<a download>` save
 * and immediately revokes the temporary object URL.
 */

export function slugFilename(title) {
	const slug = String(title ?? "")
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return slug || "demo";
}

export function downloadFile(filename, content, mimeType, doc = globalThis.document) {
	const targetDoc = doc ?? globalThis.document;
	if (!targetDoc?.createElement) return;
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = targetDoc.createElement("a");
	anchor.href = url;
	anchor.download = String(filename ?? "download");
	anchor.click();
	URL.revokeObjectURL(url);
}
