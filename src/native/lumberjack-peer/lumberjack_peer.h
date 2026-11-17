#ifndef LUMBERJACK_PEER_H
#define LUMBERJACK_PEER_H

#include "lumberjack.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Execute a JSON-encoded peer DAG/slot/object operation against an open forest handle.
 * Allocates *out on success or structured error; caller MUST free *out via ic_lj_application_free. */
lj_status_t ic_lj_peer_exec(lj_handle_t h, lj_cstr req, int64_t req_len, char **out, int64_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* LUMBERJACK_PEER_H */
