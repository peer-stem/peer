import type { LumberJackForest } from "./binding.ts";
import { encodeEntitySegment, isPlainRecord } from "./graph-guards.ts";

export interface FsrsCardSchedule {
	due: number | string;
	stability: number;
	difficulty: number;
	elapsed_days?: number;
	scheduled_days?: number;
	reps: number;
	lapses: number;
	learning_steps?: number;
	state: number;
	last_review?: number | string | null;
}

export interface LearnerProfileRecord {
	goals: string[];
	interests: string[];
	learningStyle?: string;
	confidenceCalibration?: number;
	updatedAt: string;
}

export interface FlashcardDeckRecord {
	id: string;
	name: string;
	propositionIds: string[];
	cards: Array<{ id: string; front: string; back: string; propositionId?: string; fsrs?: FsrsCardSchedule }>;
	updatedAt: string;
}

export type PropProgress = { mastery?: number; fsrs?: FsrsCardSchedule };

export interface LumberJackLearnerStore {
	readProfile(): LearnerProfileRecord | null;
	writeProfile(profile: LearnerProfileRecord): void;
	updatePropositionProgress(nodeId: string, progress: PropProgress): void;
	readPropositionProgress(nodeId: string): PropProgress | null;
	deletePropositionProgress(nodeId: string): boolean;
	upsertDeck(deck: FlashcardDeckRecord): void;
	listDecks(): FlashcardDeckRecord[];
}

function extractProgressFields(raw: unknown): PropProgress {
	if (!isPlainRecord(raw)) return {};
	const out: PropProgress = {};
	if (typeof raw.mastery === "number" && Number.isFinite(raw.mastery)) out.mastery = raw.mastery;
	if (isPlainRecord(raw.fsrs)) out.fsrs = raw.fsrs as unknown as FsrsCardSchedule;
	return out;
}

export function readPropProgressNode(forest: LumberJackForest, nodeId: string): PropProgress | null {
	const encodedKey = encodeEntitySegment(nodeId);
	const snap = forest.getNode(`learner/progress/${encodedKey}`);
	if (snap) {
		const storedOwner = isPlainRecord(snap.slot) && typeof snap.slot.nodeId === "string" ? snap.slot.nodeId : nodeId;
		if (storedOwner !== nodeId) return null;
		const merged = { ...extractProgressFields(snap.metadata), ...extractProgressFields(snap.slot) };
		return merged.mastery !== undefined || merged.fsrs !== undefined ? merged : null;
	}
	const propSnap = forest.getNode(`knowledge/propositions/${encodedKey}`);
	if (propSnap && (propSnap.metadata?.nodeId === undefined || propSnap.metadata.nodeId === nodeId)) {
		const legacy = extractProgressFields(propSnap.metadata);
		return legacy.mastery !== undefined || legacy.fsrs !== undefined ? legacy : null;
	}
	return null;
}

export function deletePropProgressNode(forest: LumberJackForest, nodeId: string): boolean {
	const encodedKey = encodeEntitySegment(nodeId);
	return forest.deleteNode(`learner/progress/${encodedKey}`);
}

export function updatePropProgressNode(forest: LumberJackForest, nodeId: string, progress: PropProgress): void {
	const encodedKey = encodeEntitySegment(nodeId);
	const prev = readPropProgressNode(forest, nodeId) ?? {};
	const merged: PropProgress = { ...prev };
	if (progress.mastery !== undefined) merged.mastery = progress.mastery;
	if (progress.fsrs !== undefined) merged.fsrs = progress.fsrs;
	forest.upsertNode({
		path: `learner/progress/${encodedKey}`,
		type: "leaf",
		kind: "proposition_progress",
		metadata: { nodeId, ...merged },
		slot: { nodeId, ...merged },
	});
	const propPath = `knowledge/propositions/${encodedKey}`;
	const existingProp = forest.getNode(propPath);
	if (existingProp && (existingProp.metadata?.nodeId === undefined || existingProp.metadata.nodeId === nodeId)) {
		forest.upsertNode({
			path: propPath,
			type: "leaf",
			kind: "proposition",
			metadata: { nodeId, ...merged },
		});
	}
}

function upsertDeckNode(forest: LumberJackForest, deck: FlashcardDeckRecord): void {
	const propParents = deck.propositionIds.map((pid) => `knowledge/propositions/${encodeEntitySegment(pid)}`);
	forest.upsertNode({
		path: `learner/decks/${encodeEntitySegment(deck.id)}`,
		type: "leaf",
		kind: "deck",
		parent_paths: propParents,
		metadata: { deckId: deck.id, name: deck.name, cardCount: deck.cards.length },
		slot: deck,
	});
}

function listDeckNodes(forest: LumberJackForest): FlashcardDeckRecord[] {
	const out: FlashcardDeckRecord[] = [];
	for (const node of forest.listChildren("learner/decks")) {
		const slot = node.slot as FlashcardDeckRecord | undefined;
		if (slot && typeof slot.id === "string") out.push(slot);
	}
	return out;
}

export function buildLearnerStore(forest: LumberJackForest): LumberJackLearnerStore {
	return {
		readProfile: () => (forest.getNode("learner/profile")?.slot as LearnerProfileRecord | undefined) ?? null,
		writeProfile: (profile) => {
			forest.upsertNode({ path: "learner/profile", type: "leaf", kind: "learner_profile", slot: profile });
		},
		updatePropositionProgress: (nodeId, progress) => updatePropProgressNode(forest, nodeId, progress),
		readPropositionProgress: (nodeId) => readPropProgressNode(forest, nodeId),
		deletePropositionProgress: (nodeId) => deletePropProgressNode(forest, nodeId),
		upsertDeck: (deck) => upsertDeckNode(forest, deck),
		listDecks: () => listDeckNodes(forest),
	};
}
