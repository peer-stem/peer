package main

/*
#include "lumberjack_peer.h"
*/
import "C"

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/NeoTecDigital/LumberJack/core"
	"github.com/NeoTecDigital/LumberJack/extension"
)

func handleGetNode(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
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
		return nil, C.LJ_INTERNAL, err.Error()
	}
	if !found {
		return map[string]any{"found": false}, C.LJ_OK, ""
	}
	return map[string]any{"found": true, "node": snap}, C.LJ_OK, ""
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

func handleListChildren(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
	}
	var nodes []nodeSnapshot
	err := host.Read(func(tx extension.ReadTx) error {
		nodes = collectChildSnapshots(tx, findBySegments(tx.Root(), req.Path), req.Path)
		return nil
	})
	if err != nil {
		return nil, C.LJ_INTERNAL, err.Error()
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
	return map[string]any{"nodes": nodes}, C.LJ_OK, ""
}

func handleDeleteNode(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
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
		return nil, C.LJ_INVALID, err.Error()
	}
	if deleted {
		host.Publish("peer_node_deleted", strings.Trim(req.Path, "/"))
	}
	return map[string]bool{"deleted": deleted}, C.LJ_OK, ""
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

func handleSetEntries(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		Path    string      `json:"path"`
		EventID string      `json:"event_id"`
		Entries []entryWire `json:"entries"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
	}
	op := extension.WriteOp{Key: "entries:" + req.Path, Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		node, txErr := ensurePathNode(tx.Root(), req.Path, false)
		if txErr != nil {
			return txErr
		}
		built := buildCoreEntries(req.Entries)
		assignNodeEntries(node, req.EventID, built)
		return nil
	})
	if err != nil {
		return nil, C.LJ_INVALID, err.Error()
	}
	return map[string]int{"count": len(req.Entries)}, C.LJ_OK, ""
}

func parseEntryTime(raw string, fallback time.Time) time.Time {
	if raw == "" {
		return fallback
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return fallback
	}
	return parsed
}

func buildCoreEntries(wires []entryWire) []core.Entry {
	out := make([]core.Entry, 0, len(wires))
	now := time.Now().UTC()
	for _, w := range wires {
		ts := parseEntryTime(w.Timestamp, now)
		id := w.ID
		if id == "" {
			id = core.GenerateEntryID()
		}
		out = append(out, core.Entry{
			ID:        id,
			ParentID:  w.ParentID,
			Rank:      w.Rank,
			Content:   w.Content,
			Metadata:  w.Metadata,
			UserID:    "peer-system",
			Timestamp: ts,
		})
	}
	return out
}

func assignNodeEntries(node *core.Node, eventID string, entries []core.Entry) {
	if eventID == "" {
		node.Entries = entries
		return
	}
	if node.Events == nil {
		node.Events = map[string]core.Event{}
	}
	ev, exists := node.Events[eventID]
	if !exists {
		now := time.Now().UTC()
		ev = core.Event{StartTime: &now, Status: core.EventStatus("active"), CreatedBy: "peer-system", CreatedAt: now}
	}
	ev.Entries = entries
	node.Events[eventID] = ev
}

func toEntryWires(src []core.Entry) []entryWire {
	wires := make([]entryWire, 0, len(src))
	for _, e := range src {
		wires = append(wires, entryWire{
			ID:        e.ID,
			ParentID:  e.ParentID,
			Rank:      e.Rank,
			Content:   e.Content,
			Metadata:  e.Metadata,
			Timestamp: e.Timestamp.UTC().Format(time.RFC3339Nano),
		})
	}
	return wires
}

func handleGetEntries(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		Path    string `json:"path"`
		EventID string `json:"event_id"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
	}
	wires := []entryWire{}
	err := host.Read(func(tx extension.ReadTx) error {
		node := findBySegments(tx.Root(), req.Path)
		if node == nil {
			return nil
		}
		src := node.Entries
		if req.EventID != "" {
			src = node.Events[req.EventID].Entries
		}
		wires = toEntryWires(src)
		return nil
	})
	if err != nil {
		return nil, C.LJ_INTERNAL, err.Error()
	}
	return map[string]any{"entries": wires}, C.LJ_OK, ""
}

