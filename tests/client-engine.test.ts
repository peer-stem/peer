import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseHTML } from "linkedom";
import * as engine from "../src/client/engine/index.ts";
import * as legacyDockSwitch from "../components/dock-switch.ts";
import * as legacyGraphCanvas from "../components/graph-canvas.ts";
import * as legacyPlanLayout from "../components/plan-layout.ts";
import * as legacyPluginManager from "../components/plugin-manager.ts";
import * as legacyQuestionLayout from "../components/question-layout.ts";
import * as legacySessionCore from "../components/session-core.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = path.join(REPO_ROOT, "src/client/engine");

function collectTsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) results.push(...collectTsFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".ts")) results.push(full);
	}
	return results.sort();
}

const FORBIDDEN_IMPORT_PATTERNS = [
	/from\s+["']react(?:\/|["'])/,
	/from\s+["']react-dom(?:\/|["'])/,
	/from\s+["']next(?:\/|["'])/,
	/from\s+["']lucide-react["']/,
	/from\s+["'](?:\.\.\/)*components\//,
	/from\s+["']@\/components\//,
	/from\s+["'](?:\.\.\/)*app\//,
	/from\s+["']@\/app\//,
	/from\s+["'](?:\.\.\/)*src\/(?:server|agent|memory|store|api)\//,
	/from\s+["']@\/src\/(?:server|agent|memory|store|api)/,
	/from\s+["'](?:\.\.\/)*client\/(?:state|views|blocks|theme|kit)/,
	/from\s+["']\.\.\/(?:state|views|blocks|theme|kit)\//,
];

function assertFunctionsBounded(rel: string, content: string): void {
	const sf = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const visit = (node: ts.Node): void => {
		if (
			ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isConstructorDeclaration(node) ||
			ts.isFunctionExpression(node) ||
			ts.isArrowFunction(node) ||
			ts.isGetAccessorDeclaration(node) ||
			ts.isSetAccessorDeclaration(node)
		) {
			const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
			const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
			const fnLines = endLine - startLine + 1;
			assert.ok(fnLines <= 50, `${rel}:${startLine}-${endLine} exceeds 50 lines per function/method (${fnLines})`);
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
}

describe("src/client/engine structural boundaries", () => {
	const files = collectTsFiles(ENGINE_DIR);

	it("discovers modular engine files across graph, session, plugins, speech, and dom", () => {
		assert.ok(files.length >= 50, `expected >= 50 engine modules, found ${files.length}`);
		for (const subdir of ["graph", "session", "plugins", "speech", "dom"]) {
			assert.ok(
				files.some((f) => path.relative(ENGINE_DIR, f).startsWith(`${subdir}/`)),
				`missing files in src/client/engine/${subdir}`,
			);
		}
	});

	it("keeps every engine file <= 500 lines (<= 450 target), <= 50 lines/fn, <= 3 tab levels, and zero forbidden imports", () => {
		for (const file of files) {
			const rel = path.relative(REPO_ROOT, file);
			const content = fs.readFileSync(file, "utf8");
			const lines = content.split("\n");
			const lineCount = content.endsWith("\n") ? lines.length - 1 : lines.length;
			assert.ok(lineCount <= 450, `${rel} exceeds 450 lines (${lineCount})`);
			assert.ok(lineCount <= 500, `${rel} exceeds 500 lines (${lineCount})`);

			for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
				assert.doesNotMatch(content, pattern, `${rel} matched forbidden import ${pattern}`);
			}

			lines.forEach((line, idx) => {
				const tabs = /^\t*/.exec(line)?.[0].length ?? 0;
				assert.ok(tabs <= 3, `${rel}:${idx + 1} exceeds 3 tab indentation levels (${tabs} tabs)`);
			});

			assertFunctionsBounded(rel, content);
		}
	});
});

describe("src/client/engine public barrel parity & runtime behavior", () => {
	it("re-exports identical core constructors and pure functions as legacy component shims", () => {
		assert.equal(engine.GraphCanvasRenderer, legacyGraphCanvas.GraphCanvasRenderer);
		assert.equal(engine.wrapRegionLabel, legacyGraphCanvas.wrapRegionLabel);
		assert.equal(engine.boxBlurRound, legacyGraphCanvas.boxBlurRound);
		assert.equal(engine.SessionModel, legacySessionCore.SessionModel);
		assert.equal(engine.PluginFrontendManager, legacyPluginManager.PluginFrontendManager);
		assert.equal(engine.blockLayout, legacyPlanLayout.blockLayout);
		assert.equal(engine.solveQuestionLayout, legacyQuestionLayout.solveQuestionLayout);
		assert.equal(engine.holdAcrossSwitch, legacyDockSwitch.holdAcrossSwitch);
	});

	it("executes graph math, blur, and label wrapping identically from engine barrel", () => {
		const wrapped = engine.wrapRegionLabel("alpha beta gamma delta epsilon", 60, 2, (s) => s.length * 6);
		assert.equal(wrapped.length, 2);
		assert.ok(wrapped[1]!.endsWith("…"));

		const src = new Float32Array([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		const tmp = new Float32Array(16);
		const dst = new Float32Array(16);
		engine.boxBlurRound(src, tmp, dst, 2, 2, 1);
		assert.ok(dst[0]! > 0 && dst[0]! < 255);
		assert.ok(dst[7]! > 0);
	});

	it("executes plan blockLayout and question solveQuestionLayout from engine barrel", () => {
		const plan = engine.blockLayout(
			[{ id: "a", title: "Foundations" }, { id: "b", title: "Applications" }],
			[{ from: "a", to: "b" }],
			engine.chartMeasure,
		);
		assert.ok(plan.width > 0 && plan.height > 0);
		assert.ok((plan.y.get("b") ?? 0) > (plan.y.get("a") ?? 0));

		const qLayout = engine.solveQuestionLayout({
			available: 900,
			base: 680,
			stackedNeed: 680,
			columns: {
				triggered: true,
				question: { min: 368, preferredMin: 368, max: 520, height: (w) => Math.round(120_000 / w) },
				answer: { min: 368, preferredMin: 368, max: 480, height: () => 220 },
			},
		});
		assert.equal(qLayout.kind, "columns");
	});

	it("instantiates SessionModel, PluginFrontendManager, and holdAcrossSwitch cleanly", () => {
		const session = new engine.SessionModel({ chatId: "c1", initialMessages: [] });
		assert.equal(session.status, "ready");
		assert.deepEqual(session.getState().messages, []);

		const manager = new engine.PluginFrontendManager({
			fetch: async () => new Response(JSON.stringify({ plugins: [], directory: "/plugins" })),
			importModule: async () => ({ activate() {} }),
			pathname: () => "/",
			navigate: () => {},
		});
		assert.equal(manager.getSnapshot().loading, true);

		const { document } = parseHTML("<!doctype html><html><body><div id='r'></div></body></html>");
		const root = document.getElementById("r") as unknown as HTMLElement;
		let applied = 0;
		const stop = engine.holdAcrossSwitch(root, () => { applied++; });
		assert.equal(applied, 1);
		stop();
	});
});
