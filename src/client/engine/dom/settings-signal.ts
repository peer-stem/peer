/**
 * Cross-surface settings signal: every writer dispatches after a successful PUT,
 * every reader re-reads via CustomEvent on window.
 */

export const SETTINGS_SAVED_EVENT = "lh:settings-saved";

export type SettingsSection =
	| "general"
	| "keys"
	| "agent"
	| "models"
	| "appearance"
	| "graph"
	| "compaction"
	| "dictation"
	| "claudeCode"
	| "externalCli"
	| "speech";

/** Writers call this after the PUT resolves ok — never before. */
export function notifySettingsSaved(section: SettingsSection): void {
	window.dispatchEvent(new CustomEvent(SETTINGS_SAVED_EVENT, { detail: { section } }));
}

/** Non-hook listener (imperative seams, tests). Returns an unsubscribe. */
export function onSettingsSaved(handler: (section: SettingsSection) => void): () => void {
	const listener = (e: Event) => {
		const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
		if (section !== undefined) handler(section);
	};
	window.addEventListener(SETTINGS_SAVED_EVENT, listener);
	return () => window.removeEventListener(SETTINGS_SAVED_EVENT, listener);
}
