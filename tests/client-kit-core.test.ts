import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { WORKTREE_ROOT } from "./api-test-helpers.ts";

await import("./helpers/client-env.ts");
const { installDom } = await import("./helpers/client-dom.ts");

function assertKitFunctionsBounded(file: string, content: string): void {
	const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const visit = (node: ts.Node): void => {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node)
		) {
			const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
			const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
			assert.equal(endLine - startLine + 1 <= 50, true, `${file}:${startLine}-${endLine} exceeds 50 lines/fn`);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

test("src/client/kit enforces zero peer imports, <= 300 LOC/file, <= 50 lines/fn, <= 3 tabs, and --cc-* tokens only", () => {
	const kitDir = path.join(WORKTREE_ROOT, "src", "client", "kit");
	const files = fs.readdirSync(kitDir).filter((f) => f.endsWith(".js"));
	assert.equal(files.length >= 12, true);
	for (const file of files) {
		const content = fs.readFileSync(path.join(kitDir, file), "utf8");
		const rawLines = content.split("\n");
		const lineCount = content.endsWith("\n") ? rawLines.length - 1 : rawLines.length;
		assert.equal(lineCount <= 300, true, `${file} exceeds 300 LOC (${lineCount})`);
		assert.equal(content.includes("--peer-"), false, `${file} must not reference --peer-* tokens`);
		assert.equal(/from\s+["'](?:\.\.\/|peer-|@\/)/.test(content), false, `${file} must not import peer modules`);
		rawLines.forEach((line, idx) => {
			const tabs = /^\t*/.exec(line)?.[0].length ?? 0;
			assert.equal(tabs <= 3, true, `${file}:${idx + 1} exceeds 3 tab indentation levels (${tabs})`);
		});
		assertKitFunctionsBounded(file, content);
	}
});

test("UI_LIGHT_THEME defines catalogued --cc-ui-* tokens and is frozen", async () => {
	const { UI_LIGHT_THEME } = await import("peer-kit");
	const { UI_TOKENS } = await import("cloudcanvas-lib/ui");
	assert.equal(Object.isFrozen(UI_LIGHT_THEME), true);
	for (const key of Object.keys(UI_LIGHT_THEME)) {
		assert.equal(key in UI_TOKENS, true, `UI_LIGHT_THEME key ${key} must exist in UI_TOKENS`);
	}
});

test("createKitMarkdown supports hooks, GFM tables, alerts, and streaming slot preservation without tokens", async () => {
	const dom = installDom();
	try {
		const { createKitMarkdown } = await import("peer-kit");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		let fenceMounts = 0;
		const md = createKitMarkdown(host, {
			readInline: (text: string, i: number) => (text.startsWith(":star:", i) ? { token: "★", next: i + 6 } : null),
			renderInline: (doc: Document, tok: unknown) => {
				const s = doc.createElement("mark");
				s.textContent = String(tok);
				return s;
			},
			createFenceSlot: ({ doc }: { doc: Document }) => {
				fenceMounts += 1;
				const el = doc.createElement("pre");
				el.setAttribute("data-custom-fence", "");
				return { key: "fence:js", el, update: (b: { source: string }) => { el.textContent = b.source; }, destroy: () => el.remove() };
			},
		});
		md.update({
			source: "```js\nconst a = 1;\n```\n\n| Col | Val |\n| --- | :---: |\n| X | :star: |\n\n> [!TIP]\n> Modular kit",
			streaming: true,
		});
		assert.equal(fenceMounts, 1);
		assert.equal(host.querySelector("table td mark")?.textContent, "★");
		assert.equal(host.querySelector('[data-alert-kind="tip"]')?.textContent?.includes("Modular kit"), true);
		md.update({
			source: "```js\nconst a = 1;\n```\n\n| Col | Val |\n| --- | :---: |\n| X | :star: |\n\n> [!TIP]\n> Modular kit\n\nAppended streaming line",
			streaming: true,
		});
		assert.equal(fenceMounts, 1, "completed fence slot must not remount during streaming");
		md.destroy();
		assert.equal(host.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});

test("createModal locks body scroll with reference counting and guards dragged backdrop clicks", async () => {
	const dom = installDom();
	try {
		const { createModal } = await import("peer-kit");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		const reasons: string[] = [];
		const modalA = createModal(host, { onClose: (r) => reasons.push(`A:${r}`) });
		const modalB = createModal(host, { onClose: (r) => reasons.push(`B:${r}`) });
		modalA.update({ open: true, title: "First" });
		assert.equal(dom.document.body.style.overflow, "hidden");
		modalB.update({ open: true, title: "Second" });
		modalB.update({ open: false, title: "Second" });
		assert.equal(dom.document.body.style.overflow, "hidden", "first modal still holds scroll lock");
		const dialogEl = modalA.body.closest("dialog")!;
		modalA.body.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
		dialogEl.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		assert.equal(reasons.length, 0, "drag starting inside modal body must not trigger backdrop close");
		dialogEl.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
		dialogEl.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		assert.deepEqual(reasons, ["A:backdrop"]);
		modalA.destroy();
		modalB.destroy();
		assert.equal(dom.document.body.style.overflow, "");
	} finally {
		await dom.cleanup();
	}
});

test("createDisclosure, createSpinner, createRingProgress, createNumberField, and createSliderField", async () => {
	const dom = installDom();
	try {
		const {
			createDisclosure,
			createNumberField,
			createRingProgress,
			createSliderField,
			createSpinner,
		} = await import("peer-kit");
		const host = dom.document.createElement("div");
		dom.document.body.append(host);
		let toggled: boolean | null = null;
		const disc = createDisclosure(host, { onToggle: (next) => { toggled = next; } });
		disc.update({ open: false, title: "Reasoning", meta: "2.1s" });
		assert.equal(disc.header.getAttribute("aria-expanded"), "false");
		disc.header.click();
		assert.equal(toggled, true);
		disc.update({ open: true, title: "Reasoning" });
		assert.equal(disc.body.hidden, false);

		const spin = createSpinner(host);
		spin.update({ label: "Extracting", size: 20 });
		assert.equal(spin.root.getAttribute("role"), "status");

		const ring = createRingProgress(host);
		ring.update({ value: 0.75, label: "Coverage" });
		assert.equal(ring.root.getAttribute("aria-valuenow"), "75");

		const nums: number[] = [];
		const numField = createNumberField(host, { onChange: (v) => nums.push(v) });
		numField.update({ value: 4, min: 1, max: 16, step: 1, label: "Workers" });
		numField.input.value = "99";
		numField.input.dispatchEvent(new dom.window.Event("change"));
		assert.deepEqual(nums, [16]);

		const slides: number[] = [];
		const slider = createSliderField(host, { onInput: (v) => slides.push(v) });
		slider.update({ value: 16, min: 12, max: 24, step: 1, label: "Font size" });
		slider.input.value = "18";
		slider.input.dispatchEvent(new dom.window.Event("input"));
		assert.deepEqual(slides, [18]);

		disc.destroy();
		spin.destroy();
		ring.destroy();
		numField.destroy();
		slider.destroy();
		assert.equal(host.childElementCount, 0);
	} finally {
		await dom.cleanup();
	}
});
