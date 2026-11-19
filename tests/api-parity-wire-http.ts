import http from "node:http";
import net from "node:net";

export interface WireRequest {
	method: string;
	path: string;
	headers?: Record<string, string>;
	omitHost?: boolean;
	body?: Buffer | Uint8Array | string;
	chunked?: boolean;
	agent?: http.Agent | false;
	timeoutMs?: number;
}

export interface WireResponse {
	status: number;
	headers: Record<string, string>;
	rawBody: Buffer;
	text: string;
	prematureClose: boolean;
}

export function normalizeRawHeaders(rawHeaders: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
		const key = rawHeaders[i]?.toLowerCase();
		const val = rawHeaders[i + 1];
		if (!key || val === undefined) continue;
		out[key] = out[key] !== undefined ? `${out[key]}, ${val}` : val;
	}
	return out;
}

export function toBodyBuffer(body: Buffer | Uint8Array | string | undefined): Buffer | undefined {
	if (body === undefined) return undefined;
	if (Buffer.isBuffer(body)) return body;
	if (typeof body === "string") return Buffer.from(body, "utf8");
	return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

export function buildWireHeaders(port: number, reqSpec: WireRequest, payload: Buffer | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!reqSpec.omitHost) headers.Host = `127.0.0.1:${port}`;
	if (!reqSpec.agent) headers.Connection = "close";
	if (reqSpec.headers) {
		for (const [key, val] of Object.entries(reqSpec.headers)) {
			if (key.toLowerCase() === "host") delete headers.Host;
			headers[key] = val;
		}
	}
	const hasContentLength = Object.keys(headers).some((k) => k.toLowerCase() === "content-length");
	const hasTransferEncoding = Object.keys(headers).some((k) => k.toLowerCase() === "transfer-encoding");
	if (reqSpec.chunked && !hasTransferEncoding) {
		headers["Transfer-Encoding"] = "chunked";
	} else if (payload !== undefined && !hasContentLength && !hasTransferEncoding) {
		headers["Content-Length"] = String(payload.byteLength);
	}
	return headers;
}

export function writePayloadChunks(req: http.ClientRequest, payload: Buffer | undefined, chunked: boolean): void {
	if (payload === undefined) {
		req.end();
		return;
	}
	if (!chunked || payload.byteLength <= 65_536) {
		req.end(payload);
		return;
	}
	let offset = 0;
	const step = 262_144;
	const pump = () => {
		while (offset < payload.byteLength && !req.destroyed) {
			const end = Math.min(offset + step, payload.byteLength);
			const slice = payload.subarray(offset, end);
			offset = end;
			if (offset >= payload.byteLength) { req.end(slice); return; }
			if (!req.write(slice)) { req.once("drain", pump); return; }
		}
	};
	pump();
}

function collectWireResponse(res: http.IncomingMessage, resolve: (value: WireResponse) => void): void {
	const chunks: Buffer[] = [];
	let finished = false;
	const done = (prematureClose: boolean) => {
		if (finished) return;
		finished = true;
		const rawBody = Buffer.concat(chunks);
		resolve({
			status: res.statusCode ?? 0,
			headers: normalizeRawHeaders(res.rawHeaders),
			rawBody,
			text: rawBody.toString("utf8"),
			prematureClose,
		});
	};
	res.on("data", (chunk: Buffer | string) => {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	});
	res.on("end", () => done(false));
	res.on("aborted", () => done(true));
	res.on("error", () => done(true));
	res.on("close", () => done(!res.complete));
}

export function sendWire(port: number, reqSpec: WireRequest): Promise<WireResponse> {
	const payload = toBodyBuffer(reqSpec.body);
	const headers = buildWireHeaders(port, reqSpec, payload);
	const opts = { hostname: "127.0.0.1", port, method: reqSpec.method, path: reqSpec.path, headers, agent: reqSpec.agent ?? false };
	return new Promise<WireResponse>((resolve, reject) => {
		const req = http.request(opts, (res) => collectWireResponse(res, resolve));
		req.on("error", reject);
		req.setTimeout(reqSpec.timeoutMs ?? 30_000, () => {
			req.destroy(new Error(`Wire request timed out: ${reqSpec.method} ${reqSpec.path}`));
		});
		writePayloadChunks(req, payload, Boolean(reqSpec.chunked));
	});
}

function decodeChunkedBody(buf: Buffer): Buffer {
	const out: Buffer[] = [];
	let pos = 0;
	while (pos < buf.byteLength) {
		const lineEnd = buf.indexOf("\r\n", pos);
		if (lineEnd < 0) break;
		const sizeHex = buf.subarray(pos, lineEnd).toString("ascii").split(";")[0]?.trim() ?? "";
		const size = Number.parseInt(sizeHex, 16);
		if (!Number.isFinite(size) || size === 0) break;
		const start = lineEnd + 2;
		if (start + size > buf.byteLength) {
			out.push(buf.subarray(start));
			break;
		}
		out.push(buf.subarray(start, start + size));
		pos = start + size + 2;
	}
	return Buffer.concat(out);
}

function parseRawHttpResponse(buf: Buffer): WireResponse {
	const sep = buf.indexOf("\r\n\r\n");
	const headText = sep >= 0 ? buf.subarray(0, sep).toString("latin1") : buf.toString("latin1");
	const bodySlice = sep >= 0 ? buf.subarray(sep + 4) : Buffer.alloc(0);
	const lines = headText.split("\r\n");
	const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(lines[0] ?? "");
	const status = statusMatch?.[1] ? Number(statusMatch[1]) : 0;
	const rawPairs: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const colon = line.indexOf(":");
		if (colon > 0) rawPairs.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const headers = normalizeRawHeaders(rawPairs);
	const rawBody = headers["transfer-encoding"]?.includes("chunked") ? decodeChunkedBody(bodySlice) : bodySlice;
	return { status, headers, rawBody, text: rawBody.toString("utf8"), prematureClose: false };
}

export function sendRawSocket(port: number, rawRequest: Buffer | string, timeoutMs = 10_000): Promise<WireResponse> {
	const outBytes = typeof rawRequest === "string" ? Buffer.from(rawRequest, "utf8") : rawRequest;
	return new Promise<WireResponse>((resolve, reject) => {
		const chunks: Buffer[] = [];
		const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
			socket.write(outBytes);
		});
		socket.setTimeout(timeoutMs, () => socket.destroy(new Error("Raw socket timeout")));
		socket.on("data", (chunk: Buffer | string) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		});
		socket.on("error", reject);
		socket.on("close", () => resolve(parseRawHttpResponse(Buffer.concat(chunks))));
	});
}
