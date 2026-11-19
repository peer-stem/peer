package main

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/NeoTecDigital/LumberJack/core"
	"github.com/NeoTecDigital/LumberJack/extension"
)

func handleGetNode(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	var found bool
	var snap nodeSnapshot
	err := host.Read(func(tx extension.ReadTx) error {
		node := findBySegments(tx.Root(), req.Path)
		if node == nil {
			return nil
		}
		found = true
		snap = snapshotNode(tx, node, strings.Trim(req.Path, "/"))
		return nil
	})
	if err != nil {
		return nil, stInternal, err.Error()
	}
	if !found {
		return map[string]any{"found": false}, stOK, ""
	}
	return map[string]any{"found": true, "node": snap}, stOK, ""
}

func collectChildSnapshots(tx extension.ReadTx, parent *core.Node, rawPath string) []nodeSnapshot {
	if parent == nil {
		return []nodeSnapshot{}
	}
	prefix := strings.Trim(rawPath, "/")
	seen := map[string]bool{}
	out := make([]nodeSnapshot, 0, len(parent.Children))
	for _, child := range parent.Children {
		if !seen[child.ID] {
			seen[child.ID] = true
			out = append(out, snapshotNode(tx, child, prefix+"/"+child.Name))
		}
	}
	return out
}

func handleListChildren(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	var nodes []nodeSnapshot
	err := host.Read(func(tx extension.ReadTx) error {
		nodes = collectChildSnapshots(tx, findBySegments(tx.Root(), req.Path), req.Path)
		return nil
	})
	if err != nil {
		return nil, stInternal, err.Error()
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
	return map[string]any{"nodes": nodes}, stOK, ""
}

func handleDeleteNode(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	deleted := false
	op := extension.WriteOp{Key: "delete:" + req.Path, Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		target := findBySegments(tx.Root(), req.Path)
		if target == nil {
			return nil
		}
		deleted = true
		unlinkNodeRelatives(tx, req.Path, target)
		tx.DeleteSlot(target.ID, peerSlotKey)
		return nil
	})
	if err != nil {
		return nil, stInvalid, err.Error()
	}
	if deleted {
		host.Publish("peer_node_deleted", strings.Trim(req.Path, "/"))
	}
	return map[string]bool{"deleted": deleted}, stOK, ""
}

func unlinkTreeParent(root *core.Node, rawPath, targetID string) {
	parts, err := cleanSegments(rawPath)
	if err != nil || len(parts) <= 1 {
		return
	}
	treeParent := findBySegments(root, strings.Join(parts[:len(parts)-1], "/"))
	if treeParent != nil {
		delete(treeParent.Children, targetID)
	}
}

func unlinkNodeRelatives(tx extension.Tx, rawPath string, target *core.Node) {
	for parentID := range target.Parents {
		if p, ok := tx.NodeByID(parentID); ok && p != nil {
			delete(p.Children, target.ID)
		}
	}
	unlinkTreeParent(tx.Root(), rawPath, target.ID)
	for childID, child := range target.Children {
		if child != nil {
			delete(child.Parents, target.ID)
		}
		if resolved, ok := tx.NodeByID(childID); ok && resolved != nil {
			delete(resolved.Parents, target.ID)
		}
	}
	delete(tx.Root().Children, target.ID)
	target.Parents = map[string]string{}
	target.Children = map[string]*core.Node{}
}

func handleSetRootSlot(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	op := extension.WriteOp{Key: "root_slot", Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		return tx.SetSlot(tx.Root().ID, peerRootLedgers, req.Data)
	})
	if err != nil {
		return nil, stInvalid, err.Error()
	}
	host.Publish("peer_ledgers_updated", "knowledge")
	return map[string]bool{"ok": true}, stOK, ""
}

func extractRootSlotBytes(tx extension.ReadTx) json.RawMessage {
	val, ok := tx.Slot(tx.Root().ID, peerRootLedgers)
	if !ok || val == nil {
		return nil
	}
	b, castOK := val.(json.RawMessage)
	if !castOK {
		return nil
	}
	return b
}

func handleGetRootSlot(host extension.Host) (any, int, string) {
	var raw json.RawMessage
	err := host.Read(func(tx extension.ReadTx) error {
		raw = extractRootSlotBytes(tx)
		return nil
	})
	if err != nil {
		return nil, stInternal, err.Error()
	}
	return map[string]any{"data": raw}, stOK, ""
}
