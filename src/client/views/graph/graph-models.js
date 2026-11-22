/**
 * Pure, DOM-free view-model derivations for the Home screen, `peer-graph` stage,
 * folder-filter visibility, proposition detail card, and reasoning chains table.
 */
import {
  CLUSTER_LIGHTNESS,
  DEFAULT_RENDER_SETTINGS,
  deriveCanvasData,
  fuzzyScore,
  graphFolderIds,
  graphFolderVisibleIds,
  isImpNodeId,
  placementOf
} from 'peer-engine';

export const FALLBACK_RENDER_SETTINGS = DEFAULT_RENDER_SETTINGS;

const DEFAULT_THEME_COLORS = Object.freeze({
  node: '#8d8d8d', edge: '#8d8d8d', label: '#8d8d8d', hoverText: '#e6e6e6'
});

export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const propositions = Array.isArray(raw.propositions)
    ? raw.propositions
    : nodes.filter((node) => node && !isImpNodeId(String(node.id ?? '')));
  return {
    nodes,
    propositions,
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    logicalEdges: Array.isArray(raw.logicalEdges) ? raw.logicalEdges : [],
    impLinks: Array.isArray(raw.impLinks) ? raw.impLinks : [],
    chains: Array.isArray(raw.chains) ? raw.chains : [],
    sessions: raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {},
    fileSources: raw.fileSources && typeof raw.fileSources === 'object' ? raw.fileSources : {},
    nodeSessions: raw.nodeSessions && typeof raw.nodeSessions === 'object' ? raw.nodeSessions : {},
    clusters: Array.isArray(raw.clusters) ? raw.clusters : [],
    positions: raw.positions && typeof raw.positions === 'object' ? raw.positions : undefined,
    learnerProgress: raw.learnerProgress && typeof raw.learnerProgress === 'object' ? raw.learnerProgress : undefined
  };
}

export function isNodeMatchingQuery(node, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const name = String(node?.name ?? '').toLowerCase();
  const statement = String(node?.statement ?? '').toLowerCase();
  if (name.includes(q) || statement.includes(q)) return true;
  const aliases = Array.isArray(node?.aliases) ? node.aliases : [];
  if (aliases.some((alias) => String(alias).toLowerCase().includes(q))) return true;
  return fuzzyScore(q, String(node?.name ?? ''), String(node?.statement ?? ''), ...aliases.map(String)) !== null;
}

export function formatMasteryPercent(mastery) {
  if (typeof mastery !== 'number' || !Number.isFinite(mastery)) return null;
  const rawPct = mastery <= 1 && mastery >= 0 ? mastery * 100 : mastery;
  const clamped = Math.max(0, Math.min(100, Math.round(rawPct)));
  return `${clamped}%`;
}

export function formatFsrsNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

export function formatFsrsDue(due) {
  if (typeof due === 'number' && Number.isFinite(due)) {
    return new Date(due).toISOString().slice(0, 10);
  }
  if (typeof due === 'string' && due.trim() !== '') {
    return due.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : due;
  }
  return '—';
}

export function formatProvenanceHref(chatId, messageId) {
  const base = `/chat/${encodeURIComponent(String(chatId))}`;
  const msg = String(messageId ?? '').trim();
  return msg ? `${base}#msg-${encodeURIComponent(msg)}` : base;
}

function formatChainArrowLine(premises, conclusionId, nameById) {
  const conclName = nameById.get(conclusionId) ?? conclusionId;
  if (!Array.isArray(premises) || premises.length === 0) return conclName;
  const premiseText = premises.map((id) => nameById.get(id) ?? id).join(', ');
  return `${premiseText} -> ${conclName}`;
}

function collectNodeSourcesMap(snapshot) {
  const nodeSources = {};
  const graphSourceIds = new Set();
  for (const prop of snapshot.propositions) {
    const ids = new Set();
    const pts = Array.isArray(prop.provenance) ? prop.provenance : [];
    for (const pt of pts) {
      const chatId = String(pt?.chatId ?? '').trim();
      if (chatId) { ids.add(chatId); graphSourceIds.add(chatId); }
    }
    const extra = Array.isArray(snapshot.nodeSessions?.[prop.id]) ? snapshot.nodeSessions[prop.id] : [];
    for (const raw of extra) {
      const chatId = String(raw ?? '').trim();
      if (chatId) { ids.add(chatId); graphSourceIds.add(chatId); }
    }
    nodeSources[prop.id] = [...ids];
  }
  return { nodeSources, graphSourceIds };
}

