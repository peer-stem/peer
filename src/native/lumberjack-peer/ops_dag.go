package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/NeoTecDigital/LumberJack/core"
	"github.com/NeoTecDigital/LumberJack/extension"
)

const (
	stOK       = 0
	stInvalid  = 1
	stNotFound = 4
	stInternal = 7
	stCodec    = 12
)

const peerPrincipal = "system"

type upsertNodeInput struct {
	Path            string                 `json:"path"`
	Type            string                 `json:"type,omitempty"`
	Kind            string                 `json:"kind,omitempty"`
	Metadata        map[string]interface{} `json:"metadata,omitempty"`
	ReplaceMetadata bool                   `json:"replace_metadata,omitempty"`
	ParentPaths     []string               `json:"parent_paths,omitempty"`
	ClearParents    bool                   `json:"clear_parents,omitempty"`
	Slot            json.RawMessage        `json:"slot,omitempty"`
	ClearSlot       bool                   `json:"clear_slot,omitempty"`
}

type nodeSnapshot struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	Path       string                 `json:"path"`
	Type       string                 `json:"type"`
	Kind       string                 `json:"kind,omitempty"`
	Parents    map[string]string      `json:"parents"`
	ChildNames []string               `json:"child_names"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
	Slot       json.RawMessage        `json:"slot,omitempty"`
}

func dispatchPeerOp(host extension.Host, op string, payload json.RawMessage) (any, int, string) {
	switch op {
	case "upsert_node":
		return handleUpsertNode(host, payload)
	case "batch_upsert_nodes":
		return handleBatchUpsertNodes(host, payload)
	case "get_node":
		return handleGetNode(host, payload)
	case "list_children":
		return handleListChildren(host, payload)
	case "delete_node":
		return handleDeleteNode(host, payload)
	case "set_entries":
		return handleSetEntries(host, payload)
	case "append_entries":
		return handleAppendEntries(host, payload)
	case "get_entries":
		return handleGetEntries(host, payload)
	case "list_events":
		return handleListEvents(host, payload)
	case "delete_event":
		return handleDeleteEvent(host, payload)
	case "set_root_slot":
		return handleSetRootSlot(host, payload)
	case "get_root_slot":
		return handleGetRootSlot(host)
	default:
		return nil, stInvalid, "unknown peer op: " + op
	}
}

func cleanSegments(raw string) ([]string, error) {
	trimmed := strings.Trim(raw, "/")
	if trimmed == "" {
		return nil, fmt.Errorf("path must not be empty")
	}
	parts := strings.Split(trimmed, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, fmt.Errorf("invalid path segment in %q", raw)
		}
	}
	return parts, nil
}

func stepPathNode(cur *core.Node, part string, asBranch bool) (*core.Node, error) {
	if asBranch {
		return cur.AddBranchChild(part, peerPrincipal)
	}
	if existing := cur.ChildNamed(part); existing != nil {
		return existing, nil
	}
	return cur.AddChildNode(part, core.LeafNode, peerPrincipal)
}

func ensurePathNode(root *core.Node, rawPath string, wantBranch bool) (*core.Node, error) {
	parts, err := cleanSegments(rawPath)
	if err != nil {
		return nil, err
	}
	cur := root
	for i, part := range parts {
		asBranch := i < len(parts)-1 || wantBranch
		cur, err = stepPathNode(cur, part, asBranch)
		if err != nil {
			return nil, err
		}
	}
	return cur, nil
}

func findBySegments(root *core.Node, rawPath string) *core.Node {
	parts, err := cleanSegments(rawPath)
	if err != nil {
		return nil
	}
	cur := root
	for _, part := range parts {
		cur = cur.ChildNamed(part)
		if cur == nil {
			return nil
		}
	}
	return cur
}

func snapshotNode(tx extension.ReadTx, n *core.Node, pathStr string) nodeSnapshot {
	parents := map[string]string{}
	for k, v := range n.Parents {
		parents[k] = v
	}
	names := make([]string, 0, len(n.Children))
	for _, ch := range n.Children {
		names = append(names, ch.Name)
	}
	sort.Strings(names)
	var slotRaw json.RawMessage
	if val, ok := tx.Slot(n.ID, peerSlotKey); ok && val != nil {
		if b, castOK := val.(json.RawMessage); castOK {
			slotRaw = b
		}
	}
	nodeType := "leaf"
	if n.Type == core.BranchNode {
		nodeType = "branch"
	}
	return nodeSnapshot{
		ID:         n.ID,
		Name:       n.Name,
		Path:       pathStr,
		Type:       nodeType,
		Kind:       n.Kind,
		Parents:    parents,
		ChildNames: names,
		Metadata:   n.Metadata,
		Slot:       slotRaw,
	}
}

func validateUpsertInput(in upsertNodeInput) error {
	if _, err := cleanSegments(in.Path); err != nil {
		return err
	}
	if in.Type != "" && in.Type != "leaf" && in.Type != "branch" {
		return fmt.Errorf("invalid node type %q", in.Type)
	}
	for _, pPath := range in.ParentPaths {
		if _, err := cleanSegments(pPath); err != nil {
			return err
		}
	}
	if len(in.Slot) > 0 && !json.Valid(in.Slot) {
		return fmt.Errorf("invalid slot json for %q", in.Path)
	}
	return nil
}

func applyUpsertInTx(tx extension.Tx, in upsertNodeInput) (*core.Node, error) {
	if err := validateUpsertInput(in); err != nil {
		return nil, err
	}
	node, err := ensurePathNode(tx.Root(), in.Path, in.Type == "branch")
	if err != nil {
		return nil, err
	}
	if in.Kind != "" {
		node.Kind = in.Kind
	}
	applyMetadataOnNode(node, in.Metadata, in.ReplaceMetadata)
	if err := applyParentsOnNode(tx.Root(), node, in.ParentPaths, in.ClearParents); err != nil {
		return nil, err
	}
	if in.ClearSlot {
		tx.DeleteSlot(node.ID, peerSlotKey)
	} else if len(in.Slot) > 0 {
		if err := tx.SetSlot(node.ID, peerSlotKey, in.Slot); err != nil {
			return nil, err
		}
	}
	node.ModifiedAt = time.Now().UTC()
	return node, nil
}

func applyMetadataOnNode(node *core.Node, meta map[string]interface{}, replace bool) {
	if replace {
		node.Metadata = map[string]interface{}{}
	}
	if len(meta) == 0 {
		return
	}
	if node.Metadata == nil {
		node.Metadata = map[string]interface{}{}
	}
	for k, v := range meta {
		if v == nil {
			delete(node.Metadata, k)
		} else {
			node.Metadata[k] = v
		}
	}
}

func applyParentsOnNode(root *core.Node, node *core.Node, parentPaths []string, clearFirst bool) error {
	if clearFirst {
		node.Parents = map[string]string{}
	}
	for _, pPath := range parentPaths {
		parent, err := ensurePathNode(root, pPath, false)
		if err != nil {
			return err
		}
		if parent.Children == nil {
			parent.Children = map[string]*core.Node{}
		}
		node.AddParent(parent)
		parent.Children[node.ID] = node
	}
	return nil
}

func handleUpsertNode(host extension.Host, payload json.RawMessage) (any, int, string) {
	var in upsertNodeInput
	if err := json.Unmarshal(payload, &in); err != nil {
		return nil, stCodec, err.Error()
	}
	var snap nodeSnapshot
	op := extension.WriteOp{Key: "upsert:" + in.Path, Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		node, txErr := applyUpsertInTx(tx, in)
		if txErr != nil {
			return txErr
		}
		snap = snapshotNode(tx, node, strings.Trim(in.Path, "/"))
		return nil
	})
	if err != nil {
		return nil, stInvalid, err.Error()
	}
	host.Publish("peer_node_upserted", strings.Trim(in.Path, "/"))
	return snap, stOK, ""
}

func applyBatchInTx(tx extension.Tx, nodes []upsertNodeInput) error {
	for _, item := range nodes {
		if err := validateUpsertInput(item); err != nil {
			return err
		}
	}
	for _, item := range nodes {
		if _, err := applyUpsertInTx(tx, item); err != nil {
			return err
		}
	}
	return nil
}

func handleBatchUpsertNodes(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Nodes []upsertNodeInput `json:"nodes"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	op := extension.WriteOp{Key: "batch_upsert", Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		return applyBatchInTx(tx, req.Nodes)
	})
	if err != nil {
		return nil, stInvalid, err.Error()
	}
	host.Publish("peer_batch_upserted", "knowledge")
	return map[string]int{"count": len(req.Nodes)}, stOK, ""
}
