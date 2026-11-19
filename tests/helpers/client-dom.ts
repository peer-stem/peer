import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { installClientEnv } from "./client-env.ts";

export interface InstallDomOptions {
	url?: string;
	width?: number;
	height?: number;
}

export interface InstalledDom {
	document: Document;
	window: Window & typeof globalThis;
	cleanup(): Promise<void>;
}

const REQUIRED_GLOBALS = [
	"window",
	"document",
	"HTMLElement",
	"CustomEvent",
	"KeyboardEvent",
	"PointerEvent",
	"ResizeObserver",
	"NodeFilter",
	"CSS",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"getComputedStyle",
] as const;

function isUnescapedCssIdentChar(code: number): boolean {
	if (code >= 0x0080 || code === 0x002d || code === 0x005f) return true;
	if (code >= 0x0030 && code <= 0x0039) return true;
	if (code >= 0x0041 && code <= 0x005a) return true;
	return code >= 0x0061 && code <= 0x007a;
}

function escapeCssCodeUnit(code: number, index: number, length: number, firstCode: number): string {
	if (code === 0x0000) return "\uFFFD";
	if ((code >= 0x0001 && code <= 0x001f) || code === 0x007f) return `\\${code.toString(16)} `;
	if (index === 0 && code >= 0x0030 && code <= 0x0039) return `\\${code.toString(16)} `;
	if (index === 1 && code >= 0x0030 && code <= 0x0039 && firstCode === 0x002d) return `\\${code.toString(16)} `;
	if (index === 0 && length === 1 && code === 0x002d) return "\\-";
	if (isUnescapedCssIdentChar(code)) return String.fromCharCode(code);
	return `\\${String.fromCharCode(code)}`;
}

export function cssEscape(value: string): string {
	const str = String(value);
	const length = str.length;
	const firstCode = length > 0 ? str.charCodeAt(0) : 0;
	let result = "";
	for (let index = 0; index < length; index++) {
		result += escapeCssCodeUnit(str.charCodeAt(index), index, length, firstCode);
	}
	return result;
}

function ensureCssEscape(): () => void {
	const g = globalThis as Record<string, unknown>;
	if (typeof g.CSS === "undefined") {
		g.CSS = { escape: cssEscape };
		return () => {
			delete g.CSS;
		};
	}
	const cssObj = g.CSS as { escape?: (ident: string) => string };
	if (typeof cssObj.escape !== "function") {
		cssObj.escape = cssEscape;
	}
	return () => {};
}

function resetDocumentDom(): void {
	if (typeof globalThis.document === "undefined") return;
	globalThis.document.body?.replaceChildren();
	globalThis.document.head?.replaceChildren();
	const root = globalThis.document.documentElement;
	if (!root) return;
	root.className = "";
	root.removeAttribute("style");
	root.removeAttribute("data-theme-pending");
}

function assertRequiredGlobals(): void {
	const g = globalThis as Record<string, unknown>;
	const missing = REQUIRED_GLOBALS.filter((name) => typeof g[name] === "undefined");
	if (missing.length > 0) {
		throw new Error(`client-dom: happy-dom missing required globals: ${missing.join(", ")}`);
	}
}

async function unregisterDom(restoreCss: () => void): Promise<void> {
	resetDocumentDom();
	restoreCss();
	if (GlobalRegistrator.isRegistered) {
		await GlobalRegistrator.unregister();
	}
}

export function installDom(options?: InstallDomOptions): InstalledDom {
	installClientEnv();
	const url = options?.url ?? "http://127.0.0.1/";
	const width = options?.width ?? 1280;
	const height = options?.height ?? 800;
	if (!GlobalRegistrator.isRegistered) {
		GlobalRegistrator.register({ url, width, height });
	} else {
		resetDocumentDom();
		const happy = (globalThis as { happyDOM?: { setURL?(u: string): void; setViewport?(v: { width: number; height: number }): void } }).happyDOM;
		happy?.setURL?.(url);
		happy?.setViewport?.({ width, height });
	}
	const restoreCss = ensureCssEscape();
	if (!globalThis.document.doctype) {
		const dt = globalThis.document.implementation.createDocumentType("html", "", "");
		globalThis.document.insertBefore(dt, globalThis.document.documentElement);
	}
	assertRequiredGlobals();
	return {
		document: globalThis.document,
		window: globalThis.window,
		cleanup: () => unregisterDom(restoreCss),
	};
}