function deriveProvenanceEntries(node, snapshot) {
  const seen = new Map();
  const points = Array.isArray(node.provenance) ? node.provenance : [];
  for (const pt of points) {
    const chatId = String(pt?.chatId ?? '').trim();
    if (!chatId) continue;
    const msgId = String(pt?.messageId ?? '').trim();
    const prev = seen.get(chatId);
    if (prev === undefined || (prev === '' && msgId !== '')) seen.set(chatId, msgId);
  }
  const extraIds = Array.isArray(snapshot.nodeSessions?.[node.id]) ? snapshot.nodeSessions[node.id] : [];
  for (const id of extraIds) {
    const clean = String(id ?? '').trim();
    if (clean && !seen.has(clean)) seen.set(clean, '');
  }
  const entries = [];
  for (const [sourceId, messageId] of seen) {
    if (snapshot.fileSources[sourceId] !== undefined) {
      entries.push({ kind: 'file', sourceId, label: String(snapshot.fileSources[sourceId]), href: null });
    } else {
      const label = snapshot.sessions[sourceId] ? String(snapshot.sessions[sourceId]) : sourceId;
      entries.push({ kind: 'session', sourceId, messageId, label, href: formatProvenanceHref(sourceId, messageId) });
    }
  }
  return entries;
}

function deriveFsrsView(fsrs) {
  if (!fsrs || typeof fsrs !== 'object') return null;
  return {
    stability: formatFsrsNumber(fsrs.stability),
    difficulty: formatFsrsNumber(fsrs.difficulty),
    reps: formatFsrsNumber(fsrs.reps),
    lapses: formatFsrsNumber(fsrs.lapses),
    due: formatFsrsDue(fsrs.due)
  };
}

export function deriveNodeCardModel(rawSnapshot, selectedNodeId) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const id = String(selectedNodeId ?? '').trim();
  if (!snapshot || !id || isImpNodeId(id)) return null;
  const node = snapshot.propositions.find((n) => n.id === id) ?? snapshot.nodes.find((n) => n.id === id);
  if (!node) return null;
  const nameById = new Map(snapshot.nodes.map((n) => [n.id, String(n.name ?? n.id)]));
  const relatedChains = snapshot.chains
    .filter((c) => c.conclusion === id || (Array.isArray(c.premises) && c.premises.includes(id)))
    .map((c) => ({
      id: String(c.id),
      premises: [...(c.premises ?? [])],
      conclusion: String(c.conclusion),
      line: formatChainArrowLine(c.premises, c.conclusion, nameById)
    }));
  const progress = snapshot.learnerProgress?.[id] ?? null;
  const masteryPct = formatMasteryPercent(progress?.mastery);
  return {
    id: String(node.id),
    name: String(node.name ?? node.id),
    statement: String(node.statement ?? ''),
    aliases: Array.isArray(node.aliases) ? node.aliases.map(String) : [],
    masteryPercent: masteryPct,
    masteryText: masteryPct ? `Mastery: ${masteryPct}` : null,
    fsrs: deriveFsrsView(progress?.fsrs),
    chains: relatedChains,
    provenance: deriveProvenanceEntries(node, snapshot)
  };
}

function sourceMetaFor(sourceId, snapshot, sourceRecordMap) {
  if (!sourceId) return { key: '__unattributed__', sourceId: null, kind: 'other', label: 'Unattributed', deletable: false };
  const dirEntry = sourceRecordMap.get(sourceId);
  if (dirEntry) {
    const kind = dirEntry.kind === 'notes' ? 'notes' : 'chat';
    return { key: sourceId, sourceId, kind, label: String(dirEntry.label ?? sourceId), deletable: true };
  }
  if (snapshot.fileSources[sourceId] !== undefined) {
    return { key: sourceId, sourceId, kind: 'notes', label: String(snapshot.fileSources[sourceId]), deletable: true };
  }
  const label = snapshot.sessions[sourceId] !== undefined ? String(snapshot.sessions[sourceId]) : sourceId;
  return { key: sourceId, sourceId, kind: 'chat', label, deletable: true };
}

