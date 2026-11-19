import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ROOT } from "@/config.ts";
import type { Dispatch } from "./types.ts";

export interface StaticHandlerOptions {
	repoRoot?: string;
}

type VendorPackageName = "cloudcanvas" | "cloudcanvas-lib";

interface ResolvedFile {
	realTarget: string;
	size: number;
}

interface VendorMountInfo {
	realRoot: string;
	allowlist: readonly string[];
}

type ParsedStaticPath =
	| { readonly kind: "bad-request" }
	| { readonly kind: "not-found" }
	| { readonly kind: "spa" }
	| { readonly kind: "asset"; readonly segments: readonly string[] };

const ALLOWED_VENDORS = new Set<string>(["cloudcanvas", "cloudcanvas-lib"]);
const ALLOWED_CLIENT_SRC_EXTS = new Set<string>([".js", ".css", ".json", ".svg"]);

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".ttf": "font/ttf",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
	".zip": "application/zip",
};

function contentTypeFor(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return MIME_TYPES[ext] ?? "application/octet-stream";
}

function decodeSegment(raw: string): string | null {
	try {
		return decodeURIComponent(raw);
	} catch {
		return null;
	}
}

function isSafeSegment(segment: string): boolean {
	if (segment === "" || segment.startsWith(".")) return false;
	return !segment.includes("/") && !segment.includes("\\") && !segment.includes("\0");
}

function isSpaRoute(segments: readonly string[]): boolean {
	if (segments.length === 0) return true;
	if (segments.length === 1) return segments[0] === "settings";
	if (segments.length === 2) return segments[0] === "chat";
	if (segments.length === 3) return segments[0] === "plugins";
	return false;
}

function parseRequestPath(requestUrl: string): ParsedStaticPath {
	const { pathname } = new URL(requestUrl);
	const rawSegments = pathname.split("/").filter((segment) => segment.length > 0);
	const segments: string[] = [];
	for (const raw of rawSegments) {
		const decoded = decodeSegment(raw);
		if (decoded === null) return { kind: "bad-request" };
		if (!isSafeSegment(decoded)) return { kind: "not-found" };
		segments.push(decoded);
	}
	if (pathname.includes("//")) return { kind: "not-found" };
	if (isSpaRoute(segments)) return { kind: "spa" };
	if (pathname.endsWith("/") || segments.length === 0) return { kind: "not-found" };
	return { kind: "asset", segments };
}

function isContainedInRoot(realRoot: string, realTarget: string): boolean {
	const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
	return realTarget !== realRoot && realTarget.startsWith(rootPrefix);
}

async function resolveStaticFile(realRoot: string, segments: readonly string[]): Promise<ResolvedFile | null> {
	try {
		const realTarget = await fs.realpath(path.join(realRoot, ...segments));
		if (!isContainedInRoot(realRoot, realTarget)) return null;
		const stat = await fs.stat(realTarget);
		if (!stat.isFile()) return null;
		return { realTarget, size: stat.size };
	} catch {
		return null;
	}
}

function normalizeVendorFileEntry(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const clean = raw.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
	if (!clean || clean === "." || clean === ".." || clean.includes("*") || clean.includes("\\")) return null;
	const parts = clean.split("/");
	return parts.every((part) => isSafeSegment(part)) ? clean : null;
}

function isVendorPathAllowed(allowlist: readonly string[], relSegments: readonly string[]): boolean {
	if (relSegments.length === 0 || !relSegments.every((seg) => isSafeSegment(seg))) return false;
	const relPosix = relSegments.join("/");
	return allowlist.some((entry) => relPosix === entry || relPosix.startsWith(`${entry}/`));
}

async function loadVendorMountInfo(repoRootDir: string, vendorName: VendorPackageName): Promise<VendorMountInfo | null> {
	try {
		const realRoot = await fs.realpath(path.join(repoRootDir, "extern", vendorName));
		const pkgFile = await resolveStaticFile(realRoot, ["package.json"]);
		if (!pkgFile) return null;
		const parsed = JSON.parse(await fs.readFile(pkgFile.realTarget, "utf8")) as { files?: unknown };
		if (!Array.isArray(parsed.files)) return null;
		const allowlist = parsed.files
			.map((entry) => normalizeVendorFileEntry(entry))
			.filter((entry): entry is string => entry !== null);
		return { realRoot, allowlist };
	} catch {
		return null;
	}
}

function isAllowedClientSrcPath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".d.ts") || lower.endsWith(".ts") || lower.endsWith(".tsx")) return false;
	return ALLOWED_CLIENT_SRC_EXTS.has(path.extname(lower));
}

