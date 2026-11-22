import {
	copyPluginSubmissionTarget,
	type PluginAction,
	type PluginActionContext,
	type PluginCleanup,
	type PluginInfo,
	type PluginNotification,
	type PluginPageActionContext,
	type PluginSubmissionTarget,
	type ServerEvent,
} from "../../../core/index.ts";
import {
	activatePluginLifecycle,
	buildFrontendPluginList,
	createEmptyLifecycle,
	mountPluginIntoContainer,
	startPluginAction,
	stopPluginLifecycle,
	type LifecycleStore,
} from "./lifecycle.ts";
import { orderSubmissionInterceptors, type SubmissionInterceptorRegistration } from "./plugin-submission-runner.ts";
import {
	errorMessage,
	type CodeBlockRegistration,
	type ManagerBridge,
	type PluginHost,
	type PluginLifecycle,
	type PluginMount,
	type PluginSnapshot,
	type ToolRendererRegistration,
} from "./types.ts";

function deliverEventToListeners<T>(
	bridge: ManagerBridge,
	life: PluginLifecycle,
	listeners: Set<(event: T) => void>,
	event: T,
): void {
	for (const listener of [...listeners]) {
		if (!bridge.current(life)) break;
		try {
			void Promise.resolve(listener(event)).catch((error) => bridge.report(life, error));
		} catch (error) {
			bridge.report(life, error);
		}
	}
}

function deliverResyncToLifecycle(bridge: ManagerBridge, life: PluginLifecycle): void {
	for (const listener of [...life.resyncs]) {
		if (!bridge.current(life)) break;
		try {
			void Promise.resolve(listener()).catch((error) => bridge.report(life, error));
		} catch (error) {
			bridge.report(life, error);
		}
	}
}

function checkInterceptorPendingInput(
	owner: SubmissionInterceptorRegistration,
	frozen: PluginSubmissionTarget,
	errors: WeakMap<object, string>,
): boolean {
	try {
		const hasPending = owner.interceptor.hasPendingInput?.(frozen) === true;
		errors.delete(owner);
		return hasPending;
	} catch (error) {
		const msg = errorMessage(error);
		if (errors.get(owner) !== msg) {
			errors.set(owner, msg);
			queueMicrotask(() => { if (owner.isCurrent()) owner.report(error); });
		}
		return false;
	}
}

export class PluginFrontendManager {
	private infos: PluginInfo[] = [];
	private lives = new Map<string, PluginLifecycle>();
	private teardowns = new Map<string, Promise<void>>();
	private listeners = new Set<() => void>();
	private pending = new Set<string>();
	private cleanupErrors = new Map<string, string>();
	private rendererMounts = new WeakMap<object, Set<() => void>>();
	private submissionPredicateErrors = new WeakMap<object, string>();
	private requestGeneration = 0;
	private mutations = 0;
	private disposed = false;
	private started = false;
	private shortcutPages = new Map<string, { read: () => PluginPageActionContext | undefined }>();
	private snapshot: PluginSnapshot = {
		plugins: [], codeBlocks: [], toolRenderers: [], directory: "", conflicts: [], loading: true, refreshing: false,
	};
	private readonly bridge: ManagerBridge;
	private readonly store: LifecycleStore;

	constructor(private host: PluginHost) {
		this.bridge = {
			host,
			rendererMounts: this.rendererMounts,
			current: (life) => this.current(life),
			publish: (patch) => this.publish(patch),
			report: (life, err) => this.report(life, err),
			addCleanup: (life, cleanup) => this.addCleanup(life, cleanup),
			json: (url, init) => this.json(url, init),
			getCodeBlock: (lang) => this.getCodeBlock(lang),
			getToolRenderer: (tool) => this.getToolRenderer(tool),
		};
		this.store = {
			bridge: this.bridge,
			lives: this.lives,
			teardowns: this.teardowns,
			cleanupErrors: this.cleanupErrors,
			pending: this.pending,
			isDisposed: () => this.disposed,
			track: (life, task) => this.track(life, task),
			disposeCallback: (life, cleanup) => this.disposeCallback(life, cleanup),
		};
	}

