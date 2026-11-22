import {
	preparePluginShortcut,
	preparePluginSubmissionInterceptor,
	type PluginAction,
	type PluginActionPlacement,
	type PluginCodeBlockRenderer,
	type PluginFrontendContext,
	type PluginInfo,
	type PluginProblemRenderer,
	type PluginQuestionRenderer,
	type PluginSettingsRegistration,
	type PluginSettingsSchema,
	type PluginSubmissionInterceptor,
	type PluginToolRenderer,
	type PluginUi,
	type PluginView,
} from "../../../core/index.ts";
import type { SubmissionInterceptorRegistration } from "./plugin-submission-runner.ts";
import {
	pluginViewPath,
	type ManagerBridge,
	type PluginLifecycle,
	type PluginRendererRegistration,
} from "./types.ts";
import {
	validateActionPlacement,
	validateProblemRenderer,
	validateQuestionRenderer,
	validateSettingsSchema,
	validateViewOrAction,
} from "./validators.ts";

function registerViewOrAction<T extends PluginView | PluginAction>(
	mgr: ManagerBridge,
	life: PluginLifecycle,
	map: Map<string, T>,
	item: T,
	callback: "mount" | "run",
): () => void {
	if (!mgr.current(life)) return () => {};
	validateViewOrAction(item, callback);
	if (map.has(item.id)) throw new Error(`Duplicate plugin registration: ${item.id}`);
	if (callback === "run" && (item as PluginAction).shortcut !== undefined) {
		life.shortcuts.set(item.id, preparePluginShortcut((item as PluginAction).shortcut));
	}
	map.set(item.id, item);
	mgr.publish();
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		if (map.get(item.id) === item) {
			map.delete(item.id);
			if (callback === "run") life.shortcuts.delete(item.id);
			mgr.publish();
		}
	};
}

function registerPluginRenderer<T extends PluginCodeBlockRenderer | PluginToolRenderer>(
	mgr: ManagerBridge,
	life: PluginLifecycle,
	map: Map<string, PluginRendererRegistration<T>>,
	renderer: T,
	kind: "language" | "toolName",
	reject: (text: string) => never,
): () => void {
	if (!mgr.current(life)) return () => {};
	const key = renderer && (kind === "language" ? (renderer as PluginCodeBlockRenderer).language : (renderer as PluginToolRenderer).toolName);
	if (typeof key !== "string" || !key.trim()) reject(`Plugin renderer ${kind} must be a nonempty string`);
	if (typeof renderer.mount !== "function") reject("Plugin renderer mount must be a function");
	const reserved = kind === "language" ? mgr.host.reservedCodeBlockLanguages : mgr.host.reservedToolNames;
	if (reserved?.includes(key)) reject(`Plugin renderer ${kind} is reserved by the host: ${key}`);
	const existing = kind === "language" ? mgr.getCodeBlock(key) : mgr.getToolRenderer(key);
	if (existing) reject(`Duplicate plugin renderer ${kind}: ${key}`);
	const presentation = kind === "toolName" ? (renderer as PluginToolRenderer).backgroundPresentation : undefined;
	if (presentation !== undefined && !["collapsed", "card", "plain"].includes(presentation)) {
		reject("Invalid plugin worker result presentation");
	}
	const ownedRenderer = Object.freeze({
		[kind]: key,
		mount: renderer.mount.bind(renderer),
		...(presentation ? { backgroundPresentation: presentation } : {}),
	}) as unknown as T;
	const registration: PluginRendererRegistration<T> = Object.freeze({ pluginId: life.id, renderer: ownedRenderer });
	const mounts = new Set<() => void>();
	mgr.rendererMounts.set(registration, mounts);
	map.set(key, registration);
	mgr.publish();
	let registered = true;
	return () => {
		if (!registered) return;
		registered = false;
		if (map.get(key) === registration) map.delete(key);
		for (const off of [...mounts]) off();
		mgr.publish();
	};
}

function createSettingsRegistrar(mgr: ManagerBridge, life: PluginLifecycle): PluginFrontendContext["registerSettings"] {
	return ((settings: PluginSettingsRegistration) => {
		if (!mgr.current(life)) return typeof settings === "function" ? () => {} : { update() {}, dispose() {} };
		if (typeof settings !== "function") validateSettingsSchema(settings);
		if (life.settings) throw new Error("Plugin settings are already registered");
		let owned = settings;
		life.settings = owned;
		mgr.publish();
		let registered = true;
		const dispose = () => {
			if (!registered) return;
			registered = false;
			if (life.settings === owned) { life.settings = undefined; mgr.publish(); }
		};
		if (typeof settings === "function") return dispose;
		const update = (next: Partial<PluginSettingsSchema>) => {
			if (!registered || !mgr.current(life) || life.settings !== owned) return;
			const schema = { ...owned, ...next };
			validateSettingsSchema(schema);
			owned = schema;
			life.settings = schema;
			mgr.publish();
		};
		return { update, dispose };
	}) as PluginFrontendContext["registerSettings"];
}

