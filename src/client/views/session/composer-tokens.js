/**
 * Pure `@path` token extraction, clipboard image extraction, and `FileReader`
 * PNG/JPEG attachment helpers shared by the session composer, practice dock,
 * and new-session draft input.
 */

const AT_PATH_RE = /(?:^|(?<=\s))@([^\s`]+)/g;
const BACKTICK_PATH_RE = /`(\/[^`\n]+|~\/[^`\n]+|[a-zA-Z]:[\\/][^`\n]+)`/g;
const DATA_URL_PREFIX_RE = /^data:([^;]+);base64,/;

export function basenameOfPath(rawPath) {
	const clean = String(rawPath ?? "").replace(/[\\/]+$/, "");
	if (!clean) return String(rawPath ?? "");
	const parts = clean.split(/[\\/]/);
	return parts[parts.length - 1] || clean;
}

export function extractPathTokens(text) {
	const source = String(text ?? "");
	if (!source) return [];
	const seen = new Set();
	const tokens = [];
	for (const match of source.matchAll(AT_PATH_RE)) {
		const path = match[1];
		const raw = `@${path}`;
		if (!path || seen.has(raw)) continue;
		seen.add(raw);
		tokens.push({ id: raw, raw, path, label: `@${basenameOfPath(path)}` });
	}
	for (const match of source.matchAll(BACKTICK_PATH_RE)) {
		const raw = match[0];
		const path = match[1].trim();
		if (!path || seen.has(raw)) continue;
		seen.add(raw);
		tokens.push({ id: raw, raw, path, label: `@${basenameOfPath(path)}` });
	}
	return tokens;
}

export function removePathTokenFromText(text, rawToken) {
	const source = String(text ?? "");
	const target = String(rawToken ?? "");
	if (!source || !target) return source;
	const idx = source.indexOf(target);
	if (idx === -1) return source;
	const before = source.slice(0, idx);
	const after = source.slice(idx + target.length);
	if (before.endsWith(" ") && after.startsWith(" ")) {
		return `${before}${after.slice(1)}`;
	}
	return `${before}${after}`.replace(/^ +/, "");
}

export function appendPathTokenToText(text, filePath) {
	const clean = String(filePath ?? "").trim();
	if (!clean) return String(text ?? "");
	const token = /\s/.test(clean) ? `\`${clean}\`` : `@${clean}`;
	const current = String(text ?? "");
	if (!current || /\s$/.test(current)) return `${current}${token} `;
	return `${current} ${token} `;
}

export function normalizeImageMime(file) {
	const rawType = String(file?.type ?? "").toLowerCase();
	if (rawType === "image/png") return "image/png";
	if (rawType === "image/jpeg" || rawType === "image/jpg") return "image/jpeg";
	const name = String(file?.name ?? "").toLowerCase();
	if (name.endsWith(".png")) return "image/png";
	if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
	return null;
}

export function extractClipboardImageFiles(clipboardData) {
	if (!clipboardData) return [];
	const out = [];
	const items = Array.from(clipboardData.items ?? []);
	for (const item of items) {
		if (item?.kind !== "file" || typeof item.getAsFile !== "function") continue;
		const file = item.getAsFile();
		if (file && normalizeImageMime(file)) out.push(file);
	}
	if (out.length > 0) return out;
	for (const file of Array.from(clipboardData.files ?? [])) {
		if (normalizeImageMime(file)) out.push(file);
	}
	return out;
}

function parseLoadedImage(result, file, mimeType, seq) {
	const raw = typeof result === "string" ? result : "";
	const stripped = raw.replace(DATA_URL_PREFIX_RE, "");
	if (!stripped) return null;
	return {
		id: `img_${Date.now().toString(36)}_${seq}`,
		name: String(file.name || "pasted-image.png"),
		mimeType,
		data: stripped,
	};
}

function readSingleImageBase64(file, mimeType, seq) {
	return new Promise((resolve) => {
		const ReaderCtor = globalThis.FileReader;
		if (typeof ReaderCtor !== "function") {
			resolve(null);
			return;
		}
		const reader = new ReaderCtor();
		reader.onload = () => resolve(parseLoadedImage(reader.result, file, mimeType, seq));
		reader.onerror = () => resolve(null);
		reader.readAsDataURL(file);
	});
}

let attachSeq = 0;

export async function readDroppedOrPickedFiles(fileList) {
	const files = Array.from(fileList ?? []);
	const images = [];
	const paths = [];
	for (const file of files) {
		const mimeType = normalizeImageMime(file);
		if (mimeType) {
			attachSeq += 1;
			const loaded = await readSingleImageBase64(file, mimeType, attachSeq);
			if (loaded) images.push(loaded);
			continue;
		}
		const nativePath = typeof file?.path === "string" ? file.path.trim() : "";
		if (nativePath) paths.push(nativePath);
	}
	return { images, paths };
}

export function toAttachedImageInputs(images) {
	return images.map((img) => ({
		type: "image",
		mimeType: img.mimeType,
		data: img.data,
	}));
}