	getSnapshot = () => this.snapshot;

	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	private publish(patch: Partial<PluginSnapshot> = {}): void {
		if (this.disposed) return;
		this.snapshot = {
			...this.snapshot,
			...patch,
			codeBlocks: Object.freeze([...this.lives.values()].flatMap((l) => [...l.codeBlocks.values()])),
			toolRenderers: Object.freeze([...this.lives.values()].flatMap((l) => [...l.toolRenderers.values()])),
			questionRenderers: Object.freeze([...this.lives.values()].flatMap((l) => [...l.questionRenderers.values()])),
			problemRenderers: Object.freeze([...this.lives.values()].flatMap((l) => [...l.problemRenderers.values()])),
			plugins: buildFrontendPluginList(this.infos, this.lives, this.cleanupErrors, this.pending),
		};
		for (const listener of [...this.listeners]) listener();
	}

	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		void this.reload();
	}

	private current(life: PluginLifecycle): boolean {
		return !this.disposed && !life.controller.signal.aborted && this.lives.get(life.id) === life;
	}

	private report(life: PluginLifecycle, error: unknown): void {
		if (!this.current(life)) return;
		life.error = errorMessage(error);
		this.publish();
	}

	private disposeCallback(life: PluginLifecycle, cleanup: PluginCleanup): void {
		const failed = (error: unknown) => {
			const current = this.lives.get(life.id);
			if (this.disposed || (current && current !== life && current.phase !== "loading")) return;
			this.cleanupErrors.set(life.id, errorMessage(error));
			this.publish();
		};
		try { this.track(life, Promise.resolve(cleanup()).catch(failed)); }
		catch (error) { failed(error); }
	}

	private track(life: PluginLifecycle, task: Promise<void>): void {
		const settled = task.catch((error) => this.report(life, error));
		life.tasks.add(settled);
		void settled.then(() => { life.tasks.delete(settled); });
	}

	private addCleanup(life: PluginLifecycle, cleanup: PluginCleanup): () => void {
		if (!this.current(life)) {
			this.disposeCallback(life, cleanup);
			return () => {};
		}
		life.cleanups.add(cleanup);
		return () => {
			if (life.cleanups.delete(cleanup)) this.disposeCallback(life, cleanup);
		};
	}

	private async json(url: string, init?: RequestInit): Promise<unknown> {
		const response = await this.host.fetch(url, init);
		const body = await response.json();
		if (!response.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${response.status})`);
		return body;
	}

	async reload(clearError = true): Promise<void> {
		if (this.disposed || this.mutations) return;
		const generation = ++this.requestGeneration;
		try {
			const body = (await this.json("/api/plugins")) as { plugins?: PluginInfo[]; directory?: string; conflicts?: { id: string; error: string }[] };
			if (this.disposed || generation !== this.requestGeneration) return;
			this.reconcile(Array.isArray(body?.plugins) ? body.plugins : []);
			this.publish({ directory: body?.directory, conflicts: body?.conflicts ?? [], loading: false, ...(clearError ? { error: undefined } : {}) });
		} catch (error) {
			if (generation === this.requestGeneration) this.publish({ loading: false, error: errorMessage(error) });
		}
	}

	reconcile(rawInfos: PluginInfo[]): void {
		if (this.disposed) return;
		const infos = Array.isArray(rawInfos) ? rawInfos : [];
		this.infos = infos;
		for (const life of [...this.lives.values()]) {
			const info = infos.find((item) => item.id === life.id);
			if (!info?.enabled || info.status !== "active" || !info.manifest?.main || info.revision !== life.revision) void stopPluginLifecycle(this.store, life);
		}
		for (const info of infos) {
			if (!info.enabled || info.status !== "active" || !info.manifest?.main || this.lives.has(info.id)) continue;
			const life = createEmptyLifecycle(info);
			this.cleanupErrors.delete(info.id);
			this.lives.set(info.id, life);
			const previousTeardown = this.teardowns.get(info.id);
			const runActivate = async () => { await previousTeardown; if (this.current(life)) await activatePluginLifecycle(this.store, info, life); };
			life.activation = Promise.resolve().then(runActivate);
		}
		this.publish();
	}

	async setEnabled(id: string, enabled: boolean): Promise<void> {
		if (this.disposed || this.pending.has(id)) return;
		this.pending.add(id);
		this.mutations++;
		this.requestGeneration++;
		if (!enabled) this.reconcile(this.infos.map((info) => (info.id === id ? { ...info, enabled: false, status: "disabled" } : info)));
		this.publish({ error: undefined });
		try {
			await this.json(`/api/plugins/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
		} catch (error) {
			this.publish({ error: errorMessage(error) });
		} finally {
			this.requestGeneration++;
			this.pending.delete(id);
			this.mutations--;
			this.publish();
			await this.reload(false);
		}
	}

	async refresh(): Promise<void> {
		if (this.disposed || this.snapshot.refreshing || this.mutations) return;
		this.mutations++;
		this.requestGeneration++;
		this.publish({ refreshing: true, error: undefined });
		try {
			await this.json("/api/plugins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "refresh" }) });
		} catch (error) {
			this.publish({ error: errorMessage(error) });
		} finally {
			this.requestGeneration++;
			this.mutations--;
			this.publish({ refreshing: false });
			await this.reload(false);
		}
	}

	notify(event: PluginNotification): void {
		const life = this.lives.get(event.pluginId);
		if (life) deliverEventToListeners(this.bridge, life, life.notifications, event);
	}

	appEvent(event: ServerEvent): void {
		if (event.type === "plugin-message") return;
		for (const life of this.lives.values()) deliverEventToListeners(this.bridge, life, life.events, event);
	}

	resync(): void {
		void this.reload();
		for (const life of this.lives.values()) deliverResyncToLifecycle(this.bridge, life);
	}

	registerShortcutPage(pathname: string, read: () => PluginPageActionContext | undefined): () => void {
		const entry = { read };
		this.shortcutPages.set(pathname, entry);
		return () => { if (this.shortcutPages.get(pathname) === entry) this.shortcutPages.delete(pathname); };
	}

	shortcutPageContext(): PluginPageActionContext | undefined {
		if (this.disposed) return;
		const pathname = this.host.pathname();
		const page = this.shortcutPages.get(pathname);
		if (page) return page.read();
		if (/^\/(chat|plugins)\//.test(pathname) && pathname !== "/chat/new") return;
		return { surface: "app", pathname };
	}

	async runAction(id: string, action: PluginAction, context: PluginActionContext | (() => PluginActionContext | undefined)): Promise<void> {
		await startPluginAction(this.bridge, this.lives.get(id), action, context);
	}

	tryRunAction(id: string, action: PluginAction, context: () => PluginActionContext | undefined): boolean {
		return startPluginAction(this.bridge, this.lives.get(id), action, context) !== undefined;
	}

	captureSubmissionInterceptors(): readonly SubmissionInterceptorRegistration[] {
		const active = [...this.lives.values()].filter((life) => this.current(life));
		const all = active.flatMap((life) => [...life.submissionInterceptors.values()]);
		return Object.freeze(all.sort(orderSubmissionInterceptors));
	}

	hasPendingSubmissionInput(target: PluginSubmissionTarget): boolean {
		let pending = false;
		const frozen = copyPluginSubmissionTarget(target);
		for (const owner of this.captureSubmissionInterceptors()) {
			if (checkInterceptorPendingInput(owner, frozen, this.submissionPredicateErrors)) pending = true;
		}
		return pending;
	}

	getCodeBlock(language: string): CodeBlockRegistration | undefined {
		for (const life of this.lives.values()) {
			const registration = life.codeBlocks.get(language);
			if (this.current(life) && registration) return registration;
		}
	}

	getToolRenderer(toolName: string): ToolRendererRegistration | undefined {
		for (const life of this.lives.values()) {
			const registration = life.toolRenderers.get(toolName);
			if (this.current(life) && registration) return registration;
		}
	}

	mountRenderer(
		registration: CodeBlockRegistration | ToolRendererRegistration,
		mount: PluginMount,
		container: HTMLElement,
		onError: (error: string) => void,
	): () => void {
		const isRegistered = () => ("language" in registration.renderer
			? this.getCodeBlock(registration.renderer.language) === registration
			: this.getToolRenderer(registration.renderer.toolName) === registration);
		if (!isRegistered()) return () => {};
		const mounts = this.rendererMounts.get(registration)!;
		const off = this.mount(registration.pluginId, (child, sig) => (isRegistered() ? mount(child, sig) : undefined), container, onError);
		const release = () => { mounts.delete(release); off(); };
		mounts.add(release);
		return release;
	}

	mount(id: string, mount: PluginMount, container: HTMLElement, onError: (error: string) => void): () => void {
		const life = this.lives.get(id);
		if (!life || !this.current(life)) return () => {};
		return mountPluginIntoContainer(this.store, life, mount, container, onError);
	}

	dispose(): Promise<void> {
		if (!this.disposed) {
			this.disposed = true;
			this.requestGeneration++;
			this.shortcutPages.clear();
			for (const life of [...this.lives.values()]) void stopPluginLifecycle(this.store, life);
			this.listeners.clear();
		}
		return Promise.all([...this.teardowns.values()]).then(() => {});
	}
}
