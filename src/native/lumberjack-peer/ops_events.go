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

type entryWire struct {
	ID        string                 `json:"id"`
	ParentID  string                 `json:"parent_id,omitempty"`
	Rank      string                 `json:"rank,omitempty"`
	Content   interface{}            `json:"content"`
	Metadata  map[string]interface{} `json:"metadata,omitempty"`
	Timestamp string                 `json:"timestamp,omitempty"`
}

type eventSnapshot struct {
	EventID  string                 `json:"event_id"`
	Status   string                 `json:"status"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
	Entries  []entryWire            `json:"entries"`
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
			UserID:    peerPrincipal,
			Timestamp: ts,
		})
	}
	return out
}

func ensureLiveEvent(node *core.Node, eventID string, meta map[string]interface{}) core.Event {
	if node.Events == nil {
		node.Events = map[string]core.Event{}
	}
	ev, exists := node.Events[eventID]
	now := time.Now().UTC()
	if !exists {
		ev = core.Event{
			StartTime: &now,
			Status:    core.EventOngoing,
			CreatedBy: peerPrincipal,
			CreatedAt: now,
		}
	}
	if len(meta) > 0 {
		if ev.Metadata == nil {
			ev.Metadata = map[string]interface{}{}
		}
		for k, v := range meta {
			ev.Metadata[k] = v
		}
	}
	ev.ModifiedBy = peerPrincipal
	ev.ModifiedAt = now
	return ev
}

func assignNodeEntries(node *core.Node, eventID string, entries []core.Entry, meta map[string]interface{}) {
	if eventID == "" {
		node.Entries = entries
		return
	}
	ev := ensureLiveEvent(node, eventID, meta)
	ev.Entries = entries
	node.Events[eventID] = ev
}

func appendUniqueEntries(existing []core.Entry, incoming []core.Entry) ([]core.Entry, int) {
	seen := make(map[string]bool, len(existing))
	for _, e := range existing {
		if e.ID != "" {
			seen[e.ID] = true
		}
	}
	added := 0
	for _, item := range incoming {
		if item.ID != "" && seen[item.ID] {
			continue
		}
		if item.ID != "" {
			seen[item.ID] = true
		}
		existing = append(existing, item)
		added++
	}
	return existing, added
}

func handleSetEntries(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path          string                 `json:"path"`
		EventID       string                 `json:"event_id"`
		EventMetadata map[string]interface{} `json:"event_metadata,omitempty"`
		Entries       []entryWire            `json:"entries"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	op := extension.WriteOp{Key: "entries:" + req.Path, Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		node, txErr := ensurePathNode(tx.Root(), req.Path, false)
		if txErr != nil {
			return txErr
		}
		assignNodeEntries(node, req.EventID, buildCoreEntries(req.Entries), req.EventMetadata)
		return nil
	})
	if err != nil {
		return nil, stInvalid, err.Error()
	}
	host.Publish("peer_event_updated", strings.Trim(req.Path, "/"))
	return map[string]int{"count": len(req.Entries)}, stOK, ""
}

func handleAppendEntries(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path          string                 `json:"path"`
		EventID       string                 `json:"event_id"`
		EventMetadata map[string]interface{} `json:"event_metadata,omitempty"`
		EndEvent      bool                   `json:"end_event,omitempty"`
		Entries       []entryWire            `json:"entries"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	if strings.TrimSpace(req.EventID) == "" {
		return nil, stInvalid, "event_id is required"
	}
	added := 0
	op := extension.WriteOp{Key: "append:" + req.Path + ":" + req.EventID, Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		node, txErr := ensurePathNode(tx.Root(), req.Path, false)
		if txErr != nil {
			return txErr
		}
		ev := ensureLiveEvent(node, req.EventID, req.EventMetadata)
		ev.Entries, added = appendUniqueEntries(ev.Entries, buildCoreEntries(req.Entries))
		if req.EndEvent {
			now := time.Now().UTC()
			ev.EndTime = &now
			ev.Status = core.EventFinished
		}
		node.Events[req.EventID] = ev
		return nil
	})
	if err != nil {
		return nil, stInvalid, err.Error()
	}
	host.Publish("peer_event_updated", strings.Trim(req.Path, "/"))
	return map[string]int{"added": added}, stOK, ""
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

func handleGetEntries(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path    string `json:"path"`
		EventID string `json:"event_id"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
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
		return nil, stInternal, err.Error()
	}
	return map[string]any{"entries": wires}, stOK, ""
}

func handleListEvents(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	events := []eventSnapshot{}
	err := host.Read(func(tx extension.ReadTx) error {
		node := findBySegments(tx.Root(), req.Path)
		if node == nil {
			return nil
		}
		keys := make([]string, 0, len(node.Events))
		for id := range node.Events {
			keys = append(keys, id)
		}
		sort.Strings(keys)
		for _, id := range keys {
			ev := node.Events[id]
			events = append(events, eventSnapshot{
				EventID:  id,
				Status:   string(ev.Status),
				Metadata: ev.Metadata,
				Entries:  toEntryWires(ev.Entries),
			})
		}
		return nil
	})
	if err != nil {
		return nil, stInternal, err.Error()
	}
	return map[string]any{"events": events}, stOK, ""
}

func handleDeleteEvent(host extension.Host, payload json.RawMessage) (any, int, string) {
	var req struct {
		Path    string `json:"path"`
		EventID string `json:"event_id"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, stCodec, err.Error()
	}
	if _, err := cleanSegments(req.Path); err != nil || strings.TrimSpace(req.EventID) == "" {
		return nil, stInvalid, fmt.Sprintf("invalid path or event_id")
	}
	deleted := false
	op := extension.WriteOp{Key: "delete_event:" + req.Path + ":" + req.EventID, Origin: "peer"}
	_, err := host.Change(context.Background(), op, func(tx extension.Tx) error {
		node := findBySegments(tx.Root(), req.Path)
		if node == nil || node.Events == nil {
			return nil
		}
		if _, exists := node.Events[req.EventID]; exists {
			delete(node.Events, req.EventID)
			deleted = true
		}
		return nil
	})
	if err != nil {
		return nil, stInvalid, err.Error()
	}
	if deleted {
		host.Publish("peer_event_deleted", strings.Trim(req.Path, "/"))
	}
	return map[string]bool{"deleted": deleted}, stOK, ""
}