function registerPlacement(mgr: ManagerBridge, life: PluginLifecycle, placement: PluginActionPlacement): () => void {
	if (!mgr.current(life)) return () => {};
	validateActionPlacement(placement, life.actions);
	if (life.placements.has(placement.id)) throw new Error(`Duplicate plugin placement: ${placement.id}`);
	const owned = Object.freeze({
		...placement,
		...(placement.location === "top-bar" ? {
			...(placement.sessions ? { sessions: [...placement.sessions] } : {}),
			...(placement.views ? { views: [...placement.views] } : {}),
		} : {}),
	});
	life.placements.set(owned.id, owned);
	mgr.publish();
	return () => {
		if (life.placements.get(owned.id) === owned) {
			life.placements.delete(owned.id);
			mgr.publish();
		}
	};
}

function registerInterceptor(
	mgr: ManagerBridge,
	life: PluginLifecycle,
	pluginName: string,
	definition: PluginSubmissionInterceptor,
): () => void {
	if (!mgr.current(life)) return () => {};
	const validated = preparePluginSubmissionInterceptor(definition);
	const interceptor = Object.freeze({
		...validated,
		intercept: definition.intercept.bind(definition),
		...(definition.hasPendingInput ? { hasPendingInput: definition.hasPendingInput.bind(definition) } : {}),
	});
	if (life.submissionInterceptors.has(interceptor.id)) {
		throw new Error(`Duplicate submission interceptor: ${interceptor.id}`);
	}
	const controller = new AbortController();
	const abort = () => controller.abort();
	life.controller.signal.addEventListener("abort", abort, { once: true });
	const registration: SubmissionInterceptorRegistration = Object.freeze({
		pluginId: life.id,
		pluginName,
		interceptor,
		signal: controller.signal,
		isCurrent: () => mgr.current(life) && life.submissionInterceptors.get(interceptor.id) === registration,
		report: (error: unknown) => mgr.report(life, error),
	});
	life.submissionInterceptors.set(interceptor.id, registration);
	mgr.publish();
	return () => {
		if (life.submissionInterceptors.get(interceptor.id) !== registration) return;
		life.submissionInterceptors.delete(interceptor.id);
		controller.abort();
		life.controller.signal.removeEventListener("abort", abort);
		mgr.publish();
	};
}

function registerQuestionRenderer(
	mgr: ManagerBridge,
	life: PluginLifecycle,
	renderer: PluginQuestionRenderer,
	reject: (text: string) => never,
): () => void {
	if (!mgr.current(life)) return () => {};
	validateQuestionRenderer(renderer, reject);
	if (life.questionRenderers.has(renderer.id)) reject(`Duplicate question renderer: ${renderer.id}`);
	const owned = Object.freeze({
		id: renderer.id,
		supportedContractVersions: Object.freeze([...renderer.supportedContractVersions]) as unknown as number[],
		mountAnswerEditor: renderer.mountAnswerEditor.bind(renderer),
		...(renderer.mountQuestion ? { mountQuestion: renderer.mountQuestion.bind(renderer) } : {}),
		...(renderer.mountAnswered ? { mountAnswered: renderer.mountAnswered.bind(renderer) } : {}),
	});
	const registration = Object.freeze({ pluginId: life.id, renderer: owned });
	life.questionRenderers.set(owned.id, registration);
	mgr.publish();
	return () => {
		if (life.questionRenderers.get(owned.id) === registration) {
			life.questionRenderers.delete(owned.id);
			mgr.publish();
		}
	};
}

function registerProblemRenderer(
	mgr: ManagerBridge,
	life: PluginLifecycle,
	renderer: PluginProblemRenderer,
	reject: (text: string) => never,
): () => void {
	if (!mgr.current(life)) return () => {};
	validateProblemRenderer(renderer, reject);
	if (life.problemRenderers.has(renderer.id)) reject(`Duplicate problem renderer: ${renderer.id}`);
	const owned = Object.freeze({
		id: renderer.id,
		supportedContractVersions: Object.freeze([...renderer.supportedContractVersions]) as unknown as number[],
		mountSubmissionEditor: renderer.mountSubmissionEditor.bind(renderer),
		...(renderer.mountSubmitted ? { mountSubmitted: renderer.mountSubmitted.bind(renderer) } : {}),
	});
	const registration = Object.freeze({ pluginId: life.id, renderer: owned });
	life.problemRenderers.set(owned.id, registration);
	mgr.publish();
	return () => {
		if (life.problemRenderers.get(owned.id) === registration) {
			life.problemRenderers.delete(owned.id);
			mgr.publish();
		}
	};
}

