import type { GraphChain, GraphNode, Position } from "../../core/contracts.ts";
import type { SourceOrganization } from "../../core/source-organization.ts";
import type { LumberJackForest, UpsertNodeInput } from "./binding.ts";
import { encodeEntitySegment, isPosition } from "./graph-guards.ts";
import { readPropProgressNode } from "./learner-store.ts";

function originParentPath(forest: LumberJackForest, chatOrSourceId: string): string | null {
	const clean = encodeEntitySegment(chatOrSourceId);
	if (forest.getNode(`knowledge/sources/${clean}`)) return `knowledge/sources/${clean}`;
	if (forest.getNode(`sessions/${clean}`)) return `sessions/${clean}`;
	return null;
}

export function buildPropositionUpsert(forest: LumberJackForest, node: GraphNode): UpsertNodeInput {
	const propPath = `knowledge/propositions/${encodeEntitySegment(node.id)}`;
	const existing = forest.getNode(propPath);
	const prevAliases = Array.isArray(existing?.metadata?.aliases) ? (existing.metadata.aliases as string[]) : [];
	const aliases = new Set<string>(prevAliases);
	for (const alias of node.aliases) aliases.add(alias);
	const parents: string[] = [];
	for (const pt of node.provenance) {
		const p = originParentPath(forest, pt.chatId);
		if (p) parents.push(p);
	}
	const progress = readPropProgressNode(forest, node.id);
	return {
		path: propPath,
		type: "leaf",
		kind: "proposition",
		parent_paths: parents,
		metadata: {
			nodeId: node.id,
			name: node.name,
			statement: node.statement,
			aliases: [...aliases],
			createdAt: (existing?.metadata?.createdAt as string | undefined) ?? node.createdAt,
			...(progress?.mastery !== undefined ? { mastery: progress.mastery } : {}),
			...(progress?.fsrs !== undefined ? { fsrs: progress.fsrs } : {}),
		},
	};
}

export function buildChainUpserts(assertion: GraphChain): UpsertNodeInput[] {
	const chainSeg = encodeEntitySegment(assertion.id);
	const chainPath = `knowledge/chains/${chainSeg}`;
	const premisePaths = assertion.premises.map((pid) => `knowledge/propositions/${encodeEntitySegment(pid)}`);
	const conclusionPath = `knowledge/propositions/${encodeEntitySegment(assertion.conclusion)}`;
	const chainMeta = {
		chainId: assertion.id,
		premises: assertion.premises,
		conclusion: assertion.conclusion,
		createdAt: assertion.createdAt,
	};
	return [
		{ path: chainPath, type: "leaf", kind: "chain", parent_paths: premisePaths, metadata: chainMeta, slot: assertion },
		{ path: conclusionPath, type: "leaf", kind: "proposition", parent_paths: [chainPath] },
	];
}

function extractCanvasPosition(meta?: Record<string, unknown>): Position | null {
	return isPosition(meta?.canvas) ? { x: meta.canvas.x, y: meta.canvas.y } : null;
}

export function readCanvasPositions(forest: LumberJackForest): Record<string, Position> {
	const out: Record<string, Position> = {};
	for (const snap of forest.listChildren("knowledge/propositions")) {
		const pos = extractCanvasPosition(snap.metadata);
		const nodeId = (snap.metadata?.nodeId as string | undefined) ?? snap.name;
		if (pos) out[nodeId] = pos;
	}
	return out;
}

export function writeCanvasPositions(forest: LumberJackForest, positions: Record<string, Position>): void {
	const activeProps = forest.listChildren("knowledge/propositions");
	const seen = new Set<string>();
	const batch: UpsertNodeInput[] = [];
	for (const snap of activeProps) {
		const nodeId = (snap.metadata?.nodeId as string | undefined) ?? snap.name;
		seen.add(nodeId);
		const nextPos = positions[nodeId];
		batch.push({
			path: snap.path,
			kind: "proposition",
			metadata: { canvas: isPosition(nextPos) ? { x: nextPos.x, y: nextPos.y } : null },
		});
	}
	for (const [nodeId, pos] of Object.entries(positions)) {
		if (seen.has(nodeId) || !isPosition(pos)) continue;
		batch.push({
			path: `knowledge/propositions/${encodeEntitySegment(nodeId)}`,
			type: "leaf",
			kind: "proposition",
			metadata: { nodeId, canvas: { x: pos.x, y: pos.y } },
		});
	}
	if (batch.length > 0) forest.batchUpsertNodes(batch);
}

export function rebuildGraphDag(
	forest: LumberJackForest,
	nodes: GraphNode[],
	chains: GraphChain[],
	keepPositions: Record<string, Position>,
): void {
	for (const existingChain of forest.listChildren("knowledge/chains")) {
		forest.deleteNode(existingChain.path);
	}
	const keepNodeSegs = new Set(nodes.map((n) => encodeEntitySegment(n.id)));
	for (const existingProp of forest.listChildren("knowledge/propositions")) {
		if (!keepNodeSegs.has(existingProp.name)) forest.deleteNode(existingProp.path);
	}
	const batch: UpsertNodeInput[] = [];
	for (const node of nodes) {
		const up = buildPropositionUpsert(forest, node);
		const pos = keepPositions[node.id];
		if (pos) up.metadata = { ...up.metadata, canvas: { x: pos.x, y: pos.y } };
		batch.push(up);
	}
	for (const chain of chains) batch.push(...buildChainUpserts(chain));
	if (batch.length > 0) forest.batchUpsertNodes(batch);
}

export function syncSourceFolderDag(forest: LumberJackForest, org: SourceOrganization): void {
	const batch: UpsertNodeInput[] = [];
	for (const folder of org.folders) {
		const parentPaths = folder.parentId ? [`knowledge/folders/${encodeEntitySegment(folder.parentId)}`] : [];
		batch.push({
			path: `knowledge/folders/${encodeEntitySegment(folder.id)}`,
			type: "branch",
			kind: "folder",
			parent_paths: parentPaths,
			clear_parents: true,
			metadata: { folderId: folder.id, name: folder.name },
		});
	}
	for (const [sourceId, placement] of Object.entries(org.placements ?? {})) {
		const folderId = (placement as { folderId?: string | null } | null)?.folderId;
		if (!folderId) continue;
		batch.push({
			path: `knowledge/sources/${encodeEntitySegment(sourceId)}`,
			type: "leaf",
			kind: "source",
			parent_paths: [`knowledge/folders/${encodeEntitySegment(folderId)}`],
		});
	}
	if (batch.length > 0) forest.batchUpsertNodes(batch);
}
