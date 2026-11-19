import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { readApiConfig } from "../src/api/config.ts";
import { createLogger } from "../src/api/log.ts";
import {
	formatForcedExitLine,
	isMainModule,
	reportGateRefusal,
	reportRouteError,
	reportServerError,
	reportServerWarn,
	safeRequestPath,
} from "../src/api/main.ts";
import { RECORDED_DIFFERENCES, auditRecordedDifferences } from "./api-parity-compare.ts";
import { WORKTREE_ROOT, createScratchDir } from "./api-test-helpers.ts";

const MAIN_ENTRY = path.join(WORKTREE_ROOT, "src", "api", "main.ts");
const SCRATCH_DIR = createScratchDir("api-config-");

after(() => {
	fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

test("readApiConfig rejects missing and invalid PORT values", () => {
	const invalidPorts: Array<string | undefined> = [undefined, "", "   ", "0", "-1", "65536", "abc", "3000.5"];
	for (const port of invalidPorts) {
		assert.throws(
			() => readApiConfig({ PORT: port }),
			{ message: "PORT is required and must be an integer between 1 and 65535" },
		);
	}
});

test("readApiConfig accepts loopback HOSTNAME values and normalizes case and [::1] (D3)", () => {
	assert.deepEqual(readApiConfig({ PORT: "1" }), { port: 1, hostname: "127.0.0.1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "65535", HOSTNAME: "" }), { port: 65535, hostname: "127.0.0.1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "65535", HOSTNAME: "   " }), { port: 65535, hostname: "127.0.0.1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "  localhost  " }), { port: 42100, hostname: "localhost", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "LOCALHOST" }), { port: 42100, hostname: "localhost", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "::1" }), { port: 42100, hostname: "::1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "  [::1]  " }), { port: 42100, hostname: "::1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "127.0.0.1" }), { port: 42100, hostname: "127.0.0.1", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "127.0.0.2" }), { port: 42100, hostname: "127.0.0.2", logLevel: "info" });
	assert.deepEqual(readApiConfig({ PORT: "42100", HOSTNAME: "127.255.255.254" }), { port: 42100, hostname: "127.255.255.254", logLevel: "info" });
});

test("readApiConfig refuses non-loopback and malformed HOSTNAME values (D3)", () => {
	const rejected = [
		"0.0.0.0",
		"::",
		"[::]",
		"192.168.1.5",
		"10.0.0.1",
		"128.0.0.1",
		"example.com",
		"localhost.localdomain",
		"127.01.0.1",
		"127.256.0.1",
		"127.0.0",
		"127.0.0.1.1",
		"::ffff:127.0.0.1",
		"[::ffff:127.0.0.1]",
	];
	for (const host of rejected) {
		assert.throws(
			() => readApiConfig({ PORT: "42100", HOSTNAME: ` ${host} ` }),
			{ message: `HOSTNAME must be a loopback address (127.0.0.0/8, ::1, or localhost); received "${host}"` },
		);
	}
});

test("readApiConfig parses case-insensitive LH_LOG_LEVEL and rejects invalid levels", () => {
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "" }).logLevel, "info");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "   " }).logLevel, "info");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "DEBUG" }).logLevel, "debug");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "Info" }).logLevel, "info");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "  WARN " }).logLevel, "warn");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "ErRoR" }).logLevel, "error");
	assert.equal(readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "Silent" }).logLevel, "silent");
	assert.throws(() => readApiConfig({ PORT: "4100", LH_LOG_LEVEL: "verbose" }), /LH_LOG_LEVEL/);
});

test("readApiConfig never reads or mutates gate or runtime environment variables", () => {
	const rawEnv: Record<string, string | undefined> = {
		PORT: "45123",
		LH_DESKTOP_SERVER: "1",
		LH_DESKTOP_API_SECRET: "secret-token",
		LH_ALLOWED_HOSTS: "peer.local",
		NODE_ENV: "production",
	};
	const snapshot = { ...rawEnv };
	const readKeys: string[] = [];
	const mutatedKeys: string[] = [];
	const proxied = new Proxy(rawEnv, {
		get(target, prop) {
			if (typeof prop === "string") readKeys.push(prop);
			return Reflect.get(target, prop);
		},
		set(target, prop, value) {
			if (typeof prop === "string") mutatedKeys.push(prop);
			return Reflect.set(target, prop, value);
		},
		deleteProperty(target, prop) {
			if (typeof prop === "string") mutatedKeys.push(prop);
			return Reflect.deleteProperty(target, prop);
		},
	});
	const config = readApiConfig(proxied);
	assert.equal(config.port, 45123);
	assert.deepEqual(new Set(readKeys), new Set(["PORT", "HOSTNAME", "LH_LOG_LEVEL"]));
	assert.deepEqual(mutatedKeys, []);
	assert.deepEqual(rawEnv, snapshot);
});

