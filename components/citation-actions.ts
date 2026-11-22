import { Quote } from "lucide-react";
import {
	createCiteAction as createEngineCiteAction,
	INSERT_CITATION_EVENT,
	type CitationEditTarget,
	type CitationInsertedRange,
	type InsertCitationDetail,
	type SelectionActionDescriptor,
} from "../src/client/engine/session/citation-actions.ts";
import type { SelectionAction } from "./selection-toolbar";

export {
	INSERT_CITATION_EVENT,
	type CitationEditTarget,
	type CitationInsertedRange,
	type InsertCitationDetail,
	type SelectionActionDescriptor,
};

export function createCiteAction(options: {
	chatId: string;
	composer: () => HTMLElement | null;
	openEditor: (target: CitationEditTarget) => void;
}): SelectionAction {
	return createEngineCiteAction({ ...options, icon: Quote });
}