async function convertPluginDocument(
	mgr: ManagerBridge,
	info: PluginInfo,
	life: PluginLifecycle,
	file: File,
	options?: { signal?: AbortSignal },
) {
	const signal = options?.signal ? AbortSignal.any([life.controller.signal, options.signal]) : life.controller.signal;
	const requireCurrent = () => {
		if (!mgr.current(life)) throw new Error("Plugin is no longer active");
		signal.throwIfAborted();
	};
	requireCurrent();
	if (!(file instanceof File)) throw new TypeError("Document conversion requires a File");
	const form = new FormData();
	form.append("file", file);
	try {
		const url = `/api/plugins/${encodeURIComponent(info.id)}/documents/markdown`;
		const result = (await mgr.json(url, { method: "POST", body: form, signal })) as Awaited<ReturnType<PluginFrontendContext["documents"]["toMarkdown"]>>;
		requireCurrent();
		return result;
	} catch (error) {
		requireCurrent();
		throw error;
	}
}

async function callPluginBackend<T>(mgr: ManagerBridge, info: PluginInfo, life: PluginLifecycle, operation: string, input?: unknown): Promise<T> {
	if (!mgr.current(life)) throw new Error("Plugin is no longer active");
	const body = (await mgr.json(`/api/plugins/${encodeURIComponent(info.id)}/call`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ operation, ...(input === undefined ? {} : { input }) }),
		signal: life.controller.signal,
	})) as { result: T };
	if (!mgr.current(life)) throw new Error("Plugin is no longer active");
	return body.result;
}

function createPluginAppNavigation(mgr: ManagerBridge, info: PluginInfo, life: PluginLifecycle): PluginFrontendContext["app"] {
	return {
		pathname: () => mgr.host.pathname(),
		openHome: () => { if (mgr.current(life)) mgr.host.navigate("/"); },
		openSession: (id) => { if (mgr.current(life)) mgr.host.navigate(`/chat/${encodeURIComponent(id)}`); },
		openView: (id) => { if (mgr.current(life)) mgr.host.navigate(pluginViewPath(info.id, id)); },
		openSettings: () => { if (mgr.current(life)) mgr.host.openSettings?.(info.id); },
	};
}

export function buildPluginFrontendContext(mgr: ManagerBridge, info: PluginInfo, life: PluginLifecycle): PluginFrontendContext {
	const manifest = info.manifest!;
	const rejectRenderer = (text: string): never => {
		const error = new Error(text);
		mgr.report(life, error);
		throw error;
	};
	const listen = <T>(set: Set<T>, listener: T) => {
		if (!mgr.current(life)) return () => {};
		set.add(listener);
		return () => { set.delete(listener); };
	};
	let ui: PluginUi | undefined;
	const resolveUi = () => {
		if (!ui) {
			if (!mgr.host.createUi) throw new Error("Plugin UI host is unavailable");
			ui = mgr.host.createUi({ signal: life.controller.signal, pluginId: life.id, onError: (err) => mgr.report(life, err) });
		}
		return ui;
	};
	return {
		manifest,
		signal: life.controller.signal,
		cleanup: (cleanup) => { mgr.addCleanup(life, cleanup); },
		registerView: (view) => registerViewOrAction(mgr, life, life.views, view, "mount"),
		registerAction: (action) => registerViewOrAction(mgr, life, life.actions, action, "run"),
		placeAction: (placement) => registerPlacement(mgr, life, placement),
		refreshActions: () => { if (mgr.current(life)) mgr.publish(); },
		refreshSubmissions: () => { if (mgr.current(life)) mgr.publish(); },
		registerSubmissionInterceptor: (def) => registerInterceptor(mgr, life, manifest.name, def),
		get ui() { return resolveUi(); },
		registerCodeBlock: (r) => registerPluginRenderer(mgr, life, life.codeBlocks, r, "language", rejectRenderer),
		registerToolRenderer: (r) => registerPluginRenderer(mgr, life, life.toolRenderers, r, "toolName", rejectRenderer),
		registerQuestionRenderer: (r) => registerQuestionRenderer(mgr, life, r, rejectRenderer),
		registerProblemRenderer: (r) => registerProblemRenderer(mgr, life, r, rejectRenderer),
		registerSettings: createSettingsRegistrar(mgr, life),
		call: <T>(operation: string, input?: unknown) => callPluginBackend<T>(mgr, info, life, operation, input),
		documents: { toMarkdown: (file, options) => convertPluginDocument(mgr, info, life, file, options) },
		onNotification: (listener) => listen(life.notifications, listener),
		onAppEvent: (listener) => listen(life.events, listener),
		onResync: (listener) => listen(life.resyncs, listener),
		app: createPluginAppNavigation(mgr, info, life),
	};
}
