package main

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/NeoTecDigital/LumberJack/core"
	"github.com/NeoTecDigital/LumberJack/embedded"
	"github.com/NeoTecDigital/LumberJack/extension"
	"github.com/NeoTecDigital/LumberJack/types"
)

func openTestPeerForest(t *testing.T) (*embedded.Handle, extension.Host) {
	t.Helper()
	cfg := embedded.Config{
		Organization: "peer",
		Process:      types.ProcessInfo{DatabasePath: t.TempDir(), Name: "state"},
	}
	handle, err := embedded.OpenWith(cfg, peerPrincipal, peerExtension{})
	if err != nil {
		t.Fatalf("embedded.OpenWith: %v", err)
	}
	t.Cleanup(func() { _ = handle.Close() })
	host := lookupHostByRootID(handle.Forest().ID)
	if host == nil {
		t.Fatal("peerExtension did not attach to host")
	}
	return handle, host
}

func mustExecOp(t *testing.T, host extension.Host, op string, body any) []byte {
	t.Helper()
	rawReq, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal %s: %v", op, err)
	}
	res, st, msg := dispatchPeerOp(host, op, rawReq)
	if st != stOK {
		t.Fatalf("op %s failed with status %d: %s", op, st, msg)
	}
	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal response %s: %v", op, err)
	}
	return encoded
}

func TestDeleteNodeUnlinksTreeParentAndMultiParents(t *testing.T) {
	_, host := openTestPeerForest(t)
	mustExecOp(t, host, "upsert_node", map[string]any{
		"path": "sessions/c1", "type": "leaf", "kind": "session",
	})
	mustExecOp(t, host, "batch_upsert_nodes", map[string]any{
		"nodes": []map[string]any{
			{"path": "plans/c1/p_a", "type": "leaf", "kind": "plan_node", "parent_paths": []string{"sessions/c1"}, "clear_parents": true},
			{"path": "plans/c1/p_b", "type": "leaf", "kind": "plan_node", "parent_paths": []string{"sessions/c1", "plans/c1/p_a"}, "clear_parents": true},
		},
	})
	mustExecOp(t, host, "delete_node", map[string]any{"path": "plans/c1/p_a"})
	childrenRaw := mustExecOp(t, host, "list_children", map[string]any{"path": "plans/c1"})
	var listed struct {
		Nodes []nodeSnapshot `json:"nodes"`
	}
	if err := json.Unmarshal(childrenRaw, &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Nodes) != 1 || listed.Nodes[0].Name != "p_b" {
		t.Fatalf("expected only p_b under plans/c1 after delete, got %+v", listed.Nodes)
	}
	if len(listed.Nodes[0].Parents) != 1 {
		t.Fatalf("expected p_b to drop deleted parent p_a, got parents=%+v", listed.Nodes[0].Parents)
	}
}

func TestCanonicalEventsAppendListDeleteAndCAbiInterop(t *testing.T) {
	handle, host := openTestPeerForest(t)
	mustExecOp(t, host, "upsert_node", map[string]any{
		"path": "sessions/chat_1", "type": "leaf", "kind": "session",
	})
	mustExecOp(t, host, "append_entries", map[string]any{
		"path":     "sessions/chat_1",
		"event_id": "main",
		"entries": []map[string]any{
			{"id": "m1", "rank": "00000000", "content": map[string]any{"role": "user", "text": "hi"}},
		},
	})
	// Interop: embedded Handle.AppendToEvent works on the ongoing event created by append_entries!
	if _, err := handle.AppendToEvent(embedded.AppendEventRequest{
		Path:    "sessions/chat_1",
		EventID: "main",
		Content: "native-c-abi-entry",
	}); err != nil {
		t.Fatalf("handle.AppendToEvent interop failed: %v", err)
	}
	cAbiEntries, err := handle.EventEntries(embedded.EventEntriesRequest{
		Path:    "sessions/chat_1",
		EventID: "main",
	})
	if err != nil || len(cAbiEntries) != 2 {
		t.Fatalf("handle.EventEntries want 2 entries, got %d (err=%v)", len(cAbiEntries), err)
	}
	mustExecOp(t, host, "append_entries", map[string]any{
		"path":      "sessions/chat_1",
		"event_id":  "side:th_1",
		"end_event": true,
		"entries": []map[string]any{
			{"id": "s1", "parent_id": "m1", "content": "side question"},
		},
	})
	eventsRaw := mustExecOp(t, host, "list_events", map[string]any{"path": "sessions/chat_1"})
	var evList struct {
		Events []eventSnapshot `json:"events"`
	}
	if err := json.Unmarshal(eventsRaw, &evList); err != nil {
		t.Fatal(err)
	}
	if len(evList.Events) != 2 {
		t.Fatalf("expected 2 events on sessions/chat_1, got %d", len(evList.Events))
	}
	mustExecOp(t, host, "delete_event", map[string]any{"path": "sessions/chat_1", "event_id": "side:th_1"})
}

func assertForestHasZeroAttachments(t *testing.T, host extension.Host) {
	t.Helper()
	_ = host.Read(func(tx extension.ReadTx) error {
		var check func(*core.Node)
		check = func(n *core.Node) {
			if len(n.Attachments) > 0 {
				t.Fatalf("node %s unexpectedly holds %d attachments", n.Name, len(n.Attachments))
			}
			for _, c := range n.Children {
				check(c)
			}
		}
		check(tx.Root())
		return nil
	})
}

func TestApplicationObjectsStoreLeavesZeroNodeAttachments(t *testing.T) {
	t.Setenv("LUMBERJACK_STORAGE_MODE", "")
	t.Setenv("CORRESPONDER_STORAGE_MODE", "")
	handle, host := openTestPeerForest(t)
	password := "peer-local-operator-pass-1234"
	secret := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if err := handle.ConfigureApplication("peer-operator", password, secret); err != nil {
		t.Fatalf("ConfigureApplication: %v", err)
	}
	loginBody, _ := json.Marshal(map[string]string{"username": "peer-operator", "password": password})
	loginResp, err := handle.ApplicationCall(embedded.ApplicationRequest{
		Method: "POST", Target: "/login", Headers: map[string]string{"Content-Type": "application/json"}, Body: loginBody,
	})
	if err != nil || loginResp.Status != 200 {
		t.Fatalf("/login failed: status=%d err=%v body=%s", loginResp.Status, err, loginResp.Body)
	}
	var loginTok struct{ SessionToken string `json:"session_token"` }
	_ = json.Unmarshal(loginResp.Body, &loginTok)
	imgBytes := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff}
	auth := map[string]string{"Authorization": "Bearer " + loginTok.SessionToken}
	putResp, err := handle.ApplicationCall(embedded.ApplicationRequest{
		Method: "POST", Target: "/objects", Headers: auth, Body: imgBytes,
	})
	if err != nil || putResp.Status != 200 {
		t.Fatalf("POST /objects failed: status=%d err=%v body=%s", putResp.Status, err, putResp.Body)
	}
	var receipt struct{ ID string `json:"id"` }
	_ = json.Unmarshal(putResp.Body, &receipt)
	getResp, err := handle.ApplicationCall(embedded.ApplicationRequest{
		Method: "GET", Target: "/objects/" + receipt.ID, Headers: auth,
	})
	if err != nil || getResp.Status != 200 || !bytes.Equal(getResp.Body, imgBytes) {
		t.Fatalf("GET /objects/%s mismatch: status=%d err=%v", receipt.ID, getResp.Status, err)
	}
	assertForestHasZeroAttachments(t, host)
}
