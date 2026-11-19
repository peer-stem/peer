import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { RouteRecord } from "../src/api/types.ts";
import { getSpawnedPairCount, parityRunCheck, startParityPair, type ParityPair } from "./api-parity-servers.ts";
import type { ServerSide, StubServer } from "./api-parity-stubs.ts";
import type { ParityHarness } from "./api-parity-compare.ts";
import { installScratchProcessEnv, type IsolatedScratchEnv } from "./api-test-helpers.ts";

interface LoadedParityModules {
	routes: readonly RouteRecord[];
	compare: typeof import("./api-parity-compare.ts");
	routesA: typeof import("./api-parity-routes-a.ts");
	routesB: typeof import("./api-parity-routes-b.ts");
	streams: typeof import("./api-parity-streams.ts");
	gate: typeof import("./api-parity-gate.ts");
	casesA: typeof import("./api-parity-cases-a.ts");
	casesB: typeof import("./api-parity-cases-b.ts");
}

async function loadParityModules(): Promise<LoadedParityModules> {
	const [routesMod, compare, routesA, routesB, streams, gate, casesA, casesB] = await Promise.all([
		import("../src/api/routes.ts"),
		import("./api-parity-compare.ts"),
		import("./api-parity-routes-a.ts"),
		import("./api-parity-routes-b.ts"),
		import("./api-parity-streams.ts"),
		import("./api-parity-gate.ts"),
		import("./api-parity-cases-a.ts"),
		import("./api-parity-cases-b.ts"),
	]);
	return { routes: routesMod.routes, compare, routesA, routesB, streams, gate, casesA, casesB };
}

const runGate = parityRunCheck();

if (!runGate.ok) {
	test("api-parity", (t) => {
		t.skip(runGate.reason);
	});
} else {
	registerParitySuite();
}

function registerParitySuite(): void {
	let scratchEnv: IsolatedScratchEnv | null = null;
	let mods!: LoadedParityModules;
	let stub!: StubServer;
	let pair!: ParityPair;
	let harness!: ParityHarness;
	let teachIds!: Record<ServerSide, string>;

	before(async () => {
		scratchEnv = installScratchProcessEnv("api-parity-proc-");
		const [{ startStubServer }, loaded] = await Promise.all([
			import("./api-parity-stubs.ts"),
			loadParityModules(),
		]);
		mods = loaded;
		stub = await startStubServer();
		pair = await startParityPair();
		harness = mods.compare.createParityHarness(pair, stub, mods.routes);
	});

	after(async () => {
		await Promise.allSettled([pair?.stopAll(), stub?.close()]);
		scratchEnv?.restore();
	});

	test("routes-parity-and-coverage", async () => {
		await mods.routesA.runRoutesGroupA(harness);
		teachIds = await mods.routesB.runRoutesGroupB(harness);
		await mods.routesA.runAutoOptionsAndHeadSweep(harness);
		harness.coverage.assertComplete();
	});

	test("streams-parity", async () => {
		await mods.streams.runAllStreamParityTests(harness, teachIds);
	});

	registerSpecNamedCases(() => mods, () => harness, () => teachIds);
	registerGateShutdownAndAudit(() => mods, () => harness);
}

function registerGateShutdownAndAudit(
	getMods: () => LoadedParityModules,
	getHarness: () => ParityHarness,
): void {
	test("gate-modes-parity", async () => {
		await getMods().gate.runAllGateModesParity(getHarness(), getMods().routes);
	});

	test("sigterm-stop", async () => {
		await getMods().casesB.caseSigtermStop(getHarness());
	});

	test("recorded-differences-audit", (t) => {
		const mods = getMods();
		const harness = getHarness();
		assert.equal(mods.compare.RECORDED_DIFFERENCES.length, 8);
		for (const rule of mods.compare.RECORDED_DIFFERENCES) {
			assert.equal(rule.approved, true, `Expected recorded difference ${rule.id} to be approved`);
		}
		const badDiff = { ruleId: "unrecorded-synthetic-diff", request: "GET /api/graph", nextSummary: "x", apiSummary: "y" };
		assert.throws(() => mods.compare.auditRecordedDifferences([badDiff]), /Unrecorded parity difference/);
		const pendingRule = { id: "pending-synthetic-diff", summary: "pending", specRef: "SPEC", approved: false };
		const pendingObs = { ruleId: "pending-synthetic-diff", request: "GET /api/graph", nextSummary: "x", apiSummary: "y" };
		const pendingAudit = mods.compare.auditRecordedDifferences([pendingObs], [pendingRule]);
		assert.deepEqual(pendingAudit.unapprovedRuleIds, ["pending-synthetic-diff"]);
		const audit = mods.compare.auditRecordedDifferences(harness.observed);
		assert.deepEqual(audit.unapprovedRuleIds, []);
		assert.ok(getSpawnedPairCount() <= 5, `Expected <= 5 spawned server pairs, got ${getSpawnedPairCount()}`);
		t.diagnostic(`Spawned parity server pairs: ${getSpawnedPairCount()}`);
		if (process.env.PEER_API_PARITY_REPORT === "1") {
			console.log(`PARITY_OBSERVED_JSON=${JSON.stringify(harness.observed)}`);
		}
	});
}

function registerSpecNamedCases(
	getMods: () => LoadedParityModules,
	getHarness: () => ParityHarness,
	getTeachIds: () => Record<ServerSide, string>,
): void {
	test("head-on-get-route", async () => { await getMods().casesA.caseHeadOnGetRoute(getHarness()); });
	test("405-shape", async () => { await getMods().casesA.case405Shape(getHarness()); });
	test("auto-options", async () => { await getMods().casesA.caseAutoOptions(getHarness()); });
	test("static-before-dynamic", async () => { await getMods().casesA.caseStaticBeforeDynamic(getHarness()); });
	test("unknown-method", async () => { await getMods().casesA.caseUnknownMethod(getHarness()); });
	test("param-decoding", async () => { await getMods().casesA.caseParamDecoding(getHarness()); });
	test("request-url-and-host", async () => { await getMods().casesA.caseRequestUrlAndHost(getHarness()); });
	test("abort-on-disconnect", async () => { await getMods().casesA.caseAbortOnDisconnect(getHarness()); });
	test("cancel-on-disconnect", async () => { await getMods().casesA.caseCancelOnDisconnect(getHarness()); });
	test("default-headers", async () => { await getMods().casesA.caseDefaultHeaders(getHarness()); });
	test("gzip", async () => { await getMods().casesA.caseGzip(getHarness()); });
	test("trailing-slash", async () => { await getMods().casesB.caseTrailingSlash(getHarness()); });
	test("handler-throws", async () => { await getMods().casesB.caseHandlerThrows(getHarness()); });
	test("unknown-api-path", async () => { await getMods().casesB.caseUnknownApiPath(getHarness()); });
	test("bodiless-shape", async () => { await getMods().casesB.caseBodilessShape(getHarness()); });
	test("body-cap", async () => { await getMods().casesB.caseBodyCap(getHarness()); });
	test("shared-registries", async () => { await getMods().casesB.caseSharedRegistries(getHarness(), getTeachIds()); });
	test("outbound-fetch-uncached", async () => { await getMods().casesB.caseOutboundFetchUncached(getHarness()); });
	test("long-stream", async (t) => { await getMods().casesB.caseLongStream(t, getHarness()); });
	test("matcher-encoded-paths", async () => { await getMods().casesB.caseMatcherEncodedPaths(getHarness(), getMods().routes); });
}