function createLazyRealpath(targetDir: string): () => Promise<string | null> {
	const resolvedDir = path.resolve(targetDir);
	let cached: Promise<string | null> | null = null;
	return () => {
		cached ??= fs.realpath(resolvedDir).catch(() => {
			cached = null;
			return null;
		});
		return cached;
	};
}

function createVendorMountResolver(repoRootDir: string): (name: VendorPackageName) => Promise<VendorMountInfo | null> {
	const cache = new Map<VendorPackageName, Promise<VendorMountInfo | null>>();
	return (name: VendorPackageName) => {
		const cached = cache.get(name);
		if (cached) return cached;
		const pending = loadVendorMountInfo(repoRootDir, name).then((info) => {
			if (!info) cache.delete(name);
			return info;
		});
		cache.set(name, pending);
		return pending;
	};
}

interface MountResolvers {
	resolvePublicRoot: () => Promise<string | null>;
	resolveClientSrcRoot: () => Promise<string | null>;
	resolveVendorMount: (name: VendorPackageName) => Promise<VendorMountInfo | null>;
}

async function resolveVendorAsset(
	resolvers: MountResolvers,
	segments: readonly string[],
): Promise<ResolvedFile | null> {
	const vendorName = segments[2];
	if (segments.length < 4 || !vendorName || !ALLOWED_VENDORS.has(vendorName)) return null;
	const vendor = await resolvers.resolveVendorMount(vendorName as VendorPackageName);
	if (!vendor) return null;
	const relSegments = segments.slice(3);
	if (!isVendorPathAllowed(vendor.allowlist, relSegments)) return null;
	const resolved = await resolveStaticFile(vendor.realRoot, relSegments);
	if (!resolved) return null;
	const realRel = path.relative(vendor.realRoot, resolved.realTarget).split(path.sep);
	return isVendorPathAllowed(vendor.allowlist, realRel) ? resolved : null;
}

async function resolveClientSrcAsset(
	resolvers: MountResolvers,
	segments: readonly string[],
): Promise<ResolvedFile | null> {
	const lastSegment = segments[segments.length - 1];
	if (segments.length < 3 || !lastSegment || !isAllowedClientSrcPath(lastSegment)) return null;
	const realClientRoot = await resolvers.resolveClientSrcRoot();
	if (!realClientRoot) return null;
	const resolved = await resolveStaticFile(realClientRoot, segments.slice(2));
	if (!resolved || !isAllowedClientSrcPath(resolved.realTarget)) return null;
	return resolved;
}

async function resolveRequestedAsset(resolvers: MountResolvers, parsed: ParsedStaticPath): Promise<ResolvedFile | null> {
	if (parsed.kind === "spa") {
		const realPublicRoot = await resolvers.resolvePublicRoot();
		return realPublicRoot ? resolveStaticFile(realPublicRoot, ["client", "index.html"]) : null;
	}
	if (parsed.kind !== "asset") return null;
	const { segments } = parsed;
	if (segments[0] === "client" && segments[1] === "vendor") return resolveVendorAsset(resolvers, segments);
	if (segments[0] === "client" && segments[1] === "src") return resolveClientSrcAsset(resolvers, segments);
	const realPublicRoot = await resolvers.resolvePublicRoot();
	return realPublicRoot ? resolveStaticFile(realPublicRoot, segments) : null;
}

function buildStaticHeaders(filePath: string, size: number): HeadersInit {
	return {
		"Content-Type": contentTypeFor(filePath),
		"Cache-Control": "no-cache",
		"X-Content-Type-Options": "nosniff",
		"Content-Length": String(size),
	};
}

function notFoundResponse(): Response {
	return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

export function createStaticHandler(
	publicDir: string = path.join(ROOT, "public"),
	options?: StaticHandlerOptions,
): Dispatch {
	const repoRootDir = path.resolve(options?.repoRoot ?? ROOT);
	const resolvers: MountResolvers = {
		resolvePublicRoot: createLazyRealpath(publicDir),
		resolveClientSrcRoot: createLazyRealpath(path.join(repoRootDir, "src", "client")),
		resolveVendorMount: createVendorMountResolver(repoRootDir),
	};
	return async function handleStatic(request: Request): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		const parsed = parseRequestPath(request.url);
		if (parsed.kind === "bad-request") return new Response(null, { status: 400 });
		if (parsed.kind === "not-found") return notFoundResponse();
		const resolved = await resolveRequestedAsset(resolvers, parsed);
		if (!resolved) return notFoundResponse();
		const headers = buildStaticHeaders(resolved.realTarget, resolved.size);
		if (request.method === "HEAD") return new Response(null, { status: 200, headers });
		const body = Readable.toWeb(createReadStream(resolved.realTarget)) as ReadableStream<Uint8Array>;
		return new Response(body, { status: 200, headers });
	};
}

export const serveStatic: Dispatch = createStaticHandler();
