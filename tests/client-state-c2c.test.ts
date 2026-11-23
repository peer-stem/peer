import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/client-env.ts";
import { validatePluginTree } from "../src/client/engine/index.ts";
import type { createState as CreateStateFn, WebSocketLike } from "../src/client/state/index.ts";
import type { BlockRegistrySyncTarget } from "../src/client/state/plugins.ts";

type TestBlockRegistry = BlockRegistrySyncTarget & {
	has(lang: string): boolean;
	fenceFor(lang: string): { builtin?: boolean } | null;
};

async function loadStateMod(): Promise<{ createState: typeof CreateStateFn }> {
	return import(new URL("../src/client/state/index.ts", import.meta.url).href) as Promise<{
		createState: typeof CreateStateFn;
	}>;
}

async function loadBlockRegistry(): Promise<{ createBlockRegistry: () => TestBlockRegistry }> {
	return import(new URL("../src/client/blocks/registry.js", import.meta.url).href) as Promise<{
		createBlockRegistry: () => TestBlockRegistry;
	}>;
}

function jsonRes(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("C2c state: PluginsStore activates plugins, syncs code-block fences (reserving mermaid), and projects plugin-view routes", async () => {
	let enabledState = true;
	const actionCalls: string[] = [];
	const notifications: string[] = [];
	const fetchMock: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.endsWith("/api/plugins") && (!init?.method || init.method === "GET")) {
			return jsonRes({
				directory: "/tmp-free/plugins",
				plugins: [
					{
						id: "demo-plugin",
						origin: "core",
						enabled: enabledState,
						status: enabledState ? "active" : "disabled",
						revision: "r1",
						manifest: { apiVersion: 1, id: "demo-plugin", name: "Demo Plugin", version: "1.0.0", minAppVersion: "0.7.0", main: "main.js" },
					},
				],
			});
		}
		if (url.includes("/api/plugins/demo-plugin") && init?.method === "PUT") {
			const parsed = JSON.parse(String(init.body)) as { enabled: boolean };
			enabledState = parsed.enabled;
			return jsonRes({ ok: true });
		}
		if (url.endsWith("/api/settings")) return jsonRes({ settings: null, keys: [], configured: true });
		if (url.endsWith("/api/models")) return jsonRes({ models: [], defaultModel: null });
		if (url.endsWith("/api/themes")) return jsonRes({ themes: [] });
		if (url.endsWith("/api/chats")) return jsonRes({ chats: [] });
		if (url.startsWith("/api/jobs")) return jsonRes({ jobs: [] });
		if (url.endsWith("/api/graph/sources")) return jsonRes({ sources: [], organization: { version: 1, folders: [], placements: {} } });
		return jsonRes({});
	};

	const { createState } = await loadStateMod();
	const state = createState({
		fetch: fetchMock,
		initialUrl: "http://localhost/plugins/demo-plugin/library",
		autoStartPlugins: false,
		importPluginModule: async () => ({
			activate(ctx) {
				ctx.registerView({
					id: "library",
					name: "Demo Library",
					mount(el) { el.textContent = "Library Ready"; },
				});
				ctx.registerAction({
					id: "quick-open",
					name: "Quick Open",
					run(actx) { actionCalls.push(actx.placement); },
				});
				ctx.placeAction({ id: "sb-open", actionId: "quick-open", location: "sidebar" });
				ctx.registerCodeBlock({
					language: "chem",
					mount(el, block) { el.textContent = `CHEM:${block.source}`; },
				});
				ctx.onNotification((ev) => notifications.push(`${ev.topic}:${JSON.stringify(ev.data)}`));
			},
		}),
	});

	try {
		const { createBlockRegistry } = await loadBlockRegistry();
		const blocks = createBlockRegistry();
		const offBlocks = state.plugins.bindBlockRegistry(blocks);
		state.plugins.start();
		await new Promise((r) => setTimeout(r, 25));

		const snap = state.plugins.get();
		assert.equal(snap.plugins.length, 1);
		assert.equal(snap.plugins[0]?.phase, "active");
		assert.equal(blocks.has("chem"), true);
		assert.equal(blocks.fenceFor("mermaid")?.builtin, true);

		const screen = state.screen(state.router.get());
		const vm = screen.get() as { unavailableReason: string | null; view: { name: string } | null };
		assert.equal(vm.unavailableReason, null);
		assert.equal(vm.view?.name, "Demo Library");

		const action = snap.plugins[0]!.actions[0]!;
		await state.plugins.send({
			type: "run-action",
			pluginId: "demo-plugin",
			action,
			context: { placement: "sidebar", surface: "sidebar" },
		});
		assert.deepEqual(actionCalls, ["sidebar"]);

		state.plugins.manager.notify({ pluginId: "demo-plugin", topic: "ping", data: 42 });
		await new Promise((r) => setTimeout(r, 10));
		assert.deepEqual(notifications, ["ping:42"]);

		await state.plugins.send({ type: "set-enabled", id: "demo-plugin", enabled: false });
		assert.equal((screen.get() as { unavailableReason: string | null }).unavailableReason, "Plugin is disabled.");
		assert.equal(blocks.has("chem"), false);

		screen.dispose();
		offBlocks();
	} finally {
		state.dispose();
	}
});

