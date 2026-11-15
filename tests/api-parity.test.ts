import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { parityRunCheck, startParityPair, type ParityPair } from "./api-parity-servers.ts";
import { startStubServer, type ServerSide, type StubServer } from "./api-parity-stubs.ts";
import { APPROVED_RECORDED_DIFFERENCES, createParityHarness, type ParityHarness } from "./api-parity-compare.ts";
import { runAutoOptionsAndHeadSweep, runRoutesGroupA } from "./api-parity-routes-a.ts";
import { runRoutesGroupB } from "./api-parity-routes-b.ts";
import { runAllStreamParityTests } from "./api-parity-streams.ts";
import { runAllGateModesParity } from "./api-parity-gate.ts";
import {
	case405Shape,
	caseAbortOnDisconnect,
	caseAutoOptions,
	caseCancelOnDisconnect,
	caseDefaultHeaders,
	caseGzip,
	caseHeadOnGetRoute,
	caseParamDecoding,
	caseRequestUrlAndHost,
	caseStaticBeforeDynamic,
	caseUnknownMethod,
} from "./api-parity-cases-a.ts";
import {
	caseBodilessShape,
	caseBodyCap,
	caseHandlerThrows,
	caseLongStream,
	caseMatcherEncodedPaths,
	caseOutboundFetchUncached,
	caseSharedRegistries,
	caseSigtermStop,
	caseTrailingSlash,
	caseUnknownApiPath,
} from "./api-parity-cases-b.ts";

const runGate = parityRunCheck();

if (!runGate.ok) {
	test("api-parity", { skip: runGate.reason }, () => {});
} else {
	registerParitySuite();
}

function registerParitySuite(): void {
	let stub!: StubServer;
	let pair!: ParityPair;
	let harness!: ParityHarness;
	let teachIds!: Record<ServerSide, string>;

	before(async () => {
		stub = await startStubServer();
		pair = await startParityPair();
		harness = createParityHarness(pair, stub);
	});

	after(async () => {
		await Promise.allSettled([pair?.stopAll(), stub?.close()]);
	});

	test("routes-parity-and-coverage", async () => {
		await runRoutesGroupA(harness);
		teachIds = await runRoutesGroupB(harness);
		await runAutoOptionsAndHeadSweep(harness);
		harness.coverage.assertComplete();
	});

	test("streams-parity", async () => {
		await runAllStreamParityTests(harness, teachIds);
	});

	registerSpecNamedCases(() => harness, () => teachIds);

	test("gate-modes-parity", async () => {
		await runAllGateModesParity(harness);
	});

	test("recorded-differences-audit", () => {
		const allowedIds = new Set(APPROVED_RECORDED_DIFFERENCES.map((r) => r.id));
		for (const obs of harness.observed) {
			assert.ok(allowedIds.has(obs.ruleId), `Unapproved recorded difference ruleId: ${obs.ruleId}`);
		}
		if (process.env.PEER_API_PARITY_REPORT === "1") {
			console.log(`PARITY_OBSERVED_JSON=${JSON.stringify(harness.observed)}`);
		}
	});
}

function registerSpecNamedCases(
	getHarness: () => ParityHarness,
	getTeachIds: () => Record<ServerSide, string>,
): void {
	test("head-on-get-route", async () => { await caseHeadOnGetRoute(getHarness()); });
	test("405-shape", async () => { await case405Shape(getHarness()); });
	test("auto-options", async () => { await caseAutoOptions(getHarness()); });
	test("static-before-dynamic", async () => { await caseStaticBeforeDynamic(getHarness()); });
	test("unknown-method", async () => { await caseUnknownMethod(getHarness()); });
	test("param-decoding", async () => { await caseParamDecoding(getHarness()); });
	test("request-url-and-host", async () => { await caseRequestUrlAndHost(getHarness()); });
	test("abort-on-disconnect", async () => { await caseAbortOnDisconnect(getHarness()); });
	test("cancel-on-disconnect", async () => { await caseCancelOnDisconnect(getHarness()); });
	test("default-headers", async () => { await caseDefaultHeaders(getHarness()); });
	test("gzip", async () => { await caseGzip(getHarness()); });
	test("trailing-slash", async () => { await caseTrailingSlash(getHarness()); });
	test("handler-throws", async () => { await caseHandlerThrows(getHarness()); });
	test("unknown-api-path", async () => { await caseUnknownApiPath(getHarness()); });
	test("bodiless-shape", async () => { await caseBodilessShape(getHarness()); });
	test("body-cap", async () => { await caseBodyCap(getHarness()); });
	test("shared-registries", async () => { await caseSharedRegistries(getHarness(), getTeachIds()); });
	test("outbound-fetch-uncached", async () => { await caseOutboundFetchUncached(getHarness()); });
	test("sigterm-stop", async () => { await caseSigtermStop(getHarness()); });
	test("long-stream", async (t) => { await caseLongStream(t, getHarness()); });
	test("matcher-encoded-paths", async () => { await caseMatcherEncodedPaths(getHarness()); });
}
