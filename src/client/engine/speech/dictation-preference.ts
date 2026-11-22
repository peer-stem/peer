import {
	FACTORY_SETTINGS,
	isDictationLanguage,
	sanitizeUserSettings,
	type DictationLanguage,
	type UserSettings,
} from "../../../core/index.ts";
import { notifySettingsSaved, onSettingsSaved } from "../dom/settings-signal.ts";

export interface DictationLanguageSnapshot {
	language: DictationLanguage | undefined;
	saving: boolean;
	error: string | null;
}

const INITIAL: DictationLanguageSnapshot = { language: undefined, saving: false, error: null };

interface PreferenceStoreState {
	snapshot: DictationLanguageSnapshot;
	reading: Promise<DictationLanguage> | null;
	writing: Promise<boolean> | null;
	revision: number;
	needsRead: boolean;
	readonly listeners: Set<() => void>;
	readonly request: typeof fetch;
	readonly saved: () => void;
	publish: (patch: Partial<DictationLanguageSnapshot>) => void;
	getLanguage: () => Promise<DictationLanguage>;
}

async function performLanguageRead(state: PreferenceStoreState, version: number): Promise<DictationLanguage> {
	try {
		const res = await state.request("/api/settings");
		if (!res.ok) throw new Error();
		const body = (await res.json()) as { settings: UserSettings | null };
		if (!("settings" in body)) throw new Error();
		const record = sanitizeUserSettings(body.settings);
		if (body.settings !== null && record === null) throw new Error();
		if (version !== state.revision) return state.getLanguage();
		const language = record?.dictation?.language ?? FACTORY_SETTINGS.dictation.language;
		state.needsRead = false;
		state.publish({ language, error: null });
		return language;
	} catch {
		if (version !== state.revision) return state.getLanguage();
		const message = "Could not load dictation language. Try again.";
		state.publish({ error: message });
		throw new Error(message);
	} finally {
		if (version === state.revision) state.reading = null;
	}
}

function loadDictationLanguage(state: PreferenceStoreState, refresh = false): Promise<DictationLanguage> {
	if (state.writing) return state.getLanguage();
	if (state.reading && !refresh) return state.reading;
	if (!refresh && !state.needsRead && state.snapshot.language !== undefined) {
		return Promise.resolve(state.snapshot.language);
	}
	const version = ++state.revision;
	state.needsRead = true;
	state.reading = Promise.resolve().then(() => performLanguageRead(state, version));
	return state.reading;
}

async function performLanguageSave(state: PreferenceStoreState, language: DictationLanguage): Promise<boolean> {
	try {
		const res = await state.request("/api/settings/dictation", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ language }),
		});
		if (!res.ok) throw new Error();
		const body = (await res.json()) as { settings: UserSettings };
		const confirmed = body.settings?.dictation?.language;
		if (!isDictationLanguage(confirmed)) throw new Error();
		state.needsRead = false;
		state.publish({ language: confirmed, error: null });
		state.saved();
		return true;
	} catch {
		state.publish({ error: "Could not save dictation language. Try again." });
		return false;
	} finally {
		state.writing = null;
		state.publish({ saving: false });
	}
}

function saveDictationLanguage(state: PreferenceStoreState, language: DictationLanguage): Promise<boolean> {
	if (state.writing || state.snapshot.language === undefined) return Promise.resolve(false);
	state.revision++;
	state.reading = null;
	state.writing = Promise.resolve().then(() => performLanguageSave(state, language));
	state.publish({ saving: true, error: null });
	return state.writing;
}

async function resolveCurrentLanguage(state: PreferenceStoreState): Promise<DictationLanguage> {
	for (;;) {
		if (state.writing) await state.writing;
		else if (state.reading) await state.reading;
		else if (state.needsRead || state.snapshot.language === undefined) await loadDictationLanguage(state);
		else return state.snapshot.language;
	}
}

export function createDictationLanguageStore(request: typeof fetch, saved: () => void = () => {}) {
	const state: PreferenceStoreState = {
		snapshot: INITIAL,
		reading: null,
		writing: null,
		revision: 0,
		needsRead: true,
		listeners: new Set(),
		request,
		saved,
		publish(patch) {
			state.snapshot = { ...state.snapshot, ...patch };
			for (const listener of state.listeners) listener();
		},
		getLanguage: () => resolveCurrentLanguage(state),
	};
	return {
		load: (refresh = false) => loadDictationLanguage(state, refresh),
		save: (language: DictationLanguage) => saveDictationLanguage(state, language),
		getLanguage: state.getLanguage,
		getSnapshot: () => state.snapshot,
		getServerSnapshot: () => INITIAL,
		subscribe(listener: () => void) {
			state.listeners.add(listener);
			return () => { state.listeners.delete(listener); };
		},
	};
}

let announcingSave = false;
export const dictationLanguageStore = createDictationLanguageStore((...args) => fetch(...args), () => {
	announcingSave = true;
	try {
		notifySettingsSaved("dictation");
	} finally {
		announcingSave = false;
	}
});

let readers = 0;
let stopSignals: (() => void) | undefined;

export function subscribeDictationLanguage(listener: () => void): () => void {
	const off = dictationLanguageStore.subscribe(listener);
	if (readers++ === 0) {
		stopSignals = onSettingsSaved((section) => {
			if (section === "dictation" && !announcingSave) void dictationLanguageStore.load(true).catch(() => {});
		});
		void dictationLanguageStore.getLanguage().catch(() => {});
	}
	return () => {
		off();
		if (--readers === 0) {
			stopSignals?.();
			stopSignals = undefined;
		}
	};
}