function buildAllChainEntries(snapshot, nameById) {
  const covered = new Set();
  const list = [];
  for (const chain of snapshot.chains) {
    const premises = Array.isArray(chain.premises) ? chain.premises.map(String) : [];
    const conclusion = String(chain.conclusion ?? '');
    covered.add(conclusion);
    for (const p of premises) covered.add(p);
    const line = formatChainArrowLine(premises, conclusion, nameById);
    list.push({ id: String(chain.id), premises, conclusion, memberIds: [...premises, conclusion], line });
  }
  for (const prop of snapshot.propositions) {
    if (covered.has(prop.id)) continue;
    list.push({ id: `single:${prop.id}`, premises: [], conclusion: prop.id, memberIds: [prop.id], line: String(prop.name ?? prop.id) });
  }
  return list;
}

function buildSourceInventory(snapshot, sourcesDir) {
  const map = new Map();
  for (const [id, label] of Object.entries(snapshot.sessions)) {
    map.set(id, { id, kind: 'chat', label: String(label), createdAt: '' });
  }
  for (const [id, label] of Object.entries(snapshot.fileSources)) {
    map.set(id, { id, kind: 'notes', label: String(label), createdAt: '' });
  }
  const dirSources = Array.isArray(sourcesDir?.sources) ? sourcesDir.sources : [];
  for (const entry of dirSources) {
    if (!entry?.id || entry.chatKind === 'practice') continue;
    map.set(entry.id, {
      id: entry.id,
      kind: entry.kind === 'notes' ? 'notes' : 'chat',
      label: entry.label ?? map.get(entry.id)?.label ?? entry.id,
      createdAt: entry.createdAt ?? ''
    });
  }
  return map;
}

function matchesFolderAncestor(organization, sourceId, q) {
  if (!organization || !sourceId || !q) return false;
  let folderId = placementOf(organization, sourceId)?.folderId ?? null;
  const seen = new Set();
  while (folderId && !seen.has(folderId)) {
    seen.add(folderId);
    const folder = organization.folders?.find((f) => f.id === folderId);
    if (!folder) break;
    if (String(folder.name).toLowerCase().includes(q) || fuzzyScore(q, folder.name) !== null) return true;
    folderId = folder.parentId ?? null;
  }
  return false;
}

function appendEmptySources(groups, inventory, organization, query) {
  const q = query.trim().toLowerCase();
  for (const src of inventory.values()) {
    if (groups.has(src.id)) continue;
    const labelStr = String(src.label ?? src.id);
    if (q && !labelStr.toLowerCase().includes(q) && fuzzyScore(q, labelStr) === null && !matchesFolderAncestor(organization, src.id, q)) {
      continue;
    }
    groups.set(src.id, {
      key: src.id,
      sourceId: src.id,
      kind: src.kind,
      label: labelStr,
      deletable: true,
      chains: [],
      nodeIds: new Set(),
      propositionCount: 0,
      createdAt: src.createdAt ?? ''
    });
  }
}

function appendChainGroupEntry(groups, entry, ctx) {
  const conclNode = ctx.propById.get(entry.conclusion);
  const birthId = conclNode?.provenance?.[0]?.chatId ?? null;
  const meta = sourceMetaFor(birthId, ctx.snapshot, ctx.inventory);
  const matchesSource = ctx.qLower !== ''
    && (meta.label.toLowerCase().includes(ctx.qLower) || matchesFolderAncestor(ctx.organization, birthId, ctx.qLower));
  const matchesNode = entry.memberIds.some((id) => isNodeMatchingQuery(ctx.propById.get(id), ctx.query));
  if (ctx.qLower !== '' && !matchesSource && !matchesNode) return;
  if (!groups.has(meta.key)) groups.set(meta.key, { ...meta, chains: [], nodeIds: new Set() });
  const group = groups.get(meta.key);
  const members = entry.memberIds
    .map((id) => ctx.propById.get(id))
    .filter(Boolean)
    .map((p) => ({ id: p.id, name: String(p.name ?? p.id), statement: String(p.statement ?? ''), picked: ctx.pickedSet.has(p.id) }));
  for (const m of members) group.nodeIds.add(m.id);
  group.chains.push({ id: entry.id, line: entry.line, premises: entry.premises, conclusion: entry.conclusion, members });
}

