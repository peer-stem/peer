/**
 * Collapsible PlanTree SVG diagram dock (`[data-testid="plan-dock"]`, `C2a §1`, `§4.1`).
 * Uses `layoutPlanTree` + `fitPlanBoxTransform` from `'peer-engine'` and mounts the SVG
 * inside `createPanZoom` from `'peer-kit'` with zero view-owned `planOpen` state
 * and zero `innerHTML` writes.
 */
import { button, createLife, documentOf, el, textNode, uniqueId, writeText } from "cloudcanvas-lib/ui";
import { fitPlanBoxTransform, layoutPlanTree } from "peer-engine";
import { createPanZoom } from "peer-kit";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(doc, tag, attrs = {}) {
	const node = doc.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attrs)) {
		if (value !== undefined && value !== null) node.setAttribute(name, String(value));
	}
	return node;
}

function truncateNodeLabel(raw, maxLen = 28) {
	const str = String(raw ?? "").trim();
	if (str.length <= maxLen) return str;
	return `${str.slice(0, maxLen - 1)}…`;
}

function buildArrowDefs(doc, markerId) {
	const defs = svgEl(doc, "defs");
	const marker = svgEl(doc, "marker", {
		id: markerId,
		viewBox: "0 0 10 10",
		refX: "9",
		refY: "5",
		markerWidth: "6",
		markerHeight: "6",
		orient: "auto-start-reverse",
	});
	marker.append(svgEl(doc, "path", { d: "M 0 1 L 10 5 L 0 9 z", class: "peer-plan-arrow" }));
	defs.append(marker);
	return defs;
}

function buildEdgeElement(doc, edge, markerId) {
	const pts = Array.isArray(edge?.points) ? edge.points : [];
	if (pts.length < 2) return null;
	const pointsAttr = pts.map((p) => `${Number(p.x ?? 0).toFixed(1)},${Number(p.y ?? 0).toFixed(1)}`).join(" ");
	return svgEl(doc, "polyline", {
		class: "peer-plan-edge",
		points: pointsAttr,
		fill: "none",
		"marker-end": `url(#${markerId})`,
		"data-from": String(edge.from ?? ""),
		"data-to": String(edge.to ?? ""),
	});
}

function buildNodeGroup(doc, node) {
	const w = Math.max(40, Number(node.width ?? 140));
	const h = Math.max(24, Number(node.height ?? 36));
	const nx = Number(node.x ?? 0);
	const ny = Number(node.y ?? 0);
	const cx = nx + w / 2;
	const cy = ny + h / 2;
	const status = String(node.status || "upcoming");
	const group = svgEl(doc, "g", {
		class: "peer-plan-node",
		"data-peer-plan-node": String(node.id ?? ""),
		"data-status": status,
	});
	const rect = svgEl(doc, "rect", {
		x: nx.toFixed(1),
		y: ny.toFixed(1),
		width: w.toFixed(1),
		height: h.toFixed(1),
		rx: "8",
		ry: "8",
		class: "peer-plan-node-box",
	});
	const titleEl = svgEl(doc, "title");
	titleEl.append(doc.createTextNode(String(node.label ?? node.id ?? "")));
	const label = svgEl(doc, "text", {
		x: cx.toFixed(1),
		y: cy.toFixed(1),
		"text-anchor": "middle",
		"dominant-baseline": "central",
		class: "peer-plan-node-label",
	});
	label.append(doc.createTextNode(truncateNodeLabel(node.label ?? node.id)));
	group.append(titleEl, rect, label);
	return group;
}

function renderPlanSvg(doc, tree, markerId) {
	const layout = layoutPlanTree(tree);
	const pad = 16;
	const width = Math.max(160, Number(layout?.width ?? 320)) + pad * 2;
	const height = Math.max(72, Number(layout?.height ?? 100)) + pad * 2;
	const svg = svgEl(doc, "svg", {
		class: "peer-plan-svg",
		viewBox: `${-pad} ${-pad} ${width} ${height}`,
		width: String(width),
		height: String(height),
		role: "img",
		"aria-label": "Lesson plan dependency graph",
		"data-peer-plan-svg": "",
	});
	svg.append(buildArrowDefs(doc, markerId));
	const edgesGroup = svgEl(doc, "g", { class: "peer-plan-edges" });
	for (const edge of layout?.edges ?? []) {
		const poly = buildEdgeElement(doc, edge, markerId);
		if (poly) edgesGroup.append(poly);
	}
	const nodesGroup = svgEl(doc, "g", { class: "peer-plan-nodes" });
	for (const node of layout?.nodes ?? []) {
		nodesGroup.append(buildNodeGroup(doc, node));
	}
	svg.append(edgesGroup, nodesGroup);
	return { svg, bounds: { width, height } };
}

