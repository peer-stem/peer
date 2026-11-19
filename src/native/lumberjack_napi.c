#define NAPI_VERSION 8
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lumberjack_peer.h"

typedef lj_status_t (*lj_yaml_op_fn)(
	lj_handle_t h,
	lj_cstr req,
	int64_t req_len,
	char *out,
	int64_t out_cap,
	int64_t *out_len
);

static napi_value throw_lj_error(napi_env env, lj_status_t status, const char *detail) {
	char msg[512];
	snprintf(msg, sizeof msg, "LumberJack status %d: %s", (int)status, detail ? detail : "failed");
	napi_value code_val, msg_val, err_obj, status_num;
	napi_create_string_utf8(env, "LUMBERJACK_ERROR", NAPI_AUTO_LENGTH, &code_val);
	napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &msg_val);
	napi_create_error(env, code_val, msg_val, &err_obj);
	napi_create_int32(env, (int32_t)status, &status_num);
	napi_set_named_property(env, err_obj, "ljStatus", status_num);
	napi_throw(env, err_obj);
	return NULL;
}

static char *read_utf8_arg(napi_env env, napi_value val, size_t *out_len) {
	size_t len = 0;
	if (napi_get_value_string_utf8(env, val, NULL, 0, &len) != napi_ok) {
		napi_throw_type_error(env, NULL, "Expected string argument");
		return NULL;
	}
	char *buf = (char *)malloc(len + 1);
	if (!buf) {
		napi_throw_error(env, NULL, "Out of memory");
		return NULL;
	}
	napi_get_value_string_utf8(env, val, buf, len + 1, &len);
	*out_len = len;
	return buf;
}

static bool read_handle_arg(napi_env env, napi_value val, lj_handle_t *out_h) {
	bool lossless = false;
	if (napi_get_value_bigint_uint64(env, val, out_h, &lossless) != napi_ok) {
		napi_throw_type_error(env, NULL, "Expected BigInt handle");
		return false;
	}
	return true;
}

static napi_value make_undefined(napi_env env) {
	napi_value undef;
	napi_get_undefined(env, &undef);
	return undef;
}

static napi_value finish_owned_string(
	napi_env env,
	lj_status_t st,
	char *out_ptr,
	int64_t out_len,
	const char *op_name
) {
	if (st != LJ_OK) {
		char detail[256];
		snprintf(detail, sizeof detail, "%s", op_name);
		if (out_ptr && out_len > 0) {
			size_t copy = (size_t)out_len < sizeof(detail) - 1 ? (size_t)out_len : sizeof(detail) - 1;
			memcpy(detail, out_ptr, copy);
			detail[copy] = '\0';
		}
		if (out_ptr) ic_lj_application_free(out_ptr);
		return throw_lj_error(env, st, detail);
	}
	napi_value res;
	napi_create_string_utf8(env, out_ptr ? out_ptr : "{}", (size_t)out_len, &res);
	if (out_ptr) ic_lj_application_free(out_ptr);
	return res;
}

static napi_value call_yaml_op(
	napi_env env,
	napi_callback_info info,
	lj_yaml_op_fn fn,
	bool allow_retry,
	const char *op_name
) {
	size_t argc = 2;
	napi_value argv[2];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	lj_handle_t h = 0;
	if (!read_handle_arg(env, argv[0], &h)) return NULL;
	size_t req_len = 0;
	char *req = read_utf8_arg(env, argv[1], &req_len);
	if (!req) return NULL;
	int64_t cap = 65536;
	char *buf = (char *)malloc((size_t)cap);
	int64_t out_len = 0;
	lj_status_t st = fn(h, req, (int64_t)req_len, buf, cap, &out_len);
	if (allow_retry && st == LJ_TRUNCATED && out_len > cap) {
		free(buf);
		cap = out_len + 1024;
		buf = (char *)malloc((size_t)cap);
		st = fn(h, req, (int64_t)req_len, buf, cap, &out_len);
	}
	free(req);
	if (st != LJ_OK) {
		free(buf);
		return throw_lj_error(env, st, op_name);
	}
	napi_value yaml_val;
	napi_create_string_utf8(env, buf, (size_t)(out_len > 0 ? out_len : 0), &yaml_val);
	free(buf);
	return yaml_val;
}

static napi_value js_abi_version(napi_env env, napi_callback_info info) {
	(void)info;
	napi_value out;
	napi_create_uint32(env, ic_lj_abi_version(), &out);
	return out;
}

static napi_value js_open(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	size_t len = 0;
	char *req = read_utf8_arg(env, argv[0], &len);
	if (!req) return NULL;
	lj_handle_t h = 0;
	lj_status_t st = ic_lj_open(req, (int64_t)len, &h);
	free(req);
	if (st != LJ_OK) return throw_lj_error(env, st, "ic_lj_open");
	napi_value out;
	napi_create_bigint_uint64(env, h, &out);
	return out;
}

static napi_value js_adopt(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	size_t len = 0;
	char *req = read_utf8_arg(env, argv[0], &len);
	if (!req) return NULL;
	lj_status_t st = ic_lj_adopt(req, (int64_t)len);
	free(req);
	if (st != LJ_OK) return throw_lj_error(env, st, "ic_lj_adopt");
	return make_undefined(env);
}