export function deriveChainsTableModel(rawSnapshot, { searchQuery = '', pickedNodeIds = [], sourcesDir = null } = {}) {
  const snapshot = normalizeSnapshot(rawSnapshot) ?? normalizeSnapshot({ nodes: [] });
  const query = String(searchQuery ?? '');
  const qLower = query.trim().toLowerCase();
  const pickedSet = new Set(Array.isArray(pickedNodeIds) ? pickedNodeIds.map(String) : []);
  const propById = new Map(snapshot.propositions.map((p) => [p.id, p]));
  const nameById = new Map(snapshot.nodes.map((n) => [n.id, String(n.name ?? n.id)]));
  const organization = sourcesDir?.organization ?? null;
  const inventory = buildSourceInventory(snapshot, sourcesDir);
  const groups = new Map();
  const ctx = { snapshot, query, qLower, pickedSet, propById, organization, inventory };
  for (const entry of buildAllChainEntries(snapshot, nameById)) appendChainGroupEntry(groups, entry, ctx);
  appendEmptySources(groups, inventory, organization, query);
  const orderedGroups = [...groups.values()].map((g) => ({
    key: g.key, sourceId: g.sourceId, kind: g.kind, label: g.label, deletable: g.deletable,
    chains: g.chains, nodeIds: g.nodeIds ? [...g.nodeIds] : [],
    propositionCount: g.nodeIds ? g.nodeIds.size : g.propositionCount
  }));
  const pickedIds = [...pickedSet];
  const directory = organization ? { organization, sources: [...inventory.values()] } : null;
  return {
    searchQuery: query, totalPropositions: snapshot.propositions.length, totalChains: snapshot.chains.length,
    pickedIds, pickedNames: pickedIds.map((id) => nameById.get(id) ?? id),
    groups: orderedGroups, organization, directory
  };
}

function readFolderContext(homeModel, graph, snapshot) {
  const sourcesDir = homeModel?.sources ?? graph?.sources ?? homeModel?.sourceDirectory ?? graph?.sourceDirectory ?? null;
  const organization = sourcesDir?.organization ?? homeModel?.organization ?? graph?.organization ?? null;
  const rawSel = homeModel?.selectedFolderIds ?? homeModel?.folderFilterIds ?? graph?.selectedFolderIds ?? [];
  const selectedFolderIds = Array.isArray(rawSel) ? rawSel.map(String) : (rawSel instanceof Set ? [...rawSel].map(String) : []);
  if (!snapshot || !organization || !Array.isArray(organization.folders) || organization.folders.length === 0) {
    return { sourcesDir, organization, selectedFolderIds, listedIds: [], folderVisible: null };
  }
  const { nodeSources, graphSourceIds } = collectNodeSourcesMap(snapshot);
  const listed = graphFolderIds(organization, graphSourceIds);
  const folderVisible = selectedFolderIds.length > 0
    ? graphFolderVisibleIds({
      organization,
      selected: new Set(selectedFolderIds),
      listed,
      propositionIds: snapshot.propositions.map((p) => p.id),
      nodeSources,
      impLinks: snapshot.impLinks
    })
    : null;
  return { sourcesDir, organization, selectedFolderIds, listedIds: [...listed], folderVisible };
}

function computeCombinedVisibility(snapshot, query, folderVisible) {
  if (!snapshot || (!query && !folderVisible)) return null;
  const visible = new Set();
  for (const node of snapshot.nodes) {
    const inFolder = !folderVisible || folderVisible.has(node.id);
    const matchesSearch = !query || isImpNodeId(node.id) || isNodeMatchingQuery(node, query);
    if (inFolder && matchesSearch) visible.add(node.id);
  }
  for (const link of snapshot.impLinks) {
    const endpointsVisible = visible.has(link.conclusion) && link.premises.every((p) => visible.has(p));
    if (!endpointsVisible) visible.delete(link.id);
  }
  return visible;
}

