import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/client-env.ts";
import { installDom } from "./helpers/client-dom.ts";
import { createInteractionScopeController, registerSurfaceBoundary } from "../src/client/engine/index.ts";

type AnyFn = (...args: any[]) => any;

function loadMod<T>(relPath: string): Promise<T> {
	return import(new URL(relPath, import.meta.url).href) as Promise<T>;
}

test("C2c views: PluginUi host mounts buttons, badges, settings rows, trees, menus, dialogs, and page surfaces", async () => {
	const dom = installDom();
	try {
		const { createPluginUiHost } = await loadMod<{ createPluginUiHost: AnyFn }>("../src/client/views/plugin/plugin-ui-host.js");
		const layerHost = dom.document.createElement("div");
		const pageBody = dom.document.createElement("div");
		const surfReg = dom.document.createElement("div");
		surfReg.setAttribute("data-session-surface-region", "");
		const surfMounts = dom.document.createElement("div");
		surfMounts.setAttribute("data-session-surface-mounts", "");
		surfReg.append(surfMounts);
		pageBody.append(surfReg);
		dom.document.body.append(pageBody, layerHost);

		const pageAbort = new AbortController();
		const boundary = registerSurfaceBoundary(pageBody, pageAbort.signal, createInteractionScopeController());
		const pluginAbort = new AbortController();
		const errors: unknown[] = [];

		const factory = createPluginUiHost({
			doc: dom.document,
			getLayerHost: () => layerHost,
			getModels: () => [{ provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", supportedThinkingLevels: ["off", "low", "high"] }],
			getPropositions: () => [{ id: "p1", name: "Compactness", statement: "Open cover has finite subcover" }],
		});
		const ui = factory({ signal: pluginAbort.signal, onError: (e: unknown) => errors.push(e) });

		// 1. Button + Badge
		const btnBox = dom.document.createElement("div");
		let clicks = 0;
		const btnH = ui.mountButton(btnBox, { label: "Review", variant: "default", onClick: () => { clicks += 1; } }, { signal: pluginAbort.signal });
		btnBox.querySelector("button")!.click();
		assert.equal(clicks, 1);
		assert.throws(() => btnH.update({ label: "" }), /nonempty/);

		const badgeBox = dom.document.createElement("div");
		ui.mountBadge(badgeBox, { text: "4 due", color: "#3b82f6" }, { signal: pluginAbort.signal });
		assert.equal(badgeBox.textContent, "4 due");

		// 2. Settings rows with inline validation
		const rowsBox = dom.document.createElement("div");
		let savedLimit = 20;
		ui.mountSettingsRows(rowsBox, {
			rows: [
				{
					key: "limit", label: "Daily limit", type: "number", min: 1, max: 100, value: savedLimit,
					onChange: (v: number) => { savedLimit = v; },
				},
			],
		}, { signal: pluginAbort.signal });
		const numInp = rowsBox.querySelector('[data-testid="plugin-setting-limit"]') as HTMLInputElement;
		numInp.value = "0";
		numInp.dispatchEvent(new dom.window.Event("change"));
		assert.equal(savedLimit, 20);
		assert.match(rowsBox.querySelector('[role="alert"]')!.textContent ?? "", /Minimum is 1/);
		numInp.value = "35";
		numInp.dispatchEvent(new dom.window.Event("change"));
		assert.equal(savedLimit, 35);

		// 3. Tree with selection + disclosure
		const treeBox = dom.document.createElement("div");
		let checked = false;
		ui.mountTree(treeBox, {
			label: "Decks",
			rows: [{ key: "d1", content: "Analysis", selection: { label: "Pick Analysis", checked: false, onChange: (v: boolean) => { checked = v; } } }],
		}, { signal: pluginAbort.signal });
		const chk = treeBox.querySelector('input[type="checkbox"]') as HTMLInputElement;
		chk.checked = true;
		chk.dispatchEvent(new dom.window.Event("change"));
		assert.equal(checked, true);

		// 4. Menu same-anchor toggle-close contract
		dom.document.body.append(btnBox);
		const anchor = btnBox.querySelector("button")!;
		let menuClosed = 0;
		ui.openMenu(anchor, { items: [{ key: "a", label: "Act", onSelect: () => {} }], onClose: () => { menuClosed += 1; } }, { signal: pluginAbort.signal });
		assert.ok(layerHost.querySelector('[data-testid="plugin-ui-menu"]'));
		ui.openMenu(anchor, { items: [{ key: "a", label: "Act", onSelect: () => {} }] }, { signal: pluginAbort.signal });
		assert.equal(layerHost.querySelector('[data-testid="plugin-ui-menu"]'), null);
		assert.equal(menuClosed, 1);

		// 5. Surface bound to explicit page target
		const surfH = ui.openSurface(boundary.target, {
			title: "Deck review",
			content: (el: HTMLElement) => { el.textContent = "Card 1 of 4"; },
		}, { signal: pluginAbort.signal });
		assert.match(surfMounts.querySelector('[data-testid="plugin-surface"]')!.textContent ?? "", /Card 1 of 4/);
		surfH.dispose();
		assert.equal(surfMounts.querySelector('[data-testid="plugin-surface"]'), null);
		assert.equal(errors.length, 0);

		pluginAbort.abort();
		pageAbort.abort();
	} finally {
		dom.cleanup();
	}
});

test("C2c views: plugin question/problem docks, chrome overflow bar, dictation control, speak button, and speech settings", async () => {
	const dom = installDom();
	try {
		const { createPluginActionsBar } = await loadMod<{ createPluginActionsBar: AnyFn }>("../src/client/views/plugin/plugin-chrome.js");
		const { createPluginQuestionDock } = await loadMod<{ createPluginQuestionDock: AnyFn }>("../src/client/views/plugin/plugin-question-dock.js");
		const { createDictationControl } = await loadMod<{ createDictationControl: AnyFn }>("../src/client/views/voice/dictation-control.js");
		const { createSpeakButton } = await loadMod<{ createSpeakButton: AnyFn }>("../src/client/views/voice/speak-button.js");
		const { createSpeechSettingsView } = await loadMod<{ createSpeechSettingsView: AnyFn }>("../src/client/views/voice/speech-section.js");

		const host = dom.document.createElement("div");
		dom.document.body.append(host);

		// 1. Top-bar actions + overflow menu
		const barHost = dom.document.createElement("div");
		host.append(barHost);
		const actionsBar = createPluginActionsBar(barHost, { location: "top-bar", testId: "plugin-top-bar-actions", maxVisible: 2 });
		const mkAct = (id: string) => ({ id, name: `Action ${id}`, run: () => {} });
		actionsBar.update({
			plugins: {
				plugins: [{
					info: { id: "p1" }, phase: "active", actionBusy: [],
					actions: [mkAct("1"), mkAct("2"), mkAct("3")],
					placements: [
						{ id: "pl1", actionId: "1", location: "top-bar" },
						{ id: "pl2", actionId: "2", location: "top-bar" },
						{ id: "pl3", actionId: "3", location: "top-bar" },
					],
				}],
			},
			context: { surface: "session", sessionId: "c1", kind: "teaching" },
		});
		assert.ok(barHost.querySelector('[data-testid="plugin-top-bar-menu"]'));

		// 2. Plugin question dock with custom answer editor lease
		const qHost = dom.document.createElement("div");
		host.append(qHost);
		const answers: unknown[] = [];
		const qDock = createPluginQuestionDock(qHost, { onAnswer: (p: unknown) => answers.push(p) });
		qDock.update({
			pendingPluginQuestion: {
				questionId: "pq1",
				pluginId: "coding-questions",
				rendererId: "code-editor",
				contractVersion: 1,
				toolName: "code_quiz",
				label: "Code challenge",
				prompt: "Return x * 2",
				payload: { starter: "return x;" },
				thinkingMode: "optional",
				occurrence: { messageId: "m1", contentIndex: 0, toolCallId: "tc1", toolName: "code_quiz" },
			},
			plugins: {
				questionRenderers: [{
					pluginId: "coding-questions",
					renderer: {
						id: "code-editor",
						supportedContractVersions: [1],
						mountAnswerEditor(slot: HTMLElement, props: any) {
							const b = slot.ownerDocument.createElement("button");
							b.textContent = "Fill solution";
							b.onclick = () => props.onChange({ status: "ready", value: { code: "return x * 2;" } });
							slot.append(b);
							return { update() {}, focus() {}, dispose() { b.remove(); } };
						},
					},
				}],
			},
		});
		const submitBtn = qHost.querySelector('[data-peer-action="submit-plugin-answer"]') as HTMLButtonElement;
		assert.equal(submitBtn.disabled, true);
		(qHost.querySelector('[data-testid="plugin-question-editor"] button') as HTMLButtonElement).click();
		assert.equal(submitBtn.disabled, false);
		submitBtn.click();
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(answers.length, 1);

		// 3. Dictation control + Speak button + Speech settings
		const voiceHost = dom.document.createElement("div");
		host.append(voiceHost);
		let openedKeys = 0;
		const fakeDictStore = {
			get: () => ({ phase: "idle", activeTargetId: "d-main", level: 0, error: "Dictation needs a Deepgram key", missingKey: true }),
			subscribe: () => () => {},
			start: async () => false,
			finish: async () => {},
			cancel: () => {},
		};
		const dictCtl = createDictationControl(voiceHost, {
			targetId: "d-main",
			dictation: fakeDictStore,
			onOpenDeepgramKey: () => { openedKeys += 1; },
		});
		(voiceHost.querySelector('[data-testid="dictation-error"]') as HTMLButtonElement).click();
		assert.equal(openedKeys, 1);

		const speakBtn = createSpeakButton(voiceHost, { id: "s1", getText: () => "Hello learner." });
		speakBtn.update({ speech: { speech: { speak: "button", endpoint: "http://127.0.0.1:8000/v1" } } });
		assert.equal((voiceHost.querySelector('[data-testid="speak-button"]') as HTMLElement).hidden, false);

		const speechIntents: unknown[] = [];
		const speechSec = createSpeechSettingsView(voiceHost, { onSpeechIntent: (i: unknown) => speechIntents.push(i) });
		const modeSel = voiceHost.querySelector('[data-testid="speech-speak-mode"]') as HTMLSelectElement;
		modeSel.value = "auto";
		modeSel.dispatchEvent(new dom.window.Event("change"));
		assert.equal(speechIntents.length, 1);

		speechSec.destroy();
		speakBtn.destroy();
		dictCtl.destroy();
		qDock.destroy();
		actionsBar.destroy();
	} finally {
		dom.cleanup();
	}
});
