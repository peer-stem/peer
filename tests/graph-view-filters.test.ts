/**
 * Legend/filters predicate tests — isNodeVisible (src/client/engine) +
 * graphFolderVisibleIds + deriveView (src/core).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNodeVisible } from "../src/client/engine/index.ts";
import { deriveView } from "../src/core/graph.ts";
import { graphFolderVisibleIds, type GraphNode, type SourceOrganization } from "../src/core/index.ts";

const node = {
	name: "Money multiplier",
	statement: "The maximum ratio of broad money a bank can create from each unit of base money.",
};

describe("isNodeVisible (search predicate)", () => {
	it("is visible with an empty query", () => {
		assert.equal(isNodeVisible(node, ""), true);
	});

	it("search matches the statement case-insensitively", () => {
		assert.equal(isNodeVisible(node, "MONEY multiplier"), true);
	});

	it("search matches the statement when the name does not", () => {
		assert.equal(isNodeVisible(node, "MAXIMUM ratio"), true);
		assert.equal(isNodeVisible(node, " velocity"), false);
	});

	it("search matches the name when the statement does not", () => {
		assert.equal(isNodeVisible(node, "money MULTIPLIER"), true);
		assert.equal(isNodeVisible(node, " banking"), false);
	});

	it("whitespace-only query is no filter", () => {
		assert.equal(isNodeVisible(node, "   "), true);
	});
});

it("folder scope resolves visible proposition and implication ids cleanly", () => {
	const prop = (id: string, name: string): GraphNode => ({
		id,
		name,
		statement: name,
		aliases: [],
		createdAt: "now",
		provenance: [],
	});
	const propositions = [prop("p1", "Physics premise"), prop("p2", "Physics evidence"), prop("c", "Physics outcome")];
	const view = deriveView({
		nodes: propositions,
		chains: [{ id: "arg_test", premises: ["p1", "p2"], conclusion: "c", createdAt: "now", provenance: [] }],
	});
	const organization: SourceOrganization = {
		version: 1,
		folders: [{ id: "f", name: "Folder", parentId: null, createdAt: "now" }],
		placements: { chat: { folderId: "f" } },
	};
	const folder = graphFolderVisibleIds({
		organization,
		selected: new Set(["f"]),
		listed: new Set(["f"]),
		propositionIds: ["p1", "p2", "c"],
		nodeSources: { p1: ["chat"], p2: ["chat"], c: ["chat"] },
		impLinks: view.impLinks,
	});
	assert.ok(folder);
	assert.deepEqual([...folder].sort(), ["arg_test", "c", "p1", "p2"]);
});