test("isMainModule resolves symlinks and rejects non-matching or missing argv1", () => {
	const linkPath = path.join(SCRATCH_DIR, "main-link.ts");
	fs.symlinkSync(MAIN_ENTRY, linkPath);
	const mainUrl = pathToFileURL(MAIN_ENTRY).href;
	assert.equal(isMainModule(mainUrl, linkPath), true);
	assert.equal(isMainModule(mainUrl, path.join(SCRATCH_DIR, "other.ts")), false);
	assert.equal(isMainModule(mainUrl, undefined), false);
});

test("typed main.ts reporters format structured events and strip URL query strings", async () => {
	const sink = new PassThrough();
	let output = "";
	sink.setEncoding("utf8");
	sink.on("data", (chunk: string) => { output += chunk; });
	const logger = createLogger({ level: "debug", stream: sink });
	reportRouteError(logger)(
		new Error("route-boom"),
		new Request("http://127.0.0.1:4100/api/keys?secret=top-secret-query", { method: "POST" }),
	);
	reportServerError(logger, "[api] Transport error")(new Error("socket-boom"));
	reportServerWarn(logger)("Body capped warning");
	reportGateRefusal(logger)("DELETE", "/api/chats/c1");
	assert.equal(safeRequestPath("http://127.0.0.1/api/search?q=private"), "/api/search");
	assert.equal(safeRequestPath(":::bad-url?token=leak"), "/:::bad-url");
	assert.equal(safeRequestPath("http://[invalid?token=leak"), "http://[invalid");
	await logger.flush();
	assert.equal(output.includes("top-secret-query"), false);
	assert.equal(output.includes("leak"), false);
	const records = output.trim().split("\n").map((line) => JSON.parse(line) as {
		message?: string;
		fields?: Record<string, unknown>;
	});
	assert.equal(records.length, 4);
	assert.equal(records[0]?.message, "[api] Unhandled route error");
	assert.equal(records[0]?.fields?.path, "/api/keys");
	assert.equal(records[0]?.fields?.url, undefined);
	assert.equal(records[1]?.message, "[api] Transport error");
	assert.equal(records[2]?.message, "Body capped warning");
	assert.equal(records[3]?.message, "[api] Gate refused request");
	assert.equal(records[3]?.fields?.path, "/api/chats/c1");
	const forced = JSON.parse(formatForcedExitLine()) as Record<string, unknown>;
	assert.equal(typeof forced.timestamp, "string");
	assert.equal(forced.level, "warn");
	assert.match(String(forced.message), /\[api\] Forced process exit after 2500ms shutdown deadline\./);
	assert.equal("ts" in forced, false);
	assert.equal("msg" in forced, false);
});

test("RECORDED_DIFFERENCES marks all 8 rules approved and auditRecordedDifferences flags custom unapproved rules (D4)", () => {
	assert.equal(RECORDED_DIFFERENCES.length, 8);
	for (const rule of RECORDED_DIFFERENCES) {
		assert.equal(rule.approved, true, `Expected ${rule.id} to have approved: true`);
	}
	const observedAll = RECORDED_DIFFERENCES.map((r) => ({
		ruleId: r.id,
		request: "GET /api/graph",
		nextSummary: "next",
		apiSummary: "api",
	}));
	assert.deepEqual(auditRecordedDifferences(observedAll).unapprovedRuleIds, []);
	const customRules = [
		...RECORDED_DIFFERENCES,
		{ id: "custom-unapproved", summary: "pending", specRef: "SPEC", approved: false },
	];
	const customObs = [
		...observedAll,
		{ ruleId: "custom-unapproved", request: "GET /api/x", nextSummary: "a", apiSummary: "b" },
	];
	assert.deepEqual(auditRecordedDifferences(customObs, customRules).unapprovedRuleIds, ["custom-unapproved"]);
	assert.throws(
		() => auditRecordedDifferences([{ ruleId: "unknown-rule", request: "GET /api/x", nextSummary: "a", apiSummary: "b" }]),
		/Unrecorded parity difference/,
	);
});
