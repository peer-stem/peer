import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { ROOT } from "@/config.ts";
import type { Dispatch } from "./types.ts";

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
	if (segment === "" || segment === "." || segment === "..") return false;
	return !segment.includes("/") && !segment.includes("\\") && !segment.includes("\0");
}

function parseSegments(requestUrl: string): { status: 400 | 404 } | { segments: string[] } {
	const { pathname } = new URL(requestUrl);
	if (pathname.includes("\0")) return { status: 400 };
	const rawSegments = pathname.split("/").filter((segment) => segment.length > 0);
	if (rawSegments.length === 0) return { status: 404 };
	const segments: string[] = [];
	for (const raw of rawSegments) {
		const decoded = decodeSegment(raw);
		if (decoded === null) return { status: 400 };
		if (!isSafeSegment(decoded)) return { status: 404 };
		segments.push(decoded);
	}
	return { segments };
}

async function resolveStaticFile(
	rootDir: string,
	segments: string[],
): Promise<{ realTarget: string; size: number } | null> {
	try {
		const realRoot = await fs.realpath(rootDir);
		const realTarget = await fs.realpath(path.join(realRoot, ...segments));
		const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
		if (realTarget === realRoot || !realTarget.startsWith(rootPrefix)) return null;
		const stat = await fs.stat(realTarget);
		if (!stat.isFile()) return null;
		return { realTarget, size: stat.size };
	} catch {
		return null;
	}
}

function buildStaticHeaders(filePath: string, size: number): HeadersInit {
	return {
		"Content-Type": contentTypeFor(filePath),
		"Cache-Control": "public, max-age=0",
		"X-Content-Type-Options": "nosniff",
		"Content-Length": String(size),
	};
}

export function createStaticHandler(publicDir: string = path.join(ROOT, "public")): Dispatch {
	const rootDir = path.resolve(publicDir);
	return async function handleStatic(request: Request): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, OPTIONS" } });
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		const parsed = parseSegments(request.url);
		if ("status" in parsed) return new Response(null, { status: parsed.status });
		const resolved = await resolveStaticFile(rootDir, parsed.segments);
		if (!resolved) return new Response(null, { status: 404 });
		const headers = buildStaticHeaders(resolved.realTarget, resolved.size);
		if (request.method === "HEAD") return new Response(null, { status: 200, headers });
		const body = Readable.toWeb(createReadStream(resolved.realTarget)) as ReadableStream<Uint8Array>;
		return new Response(body, { status: 200, headers });
	};
}

export const serveStatic: Dispatch = createStaticHandler();
