import { eventBinding, type PluginActionShortcut } from "../../../core/index.ts";

export {
	pluginAssetUrl,
	pluginViewPath,
	type CodeBlockRegistration,
	type FrontendPlugin,
	type PluginHost,
	type PluginMount,
	type PluginRendererRegistration,
	type PluginSnapshot,
	type ProblemRendererRegistration,
	type QuestionRendererRegistration,
	type ToolRendererRegistration,
} from "./types.ts";
export { PluginFrontendManager } from "./manager.ts";
export * from "./plugin-input-focus.ts";
export * from "./plugin-question-dismissal.ts";
export * from "./plugin-question-editor.ts";
export * from "./plugin-question-keys.ts";
export * from "./plugin-submission-adapters.ts";
export * from "./plugin-submission-opening.ts";
export * from "./plugin-submission-runner.ts";
export * from "./plugin-surface-targets.ts";
export * from "./plugin-tree-validate.ts";

export function matchesPluginShortcut(event: KeyboardEvent, shortcut: PluginActionShortcut | undefined): boolean {
	if (!shortcut?.defaultBinding) return false;
	const pressed = eventBinding(event);
	return Boolean(pressed && pressed.toLowerCase() === shortcut.defaultBinding.toLowerCase());
}
