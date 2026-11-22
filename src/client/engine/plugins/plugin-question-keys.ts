import type { PluginQuestionEditorKey } from "../../../core/index.ts";

const claimed = new WeakSet<object>();
const composing = new WeakSet<object>();

export interface EditorKeyOwner {
	eligible(key: string): boolean;
	contains(target: EventTarget | null): boolean;
	key(key: PluginQuestionEditorKey): "handled" | "pass";
	submit(): void;
	cycle(key: "Tab" | "Escape"): void;
}

let owner: EditorKeyOwner | null = null;

export function ownPluginQuestionKeys(next: EditorKeyOwner): () => void {
	owner = next;
	return () => {
		if (owner === next) owner = null;
	};
}

export function pluginQuestionKeySuppressed(event: { nativeEvent?: object } | object): boolean {
	const native = (event as { nativeEvent?: object }).nativeEvent ?? event;
	return claimed.has(native) || composing.has(native);
}

export function composingQuestionKey(event: {
	isComposing?: boolean;
	keyCode?: number;
	nativeEvent?: { isComposing?: boolean; keyCode?: number };
}): boolean {
	const native = event.nativeEvent ?? event;
	return native.isComposing === true || native.keyCode === 229;
}

export function capturePluginQuestionKey(event: KeyboardEvent): void {
	if (composingQuestionKey(event)) {
		composing.add(event);
		return;
	}
	const current = owner;
	if (!current?.eligible(event.key)) return;
	const claim = () => {
		claimed.add(event);
		event.preventDefault();
	};
	if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey) {
		claim();
		current.submit();
		return;
	}
	if (!current.contains(event.target)) {
		if (event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
			claim();
			current.cycle("Tab");
		}
		return;
	}
	if (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && (event.key === "Tab" || event.key === "Escape"))) return;
	const key = event.key === "Enter" && event.shiftKey ? "Shift+Enter" : event.key;
	if (key !== "Tab" && key !== "Enter" && key !== "Shift+Enter" && key !== "Escape") return;
	if (current.key(key) === "handled") {
		claim();
		return;
	}
	if (key === "Tab" || key === "Escape") {
		claim();
		current.cycle(key);
	}
	if (key === "Enter") {
		claim();
		current.submit();
	}
	if (key === "Shift+Enter") claimed.add(event);
}
