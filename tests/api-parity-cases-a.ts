import assert from "node:assert/strict";
import { connectWireStream, openWireStream, sendRawSocket, sendWire } from "./api-parity-wire.ts";
import { compareResponseHeaders, runParityRequest, type ParityHarness } from "./api-parity-compare.ts";
import { GOLDEN_SIDE_THREAD, GOLDEN_TEACH_CHAT } from "./api-test-helpers.ts";
import { openEventsWithPulse, pulseEventsBusOnBoth } from "./api-parity-routes-b.ts";

export async function caseHeadOnGetRoute(h: ParityHarness): Promise<void> {
	for (const routePath of ["/api/graph", "/api/settings"]) {
		const getOut = await runParityRequest(h, {
			label: `head-on-get-route GET ${routePath}`,
			expectedStatus: 200,
			request: { method: "GET", path: routePath },
		});
		const headOut = await runParityRequest(h, {
			label: `head-on-get-route HEAD ${routePath}`,
			compareContentLength: true,
			expectedStatus: 200,
			request: { method: "HEAD", path: routePath },
		});
		assert.equal(headOut.nextRes.rawBody.length, 0);
		assert.equal(headOut.apiRes.rawBody.length, 0);
		assert.equal(headOut.apiRes.headers["content-type"], getOut.apiRes.headers["content-type"]);
	}
}

export async function case405Shape(h: ParityHarness): Promise<void> {
	const out = await runParityRequest(h, {
		label: "405-shape PUT /api/settings/prompts",
		expectedStatus: 405,
		request: { method: "PUT", path: "/api/settings/prompts", headers: { "Content-Type": "application/json" }, body: "{}" },
	});
	assert.equal(out.nextRes.rawBody.length, 0);
	assert.equal(out.apiRes.rawBody.length, 0);
	assert.equal(out.nextRes.headers.allow, undefined);
	assert.equal(out.apiRes.headers.allow, undefined);
}

export async function caseAutoOptions(h: ParityHarness): Promise<void> {
	const cases: Array<{ path: string; expectedAllow: string }> = [
		{ path: "/api/graph", expectedAllow: "GET, HEAD, OPTIONS" },
		{ path: `/api/chats/${GOLDEN_TEACH_CHAT}`, expectedAllow: "DELETE, GET, HEAD, OPTIONS, PUT" },
		{ path: "/api/custom-provider", expectedAllow: "DELETE, GET, HEAD, OPTIONS, PATCH, POST" },
	];
	for (const item of cases) {
		const out = await runParityRequest(h, {
			label: `auto-options OPTIONS ${item.path}`,
			expectedStatus: 204,
			request: { method: "OPTIONS", path: item.path },
		});
		assert.equal(out.nextRes.headers.allow, item.expectedAllow);
		assert.equal(out.apiRes.headers.allow, item.expectedAllow);
		assert.equal(out.nextRes.rawBody.length, 0);
		assert.equal(out.apiRes.rawBody.length, 0);
	}
}

export async function caseStaticBeforeDynamic(h: ParityHarness): Promise<void> {
	const out = await runParityRequest(h, {
		label: "static-before-dynamic PUT /api/settings/prompts",
		expectedStatus: 405,
		request: { method: "PUT", path: "/api/settings/prompts", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme: "dark" }) },
	});
	assert.equal(out.nextRes.rawBody.length, 0);
	assert.equal(out.apiRes.rawBody.length, 0);
}

