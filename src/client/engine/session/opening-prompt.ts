export const OPENING_PROMPT_FAILURE = "Couldn’t open the session. Your message is still here. Try sending again.";

export interface OpeningPrompt {
	text: string;
	attempted: boolean;
}

const keyFor = (id: string) => `lh.openingPrompt.${id}`;

export function stashOpeningPrompt(id: string, text: string, attempted = false): boolean {
	try {
		const value = JSON.stringify({ text, attempted } satisfies OpeningPrompt);
		const storage = globalThis.sessionStorage;
		storage.setItem(keyFor(id), value);
		return storage.getItem(keyFor(id)) === value;
	} catch {
		return false;
	}
}

function parseOpeningPromptJson(value: string): OpeningPrompt | undefined {
	try {
		const entry: unknown = JSON.parse(value);
		if (
			entry &&
			typeof entry === "object" &&
			"text" in entry &&
			typeof entry.text === "string" &&
			entry.text.length > 0 &&
			"attempted" in entry &&
			typeof entry.attempted === "boolean"
		) {
			return { text: entry.text, attempted: entry.attempted };
		}
	} catch {
		/* Legacy raw-text stashes fall through to attempted: true. */
	}
	return undefined;
}

export function readOpeningPromptEntry(id: string): OpeningPrompt | undefined {
	try {
		const value = globalThis.sessionStorage.getItem(keyFor(id));
		if (!value) return undefined;
		return parseOpeningPromptJson(value) ?? { text: value, attempted: true };
	} catch {
		return undefined;
	}
}

export function readOpeningPrompt(id: string): string | undefined {
	return readOpeningPromptEntry(id)?.text;
}

export function clearOpeningPrompt(id: string): boolean {
	try {
		globalThis.sessionStorage.removeItem(keyFor(id));
		return true;
	} catch {
		return false;
	}
}
