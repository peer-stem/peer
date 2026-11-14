import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { externalCliEnv } from "../../core/auth-env.ts";

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** PATH first, then common user/native install locations: desktop launches
 * often run without the shell profile that puts those on PATH. */
export function findCliBinary(name: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | null {
	const known = [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), "/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"];
	const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...known];
	for (const dir of dirs) {
		const candidate = path.resolve(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

/** Runs only `--version`: no authentication check, model call or config read. */
export function readCliVersion(binary: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(binary, ["--version"], {
			cwd: os.tmpdir(), env: externalCliEnv(), windowsHide: true,
			timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 4_096,
		}, (error, stdout) => resolve(error ? null : /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null));
	});
}

/** `~` and `~/…` only; anything else must already be absolute. */
export function expandHome(value: string, home: string = os.homedir()): string {
	if (value === "~") return home;
	return value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(value);
}