export function deriveGraphStageModel(homeModel = {}) {
  const graph = homeModel?.graph ?? {};
  const snapshot = normalizeSnapshot(graph.snapshot ?? homeModel?.snapshot);
  const mode = homeModel?.mode === 'light' ? 'light' : 'dark';
  const rawColors = homeModel?.themeColors ?? DEFAULT_THEME_COLORS;
  const colors = {
    node: rawColors.node || DEFAULT_THEME_COLORS.node,
    edge: rawColors.edge || DEFAULT_THEME_COLORS.edge,
    label: rawColors.label || DEFAULT_THEME_COLORS.label,
    hoverText: rawColors.hoverText || DEFAULT_THEME_COLORS.hoverText,
    clusterLightness: CLUSTER_LIGHTNESS[mode] ?? CLUSTER_LIGHTNESS.dark
  };
  const fontFamily = String(homeModel?.fontFamily || 'sans-serif');
  const settings = graph.renderSettings ?? FALLBACK_RENDER_SETTINGS;
  const isEmpty = !snapshot || snapshot.nodes.length === 0;
  const positions = { ...(snapshot?.positions ?? {}), ...(graph.positions ?? {}) };
  const data = isEmpty ? null : deriveCanvasData(snapshot, colors, fontFamily, positions);
  const query = String(homeModel?.searchQuery ?? '').trim();
  const { folderVisible } = readFolderContext(homeModel, graph, snapshot);
  const visible = computeCombinedVisibility(snapshot, query, folderVisible);
  return { data, settings, visible, camera: homeModel?.camera ?? null, isEmpty };
}

export function deriveKnowledgeSummary(rawSnapshot) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  if (!snapshot) return { propositions: 0, chains: 0, sessions: 0, importedNotes: 0 };
  return {
    propositions: snapshot.propositions.length,
    chains: snapshot.chains.length,
    sessions: Object.keys(snapshot.sessions).length,
    importedNotes: Object.keys(snapshot.fileSources).length
  };
}

export function deriveHomeViewModel(raw = {}) {
  const model = raw && typeof raw === 'object' ? raw : {};
  const graph = model.graph && typeof model.graph === 'object' ? model.graph : {};
  const snapshot = normalizeSnapshot(graph.snapshot ?? model.snapshot);
  const graphEnabled = model.graphEnabled !== false;
  const viewTab = model.viewTab === 'chains' ? 'chains' : 'graph';
  const showGraph = graphEnabled && viewTab !== 'chains';
  const searchQuery = String(model.searchQuery ?? '');
  const pickedIds = Array.isArray(model.pickedNodeIds) ? model.pickedNodeIds.map(String) : [];
  const folderCtx = readFolderContext(model, graph, snapshot);
  return {
    configured: model.configured !== false,
    mode: model.mode === 'light' ? 'light' : 'dark',
    sessionMode: model.sessionMode === 'practice' ? 'practice' : 'teach',
    graphEnabled,
    minimalHome: !graphEnabled,
    viewTab,
    showGraph,
    title: String(model.title || (graphEnabled ? 'Knowledge Map' : 'Knowledge Base')),
    searchQuery,
    pickedIds,
    starting: Boolean(model.starting),
    startError: model.startError ? String(model.startError) : '',
    graphLoad: String(graph.load ?? 'ready'),
    graphError: graph.error ? String(graph.error) : null,
    hasModelFolderFilter: 'selectedFolderIds' in model || 'folderFilterIds' in model || 'selectedFolderIds' in graph,
    folderFilter: {
      organization: folderCtx.organization,
      listedIds: folderCtx.listedIds,
      selectedIds: folderCtx.selectedFolderIds
    },
    notes: {
      importing: Boolean(graph.importing),
      runs: Array.isArray(graph.runs) ? graph.runs : [],
      importResults: Array.isArray(graph.importResults) ? graph.importResults : [],
      costs: graph.costs ?? null,
      renderSettings: graph.renderSettings ?? FALLBACK_RENDER_SETTINGS
    },
    stage: deriveGraphStageModel(model),
    nodeCard: deriveNodeCardModel(snapshot, model.selectedNodeId),
    chainsTable: deriveChainsTableModel(snapshot, {
      searchQuery,
      pickedNodeIds: pickedIds,
      sourcesDir: folderCtx.sourcesDir ?? (folderCtx.organization ? { organization: folderCtx.organization, sources: [] } : null)
    }),
    summary: deriveKnowledgeSummary(snapshot)
  };
}
