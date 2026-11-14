import { sanitizeSpeechSettings, type SpeechSettings } from "../core/contracts/speech.ts";
import { asRecord, type SettingsBodyResult } from "./settings-body-result.ts";

/** speech: the whole section is replaced. A field that would not survive
 *  sanitizing is refused, so an unusable endpoint cannot read as "saved". */
export function parseSpeechSettingsBody(body: unknown): SettingsBodyResult<SpeechSettings> {
	const raw = asRecord(body);
	if (!raw) return { ok: false, error: "Invalid JSON body" };
	const settings = sanitizeSpeechSettings(raw);
	const provided = Object.entries(raw).filter(([, value]) => value !== undefined && value !== "");
	const kept = settings as Record<string, unknown>;
	if (provided.some(([key, value]) => key === "endpoint" ? kept.endpoint === undefined : kept[key] !== value)) {
		return { ok: false, error: "speech has an unknown field, an unusable endpoint URL or an invalid name" };
	}
	return { ok: true, settings };
}
