import * as fs from "node:fs";
import * as path from "node:path";

export const WORKTREE_ROOT = path.resolve(import.meta.dirname, "..");

export const DESKTOP_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
export const GOLDEN_TEACH_CHAT = "chat_mv27rrra_feff23b6";
export const GOLDEN_PRACTICE_CHAT = "chat_mv293wv5_10656952";
export const GOLDEN_NODE_DELETE = "n_d7a78bb8cdef";
export const GOLDEN_SIDE_THREAD = "side_msg_mv27s2zx_8e76e94b";
export const DOC_MARKDOWN_PATH = "/api/plugins/document-one/documents/markdown";
export const BODY_CAP_BYTES = 27_262_976;
export const BODY_CAP_PLUS_ONE = 27_262_977;
export const MAX_TTS_AUDIO_BYTES = 33_554_432;

export const CONCRETE_ROUTE_PATHS: Readonly<Record<string, string>> = {
	"/api/activity/abort": "/api/activity/abort",
	"/api/activity": "/api/activity",
	"/api/chat": "/api/chat",
	"/api/chats/[id]/artifact-ui": `/api/chats/${GOLDEN_TEACH_CHAT}/artifact-ui`,
	"/api/chats/[id]/dismiss": `/api/chats/${GOLDEN_TEACH_CHAT}/dismiss`,
	"/api/chats/[id]/images/[snapshotId]": `/api/chats/${GOLDEN_TEACH_CHAT}/images/${"0".repeat(64)}`,
	"/api/chats/[id]/markdown": `/api/chats/${GOLDEN_TEACH_CHAT}/markdown`,
	"/api/chats/[id]": `/api/chats/${GOLDEN_TEACH_CHAT}`,
	"/api/chats/[id]/settings": `/api/chats/${GOLDEN_TEACH_CHAT}/settings`,
	"/api/chats/[id]/side-chats": `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats`,
	"/api/chats/[id]/side-chats/[threadId]": `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats/side_missing`,
	"/api/chats/[id]/side-chats/[threadId]/stop": `/api/chats/${GOLDEN_TEACH_CHAT}/side-chats/side_missing/stop`,
	"/api/chats/[id]/steer": `/api/chats/${GOLDEN_TEACH_CHAT}/steer`,
	"/api/chats/[id]/stream": `/api/chats/${GOLDEN_TEACH_CHAT}/stream`,
	"/api/chats": "/api/chats",
	"/api/claude-code": "/api/claude-code",
	"/api/custom-provider": "/api/custom-provider",
	"/api/events": "/api/events",
	"/api/external-cli": "/api/external-cli?id=codex-cli",
	"/api/graph/costs": "/api/graph/costs",
	"/api/graph/coverage/extract": "/api/graph/coverage/extract",
	"/api/graph/import": "/api/graph/import",
	"/api/graph/nodes/[id]": "/api/graph/nodes/n_missing000000",
	"/api/graph/positions": "/api/graph/positions",
	"/api/graph/render-settings": "/api/graph/render-settings",
	"/api/graph": "/api/graph",
	"/api/graph/sources": "/api/graph/sources",
	"/api/graph/sources/folders/[id]": "/api/graph/sources/folders/missing-folder",
	"/api/graph/status": "/api/graph/status",
	"/api/jobs": "/api/jobs",
	"/api/keys/[id]": "/api/keys/BRAVE_API_KEY",
	"/api/keys": "/api/keys",
	"/api/models": "/api/models",
	"/api/plugins/[id]/assets/[...file]": "/api/plugins/document-one/assets/styles.css",
	"/api/plugins/[id]/call": "/api/plugins/document-one/call",
	"/api/plugins/[id]/documents/markdown": DOC_MARKDOWN_PATH,
	"/api/plugins/[id]": "/api/plugins/document-one",
	"/api/plugins": "/api/plugins",
	"/api/search": "/api/search",
	"/api/settings/import-learnharness": "/api/settings/import-learnharness",
	"/api/settings/prompts": "/api/settings/prompts",
	"/api/settings/prompts/[...segment]": "/api/settings/prompts/teacher/identity.md",
	"/api/settings": "/api/settings",
	"/api/settings/[section]": "/api/settings/appearance",
	"/api/stt/token": "/api/stt/token",
	"/api/stt/transcribe": "/api/stt/transcribe",
	"/api/subscriptions/browser": "/api/subscriptions/browser?id=00000000-0000-0000-0000-000000000000",
	"/api/subscriptions": "/api/subscriptions",
	"/api/themes/[id]": "/api/themes/missing-theme",
	"/api/themes": "/api/themes",
	"/api/tts/speak": "/api/tts/speak",
	"/api/tts/voices": "/api/tts/voices",
};

