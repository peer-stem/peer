import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LJ_STATUS, type RawLumberJackAddon, type StoredObjectData, type StoredObjectReceipt } from "./binding.ts";

interface AppAuthCredentials {
	username: string;
	password: string;
	secret: string;
}

interface ApplicationCallWireResponse {
	status: number;
	headers?: Record<string, string>;
	body?: string;
}

export interface LumberJackObjectsClient {
	putObject(name: string, mimeType: string, dataBase64: string): StoredObjectReceipt;
	getObject(id: string): StoredObjectData;
}

const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const OBJECT_ID_RE = /^[0-9a-f]{64}$/;

function writePrivateCredsFile(filePath: string, creds: AppAuthCredentials): void {
	const tmpPath = `${filePath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
	const fd = fs.openSync(tmpPath, flags, 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, `${JSON.stringify(creds)}\n`, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmpPath, filePath);
}

function loadOrMintAppCredentials(forestDir: string): AppAuthCredentials {
	const filePath = path.join(forestDir, "peer-app-auth.json");
	if (fs.existsSync(filePath)) {
		const st = fs.lstatSync(filePath);
		if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) {
			throw new Error(`Unsafe LumberJack app credentials file: ${filePath}`);
		}
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<AppAuthCredentials>;
		if (
			typeof raw.username === "string" && raw.username.length > 0 &&
			typeof raw.password === "string" && raw.password.length >= 12 &&
			typeof raw.secret === "string" && raw.secret.length >= 32
		) {
			return { username: raw.username, password: raw.password, secret: raw.secret };
		}
	}
	const minted: AppAuthCredentials = {
		username: "peer-operator",
		password: randomBytes(24).toString("hex"),
		secret: randomBytes(32).toString("hex"),
	};
	writePrivateCredsFile(filePath, minted);
	return minted;
}

function decodeResponseBodyJson<T>(resp: ApplicationCallWireResponse): T {
	const raw = resp.body ? Buffer.from(resp.body, "base64").toString("utf8") : "{}";
	return JSON.parse(raw) as T;
}

interface ObjectsClientState {
	readonly addon: RawLumberJackAddon;
	readonly forestDir: string;
	readonly getActiveHandle: () => bigint;
	configured: boolean;
	creds: AppAuthCredentials | null;
	sessionToken: string | null;
}

function ensureAppConfigured(state: ObjectsClientState, handle: bigint): AppAuthCredentials {
	if (!state.creds) state.creds = loadOrMintAppCredentials(state.forestDir);
	if (!state.configured) {
		try {
			state.addon.applicationConfigure(handle, JSON.stringify(state.creds));
		} catch (err) {
			if ((err as { ljStatus?: number }).ljStatus !== LJ_STATUS.INVALID) throw err;
		}
		state.configured = true;
	}
	return state.creds;
}

function loginOperator(state: ObjectsClientState, handle: bigint, creds: AppAuthCredentials): string {
	const loginBody = Buffer.from(
		JSON.stringify({ username: creds.username, password: creds.password }),
		"utf8",
	).toString("base64");
	const raw = state.addon.applicationCall(
		handle,
		JSON.stringify({
			method: "POST",
			target: "/login",
			headers: { "Content-Type": "application/json" },
			body: loginBody,
		}),
	);
	const resp = JSON.parse(raw) as ApplicationCallWireResponse;
	if (resp.status !== 200) throw new Error(`LumberJack /login failed with HTTP ${resp.status}`);
	const parsed = decodeResponseBodyJson<{ session_token?: string }>(resp);
	if (!parsed.session_token) throw new Error("LumberJack /login returned no session_token");
	state.sessionToken = parsed.session_token;
	return parsed.session_token;
}

function callAuthenticatedApp(
	state: ObjectsClientState,
	method: string,
	target: string,
	bodyBase64?: string,
): ApplicationCallWireResponse {
	const handle = state.getActiveHandle();
	const creds = ensureAppConfigured(state, handle);
	const token = state.sessionToken ?? loginOperator(state, handle, creds);
	const sendOnce = (bearer: string): ApplicationCallWireResponse => {
		const raw = state.addon.applicationCall(
			handle,
			JSON.stringify({
				method,
				target,
				headers: { Authorization: `Bearer ${bearer}` },
				...(bodyBase64 !== undefined ? { body: bodyBase64 } : {}),
			}),
		);
		return JSON.parse(raw) as ApplicationCallWireResponse;
	};
	const first = sendOnce(token);
	return first.status !== 401 ? first : sendOnce(loginOperator(state, handle, creds));
}

function putApplicationObject(
	state: ObjectsClientState,
	name: string,
	mimeType: string,
	dataBase64: string,
): StoredObjectReceipt {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
		throw new Error("Invalid base64 object payload");
	}
	const decoded = Buffer.from(dataBase64, "base64");
	if (decoded.byteLength > MAX_OBJECT_BYTES) throw new Error("Object exceeds 64 MiB limit");
	const resp = callAuthenticatedApp(state, "POST", "/objects", decoded.toString("base64"));
	if (resp.status !== 200) throw new Error(`POST /objects failed with HTTP ${resp.status} for ${name}`);
	const receipt = decodeResponseBodyJson<{ id: string; size: number; existed: boolean }>(resp);
	return { id: receipt.id, size: receipt.size, mime_type: mimeType, existed: receipt.existed };
}

function getApplicationObject(state: ObjectsClientState, id: string): StoredObjectData {
	if (!OBJECT_ID_RE.test(id)) return { found: false };
	const resp = callAuthenticatedApp(state, "GET", `/objects/${id}`);
	if (resp.status === 404) return { found: false };
	if (resp.status !== 200) throw new Error(`GET /objects/${id} failed with HTTP ${resp.status}`);
	const dataBase64 = resp.body ?? "";
	return { found: true, id, size: Buffer.from(dataBase64, "base64").byteLength, data_base64: dataBase64 };
}

export function createLumberJackObjectsClient(
	addon: RawLumberJackAddon,
	forestDir: string,
	getActiveHandle: () => bigint,
): LumberJackObjectsClient {
	const state: ObjectsClientState = {
		addon, forestDir, getActiveHandle, configured: false, creds: null, sessionToken: null,
	};
	return {
		putObject: (name, mimeType, dataBase64) => putApplicationObject(state, name, mimeType, dataBase64),
		getObject: (id) => getApplicationObject(state, id),
	};
}
