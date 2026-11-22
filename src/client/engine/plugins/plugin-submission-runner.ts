import {
	copyPluginSubmissionHistory,
	copyPluginSubmissionTarget,
	preparePluginSubmission,
	type LhMessage,
	type PluginSubmission,
	type PluginSubmissionContext,
	type PluginSubmissionInterceptor,
	type PluginSubmissionTarget,
} from "../../../core/index.ts";

export interface SubmissionInterceptorRegistration {
	readonly pluginId: string;
	readonly pluginName: string;
	readonly interceptor: Readonly<PluginSubmissionInterceptor>;
	readonly signal: AbortSignal;
	isCurrent(): boolean;
	report(error: unknown): void;
}

export function orderSubmissionInterceptors(
	a: SubmissionInterceptorRegistration,
	b: SubmissionInterceptorRegistration,
): number {
	return (
		(b.interceptor.priority ?? 0) - (a.interceptor.priority ?? 0) ||
		(a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0) ||
		(a.interceptor.id < b.interceptor.id ? -1 : a.interceptor.id > b.interceptor.id ? 1 : 0)
	);
}

const aborted = () => new DOMException("Submission preparation canceled", "AbortError");

function abortable<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(aborted());
	return new Promise((resolve, reject) => {
		const abort = () => reject(aborted());
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export class SubmissionModelEpoch {
	private known: string | undefined;
	private revision = 0;

	observe(model: string | undefined): void {
		if (model === undefined) return;
		if (this.known !== undefined && model !== this.known) this.revision++;
		this.known = model;
	}

	capture(): number { return this.revision; }
	isCurrent(revision: number): boolean { return revision === this.revision; }
}

export class PluginSubmissionRunner {
	private active: SubmissionAttempt | null = null;

	constructor(private changed: () => void = () => {}) {}

	get preparing(): boolean { return this.active?.phase === "preparing"; }
	get occupied(): boolean { return this.active !== null; }

	begin(
		target: PluginSubmissionTarget,
		registrations: readonly SubmissionInterceptorRegistration[],
		isCurrent: () => boolean,
	): SubmissionAttempt | null {
		if (this.active) return null;
		const release = () => {
			if (this.active === attempt) { this.active = null; this.changed(); }
		};
		const sorted = [...registrations].sort(orderSubmissionInterceptors);
		const attempt = new SubmissionAttempt(copyPluginSubmissionTarget(target), sorted, isCurrent, release, this.changed);
		this.active = attempt;
		this.changed();
		return attempt;
	}

	cancel = (): void => { if (this.active?.phase === "preparing") this.active.cancel(); };
	dispose(): void { this.active?.cancel(); }
}

async function runSingleInterceptor(
	attempt: SubmissionAttempt,
	owner: SubmissionInterceptorRegistration,
	currentResult: PluginSubmission,
	history: PluginSubmissionContext["messages"],
	callbacks: { owner: SubmissionInterceptorRegistration; callback: () => void | Promise<void> }[],
	isAttemptCurrent: () => boolean,
): Promise<PluginSubmission | null> {
	attempt.check();
	let open = true;
	const onAccepted = (callback: () => void | Promise<void>) => {
		if (open && !attempt.signal.aborted && owner.isCurrent() && typeof callback === "function") {
			callbacks.push({ owner, callback });
		}
	};
	const context = Object.freeze({ ...attempt.target, messages: history, signal: attempt.signal, onAccepted }) as PluginSubmissionContext;
	try {
		const returned = owner.interceptor.intercept(currentResult, context);
		if (!returned || typeof (returned as Promise<unknown>).then !== "function") open = false;
		const next = await abortable(returned, attempt.signal);
		open = false;
		attempt.check();
		if (next === null) { attempt.cancel(); return null; }
		return next !== undefined ? preparePluginSubmission(next, attempt.target) : currentResult;
	} catch (error) {
		open = false;
		if (attempt.signal.aborted || !owner.isCurrent() || !isAttemptCurrent()) {
			attempt.cancel();
			throw aborted();
		}
		owner.report(error);
		attempt.cancel();
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not prepare submission (${owner.pluginName}): ${detail}. Your input has been kept.`);
	}
}

function fireAcceptedCallbacks(callbacks: readonly { owner: SubmissionInterceptorRegistration; callback: () => void | Promise<void> }[]): void {
	for (const { owner, callback } of callbacks) {
		if (!owner.isCurrent()) continue;
		try { void Promise.resolve(callback()).catch((error) => owner.report(error)); }
		catch (error) { owner.report(error); }
	}
}

export class SubmissionAttempt {
	private controller = new AbortController();
	private callbacks: { owner: SubmissionInterceptorRegistration; callback: () => void | Promise<void> }[] = [];
	private cleanups: (() => void)[] = [];
	private finished = false;
	private lastOwner?: SubmissionInterceptorRegistration;
	phase: "preparing" | "delivering" | "finished" = "preparing";

	constructor(
		readonly target: PluginSubmissionTarget,
		private registrations: readonly SubmissionInterceptorRegistration[],
		private current: () => boolean,
		private release: () => void,
		private changed: () => void,
	) {
		for (const owner of registrations) {
			const abort = () => this.cancel();
			owner.signal.addEventListener("abort", abort, { once: true });
			this.cleanups.push(() => owner.signal.removeEventListener("abort", abort));
		}
	}

	get signal(): AbortSignal { return this.controller.signal; }

	check(): void {
		if (this.signal.aborted || !this.current() || this.registrations.some((owner) => !owner.isCurrent())) {
			this.cancel();
			throw aborted();
		}
	}

	async finalize<T>(callback: () => T | Promise<T>): Promise<T> {
		this.check();
		const result = await abortable(callback(), this.signal);
		this.check();
		return result;
	}

	async prepare(input: PluginSubmission, messages: readonly LhMessage[]): Promise<PluginSubmission | null> {
		this.check();
		let result: PluginSubmission | null = preparePluginSubmission(input, this.target);
		const history = this.registrations.length ? copyPluginSubmissionHistory(messages) : [];
		for (const owner of this.registrations) {
			this.lastOwner = owner;
			result = await runSingleInterceptor(this, owner, result, history, this.callbacks, this.current);
			if (result === null) return null;
		}
		this.check();
		return result;
	}

	preparationFailure(error: unknown): Error {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("Could not prepare submission (")) return error as Error;
		if (this.lastOwner) {
			this.lastOwner.report(error);
			return new Error(`Could not prepare submission (${this.lastOwner.pluginName}): ${message}. Your input has been kept.`);
		}
		return new Error(`${message}${message.includes("Your input has been kept.") ? "" : ". Your input has been kept."}`);
	}

	deliver(): void {
		this.check();
		this.phase = "delivering";
		this.changed();
	}

	accepted = (): void => {
		if (this.finished) return;
		const callbacks = [...this.callbacks];
		this.finish();
		fireAcceptedCallbacks(callbacks);
	};

	refused = (): void => this.finish();

	cancel(): void {
		if (this.phase !== "preparing") return;
		this.controller.abort();
		this.finish();
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.phase = "finished";
		for (const cleanup of this.cleanups) cleanup();
		this.cleanups = [];
		this.callbacks = [];
		this.release();
	}
}