function buildPlanDockNodes(doc, life, callbacks) {
	const root = el(doc, "section", {
		className: "peer-plan-dock",
		attrs: { "data-testid": "plan-dock", hidden: true },
	});
	const head = el(doc, "div", { className: "peer-plan-dock-head" });
	const toggleBtn = button(doc, {
		className: "peer-plan-dock-toggle",
		label: "Lesson plan",
		signal: life.signal,
		onClick: () => callbacks.toggle(),
		attrs: { "data-peer-action": "toggle-plan", "aria-expanded": "true" },
	});
	const metaEl = el(doc, "span", { className: "peer-plan-dock-meta" });
	const metaText = textNode(doc, metaEl, "");
	const actions = el(doc, "div", { className: "peer-plan-dock-actions" });
	const resetBtn = button(doc, {
		className: "peer-plan-dock-reset",
		label: "Fit",
		signal: life.signal,
		onClick: () => callbacks.fit(),
		attrs: { "data-peer-action": "fit-plan" },
	});
	const expandBtn = button(doc, {
		className: "peer-plan-dock-expand",
		label: "Expand",
		signal: life.signal,
		onClick: () => callbacks.expand(),
		attrs: { "data-peer-action": "expand-plan", hidden: typeof callbacks.onExpand !== "function" },
	});
	actions.append(resetBtn, expandBtn);
	head.append(toggleBtn, metaEl, actions);
	const body = el(doc, "div", { className: "peer-plan-dock-body", attrs: { "data-peer-plan-body": "" } });
	const panZoom = createPanZoom(body, { minScale: 0.25, maxScale: 3 });
	root.append(head, body);
	return { root, toggleBtn, resetBtn, metaText, body, panZoom };
}

function computePlanSignature(tree) {
	if (!tree || !Array.isArray(tree.nodes) || tree.nodes.length === 0) return "";
	const nSig = tree.nodes.map((n) => `${n.id}:${n.title ?? n.label}:${n.status ?? ""}`).join("|");
	const eSig = (tree.edges ?? []).map((e) => `${e.from}->${e.to}`).join(",");
	return `${tree.version ?? 1}#${nSig}#${eSig}`;
}

function unpackPlanInput(input) {
	if (input && typeof input === "object" && !Array.isArray(input.nodes) && ("tree" in input || "open" in input)) {
		return { tree: input.tree ?? null, open: input.open };
	}
	return { tree: input ?? null, open: undefined };
}

function fitInlinePlan(state) {
	if (!state.bounds) {
		state.nodes.panZoom.reset();
		return;
	}
	const vw = state.nodes.panZoom.root.clientWidth;
	const vh = state.nodes.panZoom.root.clientHeight;
	if (vw > 0 && vh > 0) {
		const fitted = fitPlanBoxTransform(state.bounds, { width: vw, height: vh }, 8);
		state.nodes.panZoom.setTransform({ x: fitted.x, y: fitted.y, k: fitted.k });
		return;
	}
	state.nodes.panZoom.reset();
}

function applyPlanDockUpdate(doc, state, markerId, syncOpen, input) {
	const { tree: planTree, open } = unpackPlanInput(input);
	state.controlledOpen = open;
	const sig = computePlanSignature(planTree);
	if (!sig) {
		state.sig = "";
		state.svgNode = null;
		state.bounds = null;
		state.nodes.root.hidden = true;
		state.nodes.panZoom.stage.replaceChildren();
		return;
	}
	state.nodes.root.hidden = false;
	const doneCount = planTree.nodes.filter((n) => n.status === "visited").length;
	const currentNode = planTree.nodes.find((n) => n.status === "current");
	const currentSuffix = currentNode ? ` · Current: ${currentNode.title ?? currentNode.label}` : "";
	writeText(state.nodes.metaText, `${doneCount}/${planTree.nodes.length} visited${currentSuffix}`);
	if (sig !== state.sig) {
		state.sig = sig;
		const rendered = renderPlanSvg(doc, planTree, markerId);
		state.svgNode = rendered.svg;
		state.bounds = rendered.bounds;
		state.nodes.panZoom.update({ content: state.svgNode, transform: { x: 0, y: 0, k: 1 } });
	}
	syncOpen();
}

export function createPlanDock(host, { onExpand, onToggle } = {}) {
	const doc = documentOf(host);
	const life = createLife();
	const markerId = uniqueId("peer-plan-arrow");
	const state = { controlledOpen: undefined, fallbackOpen: true, sig: "", svgNode: null, bounds: null, nodes: null };

	const resolveOpen = () => (state.controlledOpen !== undefined ? Boolean(state.controlledOpen) : state.fallbackOpen);
	const syncOpen = () => {
		const isOpen = resolveOpen();
		state.nodes.body.hidden = !isOpen;
		state.nodes.resetBtn.hidden = !isOpen;
		state.nodes.toggleBtn.setAttribute("aria-expanded", String(isOpen));
	};

	const handleToggle = () => {
		onToggle?.();
		if (state.controlledOpen === undefined && typeof onToggle !== "function") {
			state.fallbackOpen = !state.fallbackOpen;
			syncOpen();
		}
	};
	const handleExpand = () => {
		if (state.svgNode && typeof onExpand === "function") {
			onExpand({ kind: "svg", title: "Lesson plan", svg: state.svgNode.outerHTML });
		}
	};
	state.nodes = buildPlanDockNodes(doc, life, {
		onExpand,
		toggle: handleToggle,
		fit: () => fitInlinePlan(state),
		expand: handleExpand,
	});
	host.append(state.nodes.root);

	return {
		update: (input) => {
			if (!life.dead) applyPlanDockUpdate(doc, state, markerId, syncOpen, input);
		},
		destroy: () => {
			if (!life.destroy()) return;
			state.nodes.panZoom.destroy();
			state.nodes.root.remove();
		},
	};
}
