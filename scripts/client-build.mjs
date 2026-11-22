/**
 * Client bundle builder (`C-12`, `client-contract-state §6.1`).
 * Bundles TypeScript `peer-state`, `keyboard.ts`, and Markdown vendor bridges
 * into `public/client/build/` via `esbuild`, keeping `cloudcanvas*` and
 * `node:crypto` external for browser import-map resolution, and copies KaTeX
 * stylesheet + `.woff2` fonts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const ROOT_DIR = path.resolve(import.meta.dirname, "..");

/**
 * @param {string} rootDir
 * @param {string} outdir
 */
function copyKatexAssets(rootDir, outdir) {
	const katexDist = path.join(rootDir, "node_modules", "katex", "dist");
	const katexOut = path.join(outdir, "katex");
	const fontsOut = path.join(katexOut, "fonts");
	fs.mkdirSync(fontsOut, { recursive: true });
	fs.copyFileSync(
		path.join(katexDist, "katex.min.css"),
		path.join(katexOut, "katex.min.css"),
	);
	const fontsSrc = path.join(katexDist, "fonts");
	for (const file of fs.readdirSync(fontsSrc)) {
		if (!file.endsWith(".woff2")) continue;
		fs.copyFileSync(path.join(fontsSrc, file), path.join(fontsOut, file));
	}
}

/**
 * @param {string} rootDir
 * @param {string} outdir
 * @param {"silent" | "info" | "warning" | "error"} logLevel
 * @returns {esbuild.BuildOptions}
 */
function createEsbuildOptions(rootDir, outdir, logLevel) {
	const pkgPath = path.join(rootDir, "package.json");
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	return {
		absWorkingDir: rootDir,
		entryPoints: {
			state: path.join(rootDir, "src/client/state/index.ts"),
			engine: path.join(rootDir, "src/client/engine/index.ts"),
			keyboard: path.join(rootDir, "src/core/keyboard.ts"),
			"blocks-math": path.join(rootDir, "src/client/state/vendor-math.ts"),
			"blocks-code": path.join(rootDir, "src/client/state/vendor-code.ts"),
			"blocks-mermaid": path.join(rootDir, "src/client/state/vendor-mermaid.ts"),
		},
		entryNames: "[name]",
		outdir,
		format: "esm",
		platform: "browser",
		target: "es2022",
		bundle: true,
		splitting: true,
		sourcemap: "linked",
		metafile: true,
		logLevel,
		external: [
			"node:crypto",
			"cloudcanvas",
			"cloudcanvas/*",
			"cloudcanvas-lib",
			"cloudcanvas-lib/*",
			"peer-kit",
		],
		define: {
			"process.env.APP_VERSION": JSON.stringify(pkg.version ?? "0.0.0"),
			"process.env.APP_HOMEPAGE": JSON.stringify(pkg.homepage ?? ""),
		},
	};
}

/**
 * @param {{
 *   rootDir?: string;
 *   outdir?: string;
 *   watch?: boolean;
 *   logLevel?: "silent" | "info" | "warning" | "error";
 * }} [options]
 */
export async function buildClient(options = {}) {
	const rootDir = options.rootDir ?? ROOT_DIR;
	const outdir = options.outdir ?? path.join(rootDir, "public", "client", "build");
	const logLevel = options.logLevel ?? "silent";
	fs.mkdirSync(outdir, { recursive: true });
	copyKatexAssets(rootDir, outdir);
	const buildOptions = createEsbuildOptions(rootDir, outdir, logLevel);
	if (options.watch) {
		const context = await esbuild.context(buildOptions);
		await context.watch();
		return { outdir, metafile: undefined, context };
	}
	const result = await esbuild.build(buildOptions);
	return { outdir, metafile: result.metafile, context: undefined };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
	const watch = process.argv.includes("--watch");
	await buildClient({ watch, logLevel: "info" });
}