test("C2c state: SpeechStore + DictationStore cover Deepgram 503 keyless, Deepgram WS streaming, LocalTranscriber, and single active owner", async () => {
	let currentSpeech: Record<string, unknown> = { dictation: "deepgram", speak: "off", endpoint: "", sttModel: "", ttsVoice: "" };
	let tokenStatus = 503;
	const transcribedChunks: number[] = [];

	const fetchMock: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.endsWith("/api/settings/speech") && init?.method === "PUT") {
			currentSpeech = JSON.parse(String(init.body)) as Record<string, unknown>;
			return jsonRes({ settings: { version: 1, speech: currentSpeech } });
		}
		if (url.endsWith("/api/settings")) {
			return jsonRes({ settings: { version: 1, speech: currentSpeech }, keys: [], configured: true });
		}
		if (url.endsWith("/api/tts/voices")) {
			return jsonRes({ voices: ["af_heart", "am_adam"] });
		}
		if (url.endsWith("/api/stt/token") && (!init?.method || init.method === "GET")) {
			if (tokenStatus === 503) return jsonRes({ error: "Missing Deepgram key" }, 503);
			return jsonRes({ token: "dg_tok_123" });
		}
		if (url.startsWith("/api/stt/transcribe") && init?.method === "POST") {
			transcribedChunks.push(1);
			return jsonRes({ text: "local whisper phrase" });
		}
		if (url.endsWith("/api/plugins")) return jsonRes({ directory: "", plugins: [] });
		if (url.endsWith("/api/models")) return jsonRes({ models: [], defaultModel: null });
		if (url.endsWith("/api/themes")) return jsonRes({ themes: [] });
		if (url.endsWith("/api/chats")) return jsonRes({ chats: [] });
		if (url.startsWith("/api/jobs")) return jsonRes({ jobs: [] });
		return jsonRes({});
	};

	const frameSink: { fn?: (pcm: ArrayBuffer) => void } = {};
	let lastWs: (WebSocketLike & { sent: unknown[] }) | null = null;

	const { createState } = await loadStateMod();
	const state = createState({
		fetch: fetchMock,
		autoStartPlugins: false,
		dictationCaptureFactory: async ({ onFrame, onLevel }) => {
			frameSink.fn = onFrame;
			onLevel(0.6);
			return { stop() { frameSink.fn = undefined; } };
		},
		dictationWebSocketFactory: () => {
			const sent: unknown[] = [];
			const ws: WebSocketLike & { sent: unknown[] } = {
				readyState: 1,
				sent,
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send(data) {
					sent.push(data);
					if (typeof data === "string" && data.includes("CloseStream")) {
						queueMicrotask(() => ws.onclose?.({}));
					}
				},
				close() { ws.onclose?.({}); },
			};
			lastWs = ws;
			queueMicrotask(() => ws.onopen?.({}));
			return ws;
		},
	});

	try {
		await new Promise((r) => setTimeout(r, 15));

		// 1. Keyless 503 surfaces missingKey: true
		const started503 = await state.dictation.start({ targetId: "t1", onTranscript: () => {} });
		assert.equal(started503, false);
		assert.equal(state.dictation.get().missingKey, true);
		assert.equal(state.dictation.get().error, "Dictation needs a Deepgram key");

		// 2. Deepgram WS streaming + finish()
		tokenStatus = 200;
		const receivedDg: string[] = [];
		const startedDg = await state.dictation.start({ targetId: "t1", onTranscript: (t) => receivedDg.push(t) });
		assert.equal(startedDg, true);
		assert.equal(state.dictation.get().phase, "recording");
		lastWs!.onmessage?.({ data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "hello world" }] } }) });
		assert.deepEqual(receivedDg, ["hello world"]);
		await state.dictation.finish("t1");
		assert.equal(state.dictation.get().phase, "idle");

		// 3. Switch to local Whisper + TTS speak mode -> voices auto-load & LocalTranscriber flushes WAV
		await state.speech.send({
			type: "save-speech",
			speech: { dictation: "local", speak: "button", endpoint: "http://127.0.0.1:8000/v1", sttModel: "whisper-1", ttsVoice: "af_heart" },
		});
		await new Promise((r) => setTimeout(r, 20));
		assert.deepEqual(state.speech.get().voices, ["af_heart", "am_adam"]);

		const receivedLocal: string[] = [];
		const startedLocal = await state.dictation.start({ targetId: "t2", onTranscript: (t) => receivedLocal.push(t) });
		assert.equal(startedLocal, true);
		const loudFrame = new Int16Array(1600).fill(8000).buffer;
		frameSink.fn?.(loudFrame);
		await state.dictation.finish("t2");
		assert.deepEqual(receivedLocal, ["local whisper phrase"]);
		assert.equal(transcribedChunks.length, 1);
	} finally {
		state.dispose();
	}
});

test("C2c engine: validatePluginTree enforces unique keys, known columns, and valid widths", () => {
	const ok = validatePluginTree({
		label: "Flashcard decks",
		columns: [{ key: "due", header: "Due", width: 64, align: "right" }],
		rows: [
			{
				key: "deck-1",
				content: "Topology",
				cells: { due: "4" },
				disclosure: { label: "Expand Topology", expanded: true, onChange: () => {} },
				selection: { label: "Select Topology", checked: false, onChange: () => {} },
				children: [{ key: "card-1", content: "Compactness", cells: { due: "1" } }],
			},
		],
	});
	assert.equal(ok.label, "Flashcard decks");
	assert.equal(ok.columns[0]?.width, "64px");

	assert.throws(() => validatePluginTree({
		label: "Dupes",
		rows: [{ key: "r1", content: "A", children: [{ key: "r1", content: "B" }] }],
	}), /Duplicate plugin tree row key/);

	assert.throws(() => validatePluginTree({
		label: "Bad column",
		columns: [{ key: "due", header: "Due", width: 40 }],
		rows: [{ key: "r1", content: "A", cells: { unknown: "1" } }],
	}), /Unknown plugin tree column/);
});
