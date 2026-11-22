import assert from "node:assert/strict";
import test from "node:test";

await import("./helpers/client-env.ts");
const { installDom } = await import("./helpers/client-dom.ts");

test("createSearchMenu filters grouped options, navigates by keyboard, and selects on Enter", async () => {
	const dom = installDom();
	try {
		const { createSearchMenu } = await import("peer-kit");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const picked: string[] = [];
		const menu = createSearchMenu(host, { onSelect: (id: string) => picked.push(id) });
		menu.update({
			value: "sonnet",
			items: [
				{ id: "sonnet", label: "Claude Sonnet", group: "Anthropic", detail: "200k" },
				{ id: "opus", label: "Claude Opus", group: "Anthropic", detail: "200k" },
				{ id: "gpt", label: "GPT-5", group: "OpenAI", detail: "128k" },
			],
		});
		assert.equal(menu.trigger.textContent, "Claude Sonnet");
		menu.open();
		assert.equal(menu.panel.hidden, false);
		const search = menu.panel.querySelector("input")!;
		search.value = "openai";
		search.dispatchEvent(new dom.window.Event("input"));
		const visible = menu.panel.querySelectorAll('[role="option"]');
		assert.equal(visible.length, 1);
		menu.panel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		assert.deepEqual(picked, ["gpt"]);
		assert.equal(menu.panel.hidden, true);
		menu.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("createTokenInput inserts inline atomic chips, serializes structured output, and submits on Enter", async () => {
	const dom = installDom();
	try {
		const { createTokenInput } = await import("peer-kit");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const submitted: Array<{ text: string; tokens: Array<{ id: string }> }> = [];
		const tokInput = createTokenInput(host, {
			onSubmit: (payload: { text: string; tokens: Array<{ id: string }> }) => submitted.push(payload),
		});
		tokInput.update({ placeholder: "Ask anything…", value: "Explain " });
		tokInput.insertToken({ id: "file-1", kind: "path", label: "@notes.md", value: "@notes.md" });
		const snap = tokInput.serialize();
		assert.equal(snap.tokens.length, 1);
		assert.equal(snap.tokens[0]?.id, "file-1");
		assert.equal(snap.text.includes("@notes.md"), true);
		tokInput.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		assert.equal(submitted.length, 1);
		tokInput.clear();
		assert.equal(tokInput.serialize().tokens.length, 0);
		tokInput.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("createEditableTree expands folders, navigates with arrows, and commits inline F2 rename", async () => {
	const dom = installDom();
	try {
		const { createEditableTree } = await import("peer-kit");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const toggles: Array<[string, boolean]> = [];
		const renames: Array<[string, string]> = [];
		const tree = createEditableTree(host, {
			onToggle: (id: string, open: boolean) => toggles.push([id, open]),
			onRename: (id: string, name: string) => renames.push([id, name]),
		});
		tree.update({
			expandedIds: ["f1"],
			selectedId: "f1",
			nodes: [
				{ id: "f1", kind: "folder", label: "Physics", children: [{ id: "s1", kind: "item", label: "Kinematics" }] },
			],
		});
		assert.equal(tree.root.querySelectorAll('[role="treeitem"]').length, 2);
		tree.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F2", bubbles: true }));
		const renameInput = tree.root.querySelector('input[type="text"]') as HTMLInputElement;
		assert.notEqual(renameInput, null);
		renameInput.value = "Classical Mechanics";
		renameInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		assert.deepEqual(renames, [["f1", "Classical Mechanics"]]);
		tree.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		assert.deepEqual(toggles, [["f1", false]]);
		tree.destroy();
	} finally {
		await dom.cleanup();
	}
});

test("createPanZoom, createStickyScroll, createTooltip, createFloatingWindow, and createFindBar lifecycle", async () => {
	const dom = installDom();
	try {
		const {
			createFindBar,
			createFloatingWindow,
			createPanZoom,
			createStickyScroll,
			createTooltip,
		} = await import("peer-kit");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);

		const pz = createPanZoom(host);
		const svg = dom.document.createElement("div");
		pz.update({ content: svg, transform: { x: 12, y: -8, k: 1.5 } });
		assert.deepEqual(pz.getTransform(), { x: 12, y: -8, k: 1.5 });
		pz.reset();
		assert.deepEqual(pz.getTransform(), { x: 0, y: 0, k: 1 });

		const sticky = createStickyScroll(host);
		sticky.content.append(dom.document.createElement("p"));
		sticky.notifyGrowth();
		assert.equal(sticky.isAtBottom(), true);

		const targetBtn = dom.document.createElement("button");
		host.append(targetBtn);
		const tip = createTooltip(targetBtn, { host, delayMs: 0 });
		tip.update({ text: "Shortcut Mod+B" });
		targetBtn.dispatchEvent(new dom.window.Event("focus"));
		assert.equal(tip.bubble.hidden, false);
		dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		assert.equal(tip.bubble.hidden, true);

		const win = createFloatingWindow(host);
		win.update({ open: true, title: "Side Thread", geometry: { x: 40, y: 50, width: 320, height: 300 } });
		assert.equal(win.root.hidden, false);
		assert.equal(win.getGeometry().width, 320);

		const contentArea = dom.document.createElement("div");
		contentArea.innerHTML = "<p>Alpha theorem and beta lemma; alpha corollary.</p>";
		host.append(contentArea);
		const find = createFindBar(host, { targetRoot: contentArea });
		find.update({ open: true, query: "alpha" });
		assert.equal(find.getMatchCount(), 2);
		find.step(1);
		assert.equal(find.root.textContent?.includes("2/2"), true);

		pz.destroy();
		sticky.destroy();
		tip.destroy();
		win.destroy();
		find.destroy();
	} finally {
		await dom.cleanup();
	}
});
