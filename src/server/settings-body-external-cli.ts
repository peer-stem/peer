import { isDeepStrictEqual } from "node:util";

import { sanitizeExternalCliSettings, type ExternalCliSettingsMap } from "../core/contracts/external-cli.ts";
import { asRecord, type SettingsBodyResult } from "./settings-body-result.ts";

/** externalCli: the whole map is replaced; unknown CLIs and malformed fields
 *  are refused, not silently dropped, so a typo cannot read as "saved". */
export function parseExternalCliSettingsBody(body: unknown): SettingsBodyResult<ExternalCliSettingsMap> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings = sanitizeExternalCliSettings(raw);
	const intact = Object.entries(raw).every(([id, entry]) => isDeepStrictEqual(entry, (settings as Record<string, unknown>)[id]));
	if (!intact) return { ok: false, error: "externalCli has an unknown CLI or an invalid enabled, home or models value" };
	return { ok: true, settings };
}
