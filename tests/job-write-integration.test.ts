import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test, type TestContext } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-write-integration-"));
process.env.LH_DATA_DIR = path.join(root, "data");
process.env.LH_AUTH_FILE = path.join(root, "auth.json");
const { ensureActiveLumberJackBundle, jobStore } = await import("../src/server/stores.ts");
const { subscribe } = await import("../src/core/events.ts");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const plugin = { pluginId: "example", toolName: "task", workerId: "worker", requestId: "request" };

test("native job creation and updates announce landed LumberJack lifecycle writes in order", (t: TestContext) => {
	const events: string[] = [];
	const unsubscribe = subscribe((event) => {
		if (event.type === "jobs-changed") events.push(event.chatId!);
	});
	t.after(unsubscribe);
	const job = jobStore.createJob({ kind: "research", chatId: "native", toolCallId: "native-call" });
	assert.equal(jobStore.getJob(job.id)?.status, "running");
	jobStore.updateJob(job.id, { status: "done", activity: "done" });
	assert.equal(jobStore.getJob(job.id)?.status, "done");
	assert.deepEqual(events, ["native", "native"], "only landed writes announce");
});

test("plugin and plugin-linked native jobs fail atomically on substrate write error, never announce or corrupt", (t: TestContext) => {
	const forest = ensureActiveLumberJackBundle().forest;
	for (const [kind, metadata] of [["plugin", undefined], ["plugin", plugin], ["research", plugin]] as const) {
		const job = jobStore.createJob({ kind, chatId: "strict", toolCallId: `call-${kind}-${!!metadata}`, ...(metadata ? { plugin: metadata } : {}) });
		const before = structuredClone(jobStore.getJob(job.id));
		t.mock.method(forest, "appendEntries", () => {
			throw Object.assign(new Error("held"), { code: "EPERM" });
		});
		let events = 0;
		const unsubscribe = subscribe((event) => {
			if (event.type === "jobs-changed") events++;
		});
		assert.throws(() => jobStore.updateJob(job.id, { status: "done" }), { code: "EPERM" });
		assert.throws(() => jobStore.createJob({ kind, chatId: "strict-new", toolCallId: "new", ...(metadata ? { plugin: metadata } : {}) }), { code: "EPERM" });
		unsubscribe();
		assert.deepEqual(jobStore.getJob(job.id), before);
		assert.equal(jobStore.listJobs("strict-new").length, 0);
		assert.equal(events, 0);
		t.mock.restoreAll();
	}
});