export async function caseUnknownMethod(h: ParityHarness): Promise<void> {
	for (const method of ["FOO", "PURGE"]) {
		const [nextRes, apiRes] = await Promise.all([
			sendRawSocket(h.pair.next.port, `${method} /api/graph HTTP/1.1\r\nHost: 127.0.0.1:${h.pair.next.port}\r\nConnection: close\r\n\r\n`),
			sendRawSocket(h.pair.api.port, `${method} /api/graph HTTP/1.1\r\nHost: 127.0.0.1:${h.pair.api.port}\r\nConnection: close\r\n\r\n`),
		]);
		assert.equal(nextRes.status, 400, `${method} Next expected 400`);
		assert.equal(apiRes.status, 400, `${method} API expected 400`);
	}
	const [nextTrace, apiTrace] = await Promise.all([
		sendRawSocket(h.pair.next.port, `TRACE /api/graph HTTP/1.1\r\nHost: 127.0.0.1:${h.pair.next.port}\r\nConnection: close\r\n\r\n`),
		sendRawSocket(h.pair.api.port, `TRACE /api/graph HTTP/1.1\r\nHost: 127.0.0.1:${h.pair.api.port}\r\nConnection: close\r\n\r\n`),
	]);
	assert.equal(nextTrace.status, 500);
	assert.equal(apiTrace.status, 500);
	assert.equal(apiTrace.text, nextTrace.text);
	compareResponseHeaders(h, nextTrace.headers, apiTrace.headers, { requestLabel: "TRACE /api/graph", traceMethod500: true });
}

export async function caseParamDecoding(h: ParityHarness): Promise<void> {
	const getCases: ReadonlyArray<{ path: string; status: number; body?: string }> = [
		{ path: "/api/plugins/document%2Done/assets/assets/nested/info.txt", status: 200, body: "nested plugin asset\n" },
		{ path: "/api/plugins/document-one/assets/assets/nested/info%2Etxt", status: 200, body: "nested plugin asset\n" },
		{ path: "/api/plugins/document-one/assets/assets%2Fnested/info.txt", status: 400 },
		{ path: "/api/chats/chat%2Dmissing", status: 404 },
		{ path: "/api/chats/chat%2Fslash", status: 404 },
		{ path: "/api/chats/chat%25percent", status: 404 },
		{ path: "/api/chats/caf%C3%A9", status: 404 },
	];
	for (const item of getCases) {
		const out = await runParityRequest(h, {
			label: `param-decoding GET ${item.path}`,
			expectedStatus: item.status,
			request: { method: "GET", path: item.path },
		});
		if (item.body !== undefined) {
			assert.equal(out.apiRes.text, item.body);
		}
	}
	const putOut = await runParityRequest(h, {
		label: "param-decoding PUT catch-all encoded segment",
		expectedStatus: 400,
		isWrite: true,
		request: {
			method: "PUT",
			path: "/api/settings/prompts/teacher/99%2Dmissing%2Esegment.md",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "x" }),
		},
	});
	const putErr = (JSON.parse(putOut.apiRes.text) as { error?: string }).error;
	assert.equal(putErr, '"teacher/99-missing.segment.md" is not a current source segment');
}

export async function caseRequestUrlAndHost(h: ParityHarness): Promise<void> {
	await runOriginHostCheck(h, "GET", "/api/claude-code", { "x-learnharness-claude-code": "1" }, 200, 403);
	await runOriginHostCheck(h, "GET", "/api/external-cli?id=codex-cli", { "x-learnharness-external-cli": "1" }, 200, 403);
	await runOriginHostCheck(
		h,
		"POST",
		"/api/chats",
		{ "Content-Type": "application/json" },
		200,
		403,
		JSON.stringify({ title: "Host Origin Parity" }),
	);
}

async function runOriginHostCheck(
	h: ParityHarness,
	method: string,
	reqPath: string,
	extraHeaders: Record<string, string>,
	passStatus: number,
	failStatus: number,
	body?: string,
): Promise<void> {
	await runParityRequest(h, {
		label: `request-url-and-host pass ${method} ${reqPath}`,
		expectedStatus: passStatus,
		request: (_side, port) => ({
			method,
			path: reqPath,
			headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, ...extraHeaders },
			body,
		}),
	});
	await runParityRequest(h, {
		label: `request-url-and-host mismatch ${method} ${reqPath}`,
		expectedStatus: failStatus,
		request: (_side, port) => ({
			method,
			path: reqPath,
			headers: { Host: `localhost:${port}`, Origin: `http://127.0.0.1:${port}`, ...extraHeaders },
			body,
		}),
	});
}

export async function caseAbortOnDisconnect(h: ParityHarness): Promise<void> {
	const payload = JSON.stringify({ text: "Abort mid stream check." });
	try {
		await abortTtsOnSide(h, "next", h.pair.next.port, payload);
		await abortTtsOnSide(h, "api", h.pair.api.port, payload);
	} finally {
		h.stub.setTtsMode("normal");
	}
}

