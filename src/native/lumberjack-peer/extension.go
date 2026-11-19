package main

/*
#cgo CFLAGS: -I${SRCDIR} -I${SRCDIR}/../../../extern/lumberjack/ffi
#include <stdlib.h>
#include "lumberjack_peer.h"
*/
import "C"

import (
	"context"
	"encoding/json"
	"sync"
	"unsafe"

	"github.com/NeoTecDigital/LumberJack/extension"
	"github.com/NeoTecDigital/LumberJack/ffi/abi"
)

const (
	peerSlotKey     = "peer_record"
	peerRootLedgers = "peer_ledgers"
)

var (
	hostMu        sync.RWMutex
	hostsByRoot   = map[string]extension.Host{}
	hostsByHandle = map[uint64]extension.Host{}
)

type peerExtension struct{}

type peerInstance struct {
	rootID string
	host   extension.Host
}

func (peerExtension) Spec() extension.Spec {
	return extension.Spec{
		Name:        "peer",
		Persistence: extension.AnyPersistence,
		Slot: extension.SlotSpec{
			RootKeys: []extension.SlotKey{{Name: peerRootLedgers}},
			NodeKeys: []extension.SlotKey{{Name: peerSlotKey}},
		},
		PresentationMetadata: []string{"canvas"},
	}
}

func (peerExtension) Attach(host extension.Host) (extension.Instance, error) {
	var rootID string
	err := host.Read(func(tx extension.ReadTx) error {
		rootID = tx.Root().ID
		return nil
	})
	if err != nil {
		return nil, err
	}
	hostMu.Lock()
	hostsByRoot[rootID] = host
	hostMu.Unlock()
	return &peerInstance{rootID: rootID, host: host}, nil
}

func (inst *peerInstance) Close(context.Context) error {
	hostMu.Lock()
	delete(hostsByRoot, inst.rootID)
	for h, candidate := range hostsByHandle {
		if candidate == inst.host {
			delete(hostsByHandle, h)
		}
	}
	hostMu.Unlock()
	return nil
}

func lookupHostByRootID(rootID string) extension.Host {
	hostMu.RLock()
	defer hostMu.RUnlock()
	return hostsByRoot[rootID]
}

func dropCachedHandle(h uint64) {
	hostMu.Lock()
	delete(hostsByHandle, h)
	hostMu.Unlock()
}

func resolveHost(h uint64) (extension.Host, C.lj_status_t) {
	handle, open := abi.Lookup(h)
	if !open {
		dropCachedHandle(h)
		return nil, C.LJ_BAD_HANDLE
	}
	hostMu.RLock()
	cached := hostsByHandle[h]
	hostMu.RUnlock()
	if cached != nil {
		return cached, C.LJ_OK
	}
	rootID := handle.Forest().ID
	hostMu.Lock()
	host := hostsByRoot[rootID]
	if host != nil {
		hostsByHandle[h] = host
	}
	hostMu.Unlock()
	if host == nil {
		return nil, C.LJ_INTERNAL
	}
	return host, C.LJ_OK
}

type execEnvelope struct {
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

func writeResponse(out **C.char, outLen *C.int64_t, value any) C.lj_status_t {
	encoded, err := json.Marshal(value)
	if err != nil {
		return C.LJ_CODEC
	}
	*out = (*C.char)(C.CBytes(encoded))
	*outLen = C.int64_t(len(encoded))
	return C.LJ_OK
}

func writeError(out **C.char, outLen *C.int64_t, status C.lj_status_t, msg string) C.lj_status_t {
	_ = writeResponse(out, outLen, map[string]string{"error": msg})
	return status
}

//export ic_lj_peer_exec
func ic_lj_peer_exec(h C.lj_handle_t, req C.lj_cstr, reqLen C.int64_t, out **C.char, outLen *C.int64_t) (status C.lj_status_t) {
	defer func() {
		if r := recover(); r != nil {
			status = C.LJ_PANIC
		}
	}()
	if out == nil || outLen == nil || reqLen < 0 {
		return C.LJ_INVALID
	}
	if reqLen > C.LJ_MAX_IN_LEN {
		return C.LJ_TOO_LARGE
	}
	*out = nil
	*outLen = 0
	host, st := resolveHost(uint64(h))
	if st != C.LJ_OK {
		return st
	}
	raw := C.GoBytes(unsafe.Pointer(req), C.int(reqLen))
	var env execEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return C.LJ_CODEC
	}
	res, opSt, errMsg := dispatchPeerOp(host, env.Op, env.Payload)
	if opSt != stOK {
		return writeError(out, outLen, C.lj_status_t(opSt), errMsg)
	}
	return writeResponse(out, outLen, res)
}

func init() { abi.Register(peerExtension{}) }

func main() {}