func handleSetRootSlot(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
	}
	op := extension.WriteOp{Key: "root_slot", Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		return tx.SetSlot(tx.Root().ID, peerRootLedgers, req.Data)
	})
	if err != nil {
		return nil, C.LJ_INVALID, err.Error()
	}
	host.Publish("peer_ledgers_updated", "knowledge")
	return map[string]bool{"ok": true}, C.LJ_OK, ""
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

func handleGetRootSlot(host extension.Host) (any, C.lj_status_t, string) {
	var raw json.RawMessage
	err := host.Read(func(tx extension.ReadTx) error {
		raw = extractRootSlotBytes(tx)
		return nil
	})
	if err != nil {
		return nil, C.LJ_INTERNAL, err.Error()
	}
	return map[string]any{"data": raw}, C.LJ_OK, ""
}

func storeAttachmentInTx(tx extension.Tx, digest, name, mimeType string, data []byte) (bool, error) {
	objPath := "objects/" + digest[:2] + "/" + digest
	node, err := ensurePathNode(tx.Root(), objPath, false)
	if err != nil {
		return false, err
	}
	node.Kind = "object"
	if node.Attachments == nil {
		node.Attachments = map[string]core.Attachment{}
	}
	if _, has := node.Attachments[digest]; has {
		return true, nil
	}
	if name == "" {
		name = digest
	}
	node.Attachments[digest] = core.Attachment{
		ID:         digest,
		Name:       name,
		Type:       mimeType,
		Size:       int64(len(data)),
		Hash:       digest,
		Data:       data,
		UploadedBy: "peer-system",
		UploadedAt: time.Now().UTC(),
	}
	return false, nil
}

func handlePutObject(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		Name       string `json:"name"`
		MimeType   string `json:"mime_type"`
		DataBase64 string `json:"data_base64"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
	}
	data, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		return nil, C.LJ_INVALID, "invalid base64 payload"
	}
	if len(data) > maxObjectBytes {
		return nil, C.LJ_TOO_LARGE, "object exceeds 64 MiB limit"
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	existed := false
	op := extension.WriteOp{Key: "object:" + digest, Origin: "peer"}
	_, err = host.Change(context.Background(), op, func(tx extension.Tx) error {
		var txErr error
		existed, txErr = storeAttachmentInTx(tx, digest, req.Name, req.MimeType, data)
		return txErr
	})
	if err != nil {
		return nil, C.LJ_INTERNAL, err.Error()
	}
	res := map[string]any{
		"id": digest, "sha256": digest, "size": len(data), "mime_type": req.MimeType, "existed": existed,
	}
	return res, C.LJ_OK, ""
}

func handleGetObject(host extension.Host, payload json.RawMessage) (any, C.lj_status_t, string) {
	var req struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, C.LJ_CODEC, err.Error()
	}
	if len(req.ID) != 64 {
		return map[string]any{"found": false}, C.LJ_OK, ""
	}
	objPath := "objects/" + req.ID[:2] + "/" + req.ID
	var att core.Attachment
	found := false
	err := host.Read(func(tx extension.ReadTx) error {
		node := findBySegments(tx.Root(), objPath)
		if node == nil {
			return nil
		}
		a, ok := node.Attachments[req.ID]
		if !ok {
			return nil
		}
		att = a
		found = true
		return nil
	})
	if err != nil {
		return nil, C.LJ_INTERNAL, err.Error()
	}
	if !found {
		return map[string]any{"found": false}, C.LJ_OK, ""
	}
	return map[string]any{
		"found":       true,
		"id":          att.ID,
		"sha256":      att.Hash,
		"name":        att.Name,
		"mime_type":   att.Type,
		"size":        att.Size,
		"data_base64": base64.StdEncoding.EncodeToString(att.Data),
	}, C.LJ_OK, ""
}
