import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function addPackageFileUrls(targetMap, relativePkgDir) {
	const pkgDir = path.join(REPO_ROOT, relativePkgDir);
	const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	for (const [key, target] of Object.entries(manifest.exports)) {
		if (key.includes("*") || !target.endsWith(".js")) continue;
		const specifier = key === "." ? manifest.name : `${manifest.name}/${key.slice(2)}`;
		targetMap.set(specifier, pathToFileURL(path.join(pkgDir, target.slice(2))).href);
	}
}

function buildSpecifierMap() {
	const map = new Map();
	addPackageFileUrls(map, "extern/cloudcanvas");
	addPackageFileUrls(map, "extern/cloudcanvas-lib");
	map.set("peer-state", pathToFileURL(path.join(REPO_ROOT, "src/client/state/index.ts")).href);
	map.set("peer-engine", pathToFileURL(path.join(REPO_ROOT, "src/client/engine/index.ts")).href);
	map.set("peer-kit", pathToFileURL(path.join(REPO_ROOT, "src/client/kit/index.js")).href);
	map.set("peer-keyboard", pathToFileURL(path.join(REPO_ROOT, "src/core/keyboard.ts")).href);
	map.set("peer-blocks-math", pathToFileURL(path.join(REPO_ROOT, "src/client/state/vendor-math.ts")).href);
	map.set("peer-blocks-code", pathToFileURL(path.join(REPO_ROOT, "src/client/state/vendor-code.ts")).href);
	map.set("peer-blocks-mermaid", pathToFileURL(path.join(REPO_ROOT, "src/client/state/vendor-mermaid.ts")).href);
	return map;
}

const SPECIFIER_MAP = buildSpecifierMap();

export function resolveSync(specifier, context, nextResolve) {
	const mapped = SPECIFIER_MAP.get(specifier);
	if (mapped !== undefined) {
		return nextResolve(mapped, context);
	}
	return nextResolve(specifier, context);
}

export async function resolve(specifier, context, nextResolve) {
	return resolveSync(specifier, context, nextResolve);
}