async function abortTtsOnSide(h: ParityHarness, side: "next" | "api", port: number, payload: string): Promise<void> {
	const tracker = h.stub.armTtsAbort();
	h.stub.setSide(side);
	const stream = await openWireStream(port, {
		method: "POST",
		path: "/api/tts/speak",
		headers: { "Content-Type": "application/json" },
		body: payload,
	});
	assert.equal(stream.status, 200);
	stream.abort();
	await tracker.waitAborted();
}

export async function caseCancelOnDisconnect(h: ParityHarness): Promise<void> {
	const sideWatchUrl = `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats/${GOLDEN_SIDE_THREAD}`;
	for (let i = 0; i < 50; i++) {
		const nEv = connectWireStream(h.pair.next.port, { method: "GET", path: "/api/events" });
		const aEv = connectWireStream(h.pair.api.port, { method: "GET", path: "/api/events" });
		await aEv.waitHeaders(2_000);
		nEv.abort();
		aEv.abort();
		const [nSc, aSc] = await Promise.all([
			openWireStream(h.pair.next.port, { method: "GET", path: sideWatchUrl }),
			openWireStream(h.pair.api.port, { method: "GET", path: sideWatchUrl }),
		]);
		nSc.abort();
		aSc.abort();
	}
	assert.equal(h.pair.api.logs().includes("MaxListenersExceededWarning"), false, "API leaked event listeners");
	assert.equal(h.pair.next.logs().includes("MaxListenersExceededWarning"), false, "Next leaked event listeners");
	const { nextEv, apiEv } = await openEventsWithPulse(h.pair.next.port, h.pair.api.port);
	try {
		await pulseEventsBusOnBoth(h);
		await Promise.all([nextEv.waitForText("sources-changed", 5_000), apiEv.waitForText("sources-changed", 5_000)]);
	} finally {
		nextEv.abort();
		apiEv.abort();
	}
	await runParityRequest(h, {
		label: "cancel-on-disconnect post-50x health check",
		expectedStatus: 200,
		request: { method: "GET", path: "/api/settings" },
	});
}

export async function caseDefaultHeaders(h: ParityHarness): Promise<void> {
	for (const reqPath of ["/api/settings", `/api/chats/${GOLDEN_TEACH_CHAT}/markdown`, "/api/plugins/document-one/assets/styles.css"]) {
		await runParityRequest(h, {
			label: `default-headers GET ${reqPath}`,
			expectedStatus: 200,
			request: { method: "GET", path: reqPath },
		});
	}
	assert.throws(() => {
		compareResponseHeaders(
			h,
			{ "content-type": "application/json", "x-unexpected-header": "1" },
			{ "content-type": "application/json" },
			{ requestLabel: "synthetic unapproved header guard" },
		);
	});
}

export async function caseGzip(h: ParityHarness): Promise<void> {
	for (const reqPath of ["/api/settings", "/api/plugins/document-one/assets/styles.css"]) {
		const [nextRes, apiRes] = await Promise.all([
			sendWire(h.pair.next.port, { method: "GET", path: reqPath, headers: { "Accept-Encoding": "gzip" } }),
			sendWire(h.pair.api.port, { method: "GET", path: reqPath, headers: { "Accept-Encoding": "gzip" } }),
		]);
		assert.equal(nextRes.headers["content-encoding"], undefined, `Next unexpected content-encoding on ${reqPath}`);
		assert.equal(apiRes.headers["content-encoding"], undefined, `API unexpected content-encoding on ${reqPath}`);
		compareResponseHeaders(h, nextRes.headers, apiRes.headers, { requestLabel: `gzip GET ${reqPath}` });
	}
	const { nextEv: nEv, apiEv: aEv } = await openEventsWithPulse(
		h.pair.next.port,
		h.pair.api.port,
		{ "Accept-Encoding": "gzip" },
	);
	try {
		assert.equal(nEv.headers["content-encoding"], undefined);
		assert.equal(aEv.headers["content-encoding"], undefined);
	} finally {
		nEv.abort();
		aEv.abort();
	}
}
