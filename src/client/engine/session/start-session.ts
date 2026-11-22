import { clearOpeningPrompt, OPENING_PROMPT_FAILURE, stashOpeningPrompt } from "./opening-prompt.ts";

export interface SessionCreation {
	title: string;
	kind?: "practice";
	graphContext?: { propositions: readonly { id: string; name: string; statement: string }[] };
}

async function createRemoteSession(body: SessionCreation, fetchLike: typeof fetch): Promise<string> {
	const res = await fetchLike("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(OPENING_PROMPT_FAILURE);
	const result = (await res.json()) as { id?: unknown };
	if (typeof result.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(result.id)) {
		throw new Error(OPENING_PROMPT_FAILURE);
	}
	return result.id;
}

export class SessionStarter {
	private created?: { identity: string; id: string };

	async start(body: SessionCreation, fetchLike: typeof fetch, settingsIdentity?: string): Promise<string> {
		const identity = JSON.stringify([body, settingsIdentity]);
		if (this.created?.identity !== identity) {
			if (this.created) clearOpeningPrompt(this.created.id);
			this.created = undefined;
			const id = await createRemoteSession(body, fetchLike);
			this.created = { identity, id };
		}
		if (!stashOpeningPrompt(this.created.id, body.title)) throw new Error(OPENING_PROMPT_FAILURE);
		return `/chat/${this.created.id}`;
	}
}