static napi_value js_close(napi_env env, napi_callback_info info) {
	size_t argc = 1;
	napi_value argv[1];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	lj_handle_t h = 0;
	if (!read_handle_arg(env, argv[0], &h)) return NULL;
	lj_status_t st = ic_lj_close(h);
	if (st != LJ_OK) return throw_lj_error(env, st, "ic_lj_close");
	return make_undefined(env);
}

static napi_value js_peer_exec(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	lj_handle_t h = 0;
	if (!read_handle_arg(env, argv[0], &h)) return NULL;
	size_t req_len = 0;
	char *req = read_utf8_arg(env, argv[1], &req_len);
	if (!req) return NULL;
	char *out_ptr = NULL;
	int64_t out_len = 0;
	lj_status_t st = ic_lj_peer_exec(h, req, (int64_t)req_len, &out_ptr, &out_len);
	free(req);
	return finish_owned_string(env, st, out_ptr, out_len, "ic_lj_peer_exec");
}

static napi_value js_app_configure(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	lj_handle_t h = 0;
	if (!read_handle_arg(env, argv[0], &h)) return NULL;
	size_t req_len = 0;
	char *req = read_utf8_arg(env, argv[1], &req_len);
	if (!req) return NULL;
	lj_status_t st = ic_lj_application_configure(h, req, (int64_t)req_len);
	free(req);
	if (st != LJ_OK) return throw_lj_error(env, st, "ic_lj_application_configure");
	return make_undefined(env);
}

static napi_value js_app_call(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	lj_handle_t h = 0;
	if (!read_handle_arg(env, argv[0], &h)) return NULL;
	size_t req_len = 0;
	char *req = read_utf8_arg(env, argv[1], &req_len);
	if (!req) return NULL;
	char *out_ptr = NULL;
	int64_t out_len = 0;
	lj_status_t st = ic_lj_application_call(h, req, (int64_t)req_len, &out_ptr, &out_len);
	free(req);
	return finish_owned_string(env, st, out_ptr, out_len, "ic_lj_application_call");
}

static napi_value js_event_start(napi_env env, napi_callback_info info) {
	return call_yaml_op(env, info, ic_lj_event_start, false, "ic_lj_event_start");
}

static napi_value js_event_append(napi_env env, napi_callback_info info) {
	return call_yaml_op(env, info, ic_lj_event_append, false, "ic_lj_event_append");
}

static napi_value js_event_end(napi_env env, napi_callback_info info) {
	return call_yaml_op(env, info, ic_lj_event_end, false, "ic_lj_event_end");
}

static napi_value js_event_entries(napi_env env, napi_callback_info info) {
	return call_yaml_op(env, info, ic_lj_event_entries, true, "ic_lj_event_entries");
}

static napi_value js_stream_poll(napi_env env, napi_callback_info info) {
	size_t argc = 2;
	napi_value argv[2];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
	lj_handle_t h = 0;
	if (!read_handle_arg(env, argv[0], &h)) return NULL;
	size_t req_len = 0;
	char *req = read_utf8_arg(env, argv[1], &req_len);
	if (!req) return NULL;
	int64_t cap = 65536;
	char *buf = (char *)malloc((size_t)cap);
	int64_t out_len = 0;
	lj_status_t st = ic_lj_stream_poll(h, req, (int64_t)req_len, buf, cap, &out_len);
	if (st == LJ_TRUNCATED && out_len > cap) {
		free(buf);
		cap = out_len + 1024;
		buf = (char *)malloc((size_t)cap);
		st = ic_lj_stream_poll(h, req, (int64_t)req_len, buf, cap, &out_len);
	}
	free(req);
	if (st != LJ_OK && st != LJ_GAP) {
		free(buf);
		return throw_lj_error(env, st, "ic_lj_stream_poll");
	}
	napi_value obj, st_val, yaml_val;
	napi_create_object(env, &obj);
	napi_create_int32(env, (int32_t)st, &st_val);
	napi_create_string_utf8(env, buf, (size_t)(out_len > 0 ? out_len : 0), &yaml_val);
	free(buf);
	napi_set_named_property(env, obj, "status", st_val);
	napi_set_named_property(env, obj, "yaml", yaml_val);
	return obj;
}

static napi_value init_addon(napi_env env, napi_value exports) {
	napi_property_descriptor props[] = {
		{"abiVersion", NULL, js_abi_version, NULL, NULL, NULL, napi_default, NULL},
		{"open", NULL, js_open, NULL, NULL, NULL, napi_default, NULL},
		{"adopt", NULL, js_adopt, NULL, NULL, NULL, napi_default, NULL},
		{"close", NULL, js_close, NULL, NULL, NULL, napi_default, NULL},
		{"peerExec", NULL, js_peer_exec, NULL, NULL, NULL, napi_default, NULL},
		{"applicationConfigure", NULL, js_app_configure, NULL, NULL, NULL, napi_default, NULL},
		{"applicationCall", NULL, js_app_call, NULL, NULL, NULL, napi_default, NULL},
		{"eventStart", NULL, js_event_start, NULL, NULL, NULL, napi_default, NULL},
		{"eventAppend", NULL, js_event_append, NULL, NULL, NULL, napi_default, NULL},
		{"eventEnd", NULL, js_event_end, NULL, NULL, NULL, napi_default, NULL},
		{"eventEntries", NULL, js_event_entries, NULL, NULL, NULL, napi_default, NULL},
		{"streamPoll", NULL, js_stream_poll, NULL, NULL, NULL, napi_default, NULL},
	};
	napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
	return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init_addon)
