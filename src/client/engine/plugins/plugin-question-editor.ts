import {
	clonePluginQuestionJson,
	freezePluginQuestionValue,
	type PluginProblemEditorHandle,
	type PluginProblemEditorProps,
	type PluginQuestionAnswerState,
	type PluginQuestionEditorHandle,
	type PluginQuestionEditorKey,
	type PluginQuestionEditorProps,
} from "../../../core/index.ts";

export function controlledPluginAnswer(value: PluginQuestionAnswerState): PluginQuestionAnswerState {
	if (!value || !["empty", "ready", "unready"].includes(value.status)) throw new Error("Invalid answer state");
	return value.status === "empty"
		? Object.freeze({ status: "empty" })
		: freezePluginQuestionValue({ status: value.status, value: clonePluginQuestionJson(value.value) });
}

type EditorHandle = Pick<PluginQuestionEditorHandle, "focus" | "dispose" | "handleKeyDown" | "appendTranscript"> & { update: unknown };

function validEditorHandle<H extends EditorHandle>(next: H): boolean {
	return Boolean(
		next &&
		typeof next.update === "function" &&
		typeof next.focus === "function" &&
		typeof next.dispose === "function" &&
		(next.handleKeyDown === undefined || typeof next.handleKeyDown === "function") &&
		(next.appendTranscript === undefined || typeof next.appendTranscript === "function"),
	);
}

function safeDisposeHandle(handle: { dispose?: unknown } | null | undefined): void {
	try {
		if (typeof handle?.dispose === "function") (handle.dispose as () => void)();
	} catch { /* host fallback already owns the surface */ }
}

interface LeaseState<H extends EditorHandle> {
	current: boolean;
	handle: H | null;
	publishedReady: boolean;
	readonly controller: AbortController;
	dispose(): void;
	fail(): void;
}

function adoptLeaseHandle<H extends EditorHandle>(s: LeaseState<H>, next: H, changed: () => void): void {
	if (!s.current) { safeDisposeHandle(next); return; }
	if (!validEditorHandle(next)) { safeDisposeHandle(next); s.fail(); return; }
	s.handle = next;
	changed();
}

function createEditorLease<P, H extends EditorHandle>(options: {
	props(signal: AbortSignal, onChange: (state: PluginQuestionAnswerState) => void): P;
	update(handle: H, state: PluginQuestionAnswerState, active: boolean): void;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	const s: LeaseState<H> = {
		current: true, handle: null, publishedReady: false, controller: new AbortController(),
		dispose() {
			if (!s.current) return;
			s.current = false;
			s.controller.abort();
			const old = s.handle;
			s.handle = null;
			safeDisposeHandle(old);
			options.changed();
		},
		fail() { if (s.current) { options.failed(); s.dispose(); } },
	};
	const props = options.props(s.controller.signal, (state) => {
		if (!s.current) return;
		try { const v = controlledPluginAnswer(state); options.publish(v); s.publishedReady = v.status === "ready"; options.changed(); }
		catch { s.fail(); }
	});
	return {
		props,
		adopt: (next: H) => adoptLeaseHandle(s, next, options.changed),
		get ready() { return s.current && s.handle !== null && s.publishedReady; },
		get mounted() { return s.current && s.handle !== null; },
		get speech() { return s.current && Boolean(s.handle?.appendTranscript); },
		update(state: PluginQuestionAnswerState, active: boolean) {
			if (s.current && s.handle) try { options.update(s.handle, state, active); } catch { s.fail(); }
		},
		focus() { if (s.current && s.handle) try { s.handle.focus(); } catch { s.fail(); } },
		key(key: PluginQuestionEditorKey): "handled" | "pass" {
			if (s.current && s.handle?.handleKeyDown) try { return s.handle.handleKeyDown(key) === "handled" ? "handled" : "pass"; } catch { s.fail(); }
			return "pass";
		},
		async append(text: string) {
			const adopted = s.current ? s.handle : null;
			if (adopted?.appendTranscript) try { await adopted.appendTranscript(text); } catch { s.fail(); }
		},
		fail: s.fail,
		dispose: s.dispose,
	};
}

export function createQuestionEditorLease(options: {
	props: PluginQuestionEditorProps;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	return createEditorLease<PluginQuestionEditorProps, PluginQuestionEditorHandle>({
		...options,
		props: (signal, onChange) => Object.freeze({ ...options.props, signal, onChange }),
		update: (handle, answer, active) => handle.update({ answer, active }),
	});
}

export function createProblemEditorLease(options: {
	props: PluginProblemEditorProps;
	publish(state: PluginQuestionAnswerState): void;
	changed(): void;
	failed(): void;
}) {
	return createEditorLease<PluginProblemEditorProps, PluginProblemEditorHandle>({
		...options,
		props: (signal, onChange) => Object.freeze({ ...options.props, signal, onChange }),
		update: (handle, submission, active) => handle.update({ submission, active }),
	});
}

export type QuestionEditorLease = ReturnType<typeof createQuestionEditorLease>;
export type ProblemEditorLease = ReturnType<typeof createProblemEditorLease>;
