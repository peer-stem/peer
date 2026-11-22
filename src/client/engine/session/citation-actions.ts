import { CITATION_MAX_TEXT_LENGTH, serializeCitation, type TutorCitation } from "../../../core/index.ts";
import type { CapturedSelection } from "./selection-text.ts";

export const INSERT_CITATION_EVENT = "lh:insert-citation";

export type CitationInsertedRange = {
	start: number;
	end: number;
	spaceBefore: boolean;
	spaceAfter: boolean;
};

export type InsertCitationDetail = {
	link: string;
	onInserted?: (range: CitationInsertedRange) => void;
};

export interface CitationEditTarget {
	citation: TutorCitation;
	link: string;
	start: number;
	host?: HTMLElement;
	input?: HTMLElement;
	fresh?: CitationInsertedRange;
}

export interface SelectionActionDescriptor<TIcon = undefined> {
	id: string;
	label: string;
	ariaLabel: string;
	icon: TIcon;
	disabledLabel?: (capture: CapturedSelection) => string | null;
	visible: (capture: CapturedSelection) => boolean;
	onSelect: (capture: CapturedSelection) => boolean;
}

function dispatchCiteInsertion(
	chatId: string,
	root: HTMLElement,
	capture: CapturedSelection,
	openEditor: (target: CitationEditTarget) => void,
): boolean {
	const citation: TutorCitation = { version: 1, chatId, messageId: capture.messageId, ...capture.selector };
	const link = serializeCitation(citation);
	const detail: InsertCitationDetail = {
		link,
		onInserted: (fresh) => openEditor({ citation, link, start: fresh.start, fresh, input: root }),
	};
	const View = root.ownerDocument.defaultView;
	root.dispatchEvent(new (View?.CustomEvent ?? CustomEvent)(INSERT_CITATION_EVENT, { detail }));
	return true;
}

export function createCiteAction<TIcon = undefined>({
	chatId,
	composer,
	openEditor,
	icon,
}: {
	chatId: string;
	composer: () => HTMLElement | null;
	openEditor: (target: CitationEditTarget) => void;
	icon?: TIcon;
}): SelectionActionDescriptor<TIcon> {
	return {
		id: "cite",
		label: "Cite",
		ariaLabel: "Cite selection in your input",
		icon: icon as TIcon,
		disabledLabel: (capture) => (capture.selector.text.length > CITATION_MAX_TEXT_LENGTH ? "Shorten selection" : null),
		visible: () => composer() !== null,
		onSelect: (capture) => {
			const root = composer();
			return root ? dispatchCiteInsertion(chatId, root, capture, openEditor) : false;
		},
	};
}