export const GOLDEN_ROUTE_PATTERNS: readonly string[] = Object.keys(CONCRETE_ROUTE_PATHS).sort();

function canWriteScratchParent(dir: string): boolean {
	try {
		fs.accessSync(dir, fs.constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveScratchRoot(): string {
	const persistScratch = "/usr/lib/persist/peer/scratch";
	const usePersist =
		canWriteScratchParent(persistScratch) ||
		(fs.existsSync("/usr/lib/persist/peer") && canWriteScratchParent("/usr/lib/persist/peer"));
	const root = usePersist ? persistScratch : path.join(WORKTREE_ROOT, ".fresh-data");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

export function createScratchDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(resolveScratchRoot(), prefix));
	fs.chmodSync(dir, 0o700);
	return dir;
}

function restorePriorEnv(prior: ReadonlyMap<string, string | undefined>): void {
	for (const [key, val] of prior) {
		if (val === undefined) delete process.env[key];
		else process.env[key] = val;
	}
}

const SCRATCH_ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"TMPDIR",
	"LH_DATA_DIR",
	"LH_AUTH_FILE",
	"LH_IGNORE_ENV_KEYS",
] as const;

export interface IsolatedScratchEnv {
	rootDir: string;
	homeDir: string;
	dataDir: string;
	authFile: string;
	tmpDir: string;
	restore: () => void;
}

export function installScratchProcessEnv(prefix: string): IsolatedScratchEnv {
	const rootDir = createScratchDir(prefix);
	const homeDir = path.join(rootDir, "home");
	const configDir = path.join(rootDir, "config");
	const dataHome = path.join(rootDir, "share");
	const cacheHome = path.join(rootDir, "cache");
	const dataDir = path.join(rootDir, "data");
	const tmpDir = path.join(rootDir, "tmp");
	const authFile = path.join(rootDir, "auth.json");
	for (const dir of [homeDir, configDir, dataHome, cacheHome, dataDir, tmpDir]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	fs.writeFileSync(authFile, "{}\n", { mode: 0o600 });
	const prior = new Map<string, string | undefined>(SCRATCH_ENV_KEYS.map((k) => [k, process.env[k]]));
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
	process.env.XDG_CONFIG_HOME = configDir;
	process.env.XDG_DATA_HOME = dataHome;
	process.env.XDG_CACHE_HOME = cacheHome;
	process.env.TMPDIR = tmpDir;
	process.env.LH_DATA_DIR = dataDir;
	process.env.LH_AUTH_FILE = authFile;
	process.env.LH_IGNORE_ENV_KEYS = "1";
	return {
		rootDir,
		homeDir,
		dataDir,
		authFile,
		tmpDir,
		restore: () => {
			restorePriorEnv(prior);
			fs.rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

export interface ScratchChildEnvSpec {
	homeDir: string;
	dataDir: string;
	authFile: string;
	pathEnv?: string;
	nodeEnv?: "development" | "production" | "test";
	extra?: Record<string, string | undefined>;
}

export function buildScratchChildEnv(spec: ScratchChildEnvSpec): NodeJS.ProcessEnv {
	const tmpDir = path.join(spec.homeDir, "tmp");
	const configHome = path.join(spec.homeDir, ".config");
	const dataHome = path.join(spec.homeDir, ".local", "share");
	const cacheHome = path.join(spec.homeDir, ".cache");
	for (const dir of [spec.homeDir, tmpDir, configHome, dataHome, cacheHome]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const env: NodeJS.ProcessEnv = {
		NODE_ENV: spec.nodeEnv ?? "test",
		HOME: spec.homeDir,
		USERPROFILE: spec.homeDir,
		XDG_CONFIG_HOME: configHome,
		XDG_DATA_HOME: dataHome,
		XDG_CACHE_HOME: cacheHome,
		TMPDIR: tmpDir,
		LH_DATA_DIR: spec.dataDir,
		LH_AUTH_FILE: spec.authFile,
		LH_IGNORE_ENV_KEYS: "1",
		PATH: spec.pathEnv ?? process.env.PATH ?? "/usr/bin:/bin",
	};
	for (const [key, val] of Object.entries(spec.extra ?? {})) {
		if (val !== undefined) env[key] = val;
	}
	return env;
}

export async function encodeMultipartRequest(form: FormData): Promise<{ contentType: string; body: Buffer }> {
	const req = new Request("http://127.0.0.1/upload", { method: "POST", body: form });
	const contentType = req.headers.get("content-type") ?? "";
	const body = Buffer.from(await req.arrayBuffer());
	return { contentType, body };
}
