/**
 * Assistant read-aloud button (`[data-testid="speak-button"]`, `components/speak-button.tsx` parity)
 * and `auto` mode tracker that speaks newly settled assistant messages once.
 */
import { createLife, documentOf, el, injectUiStyles, show, textNode, writeText } from "cloudcanvas-lib/ui";
import { getSpeechPlaybackSnapshot, speak, speechEndpointReady, stopSpeaking, subscribeSpeechPlayback, toSpeakable } from "peer-engine";
import { injectVoiceStyles } from "./voice.css.js";

export function canShowSpeakControl(speechModel) {
	const cfg = speechModel?.speech ?? speechModel;
	if (!cfg || cfg.speak === "off") return false;
	return speechEndpointReady(cfg);
}

function syncSpeakButtonDom(btn, label, state, getText) {
	const visible = canShowSpeakControl(state.speechModel) && toSpeakable(String(getText?.() ?? "")).length > 0;
	show(btn, visible);
	if (!visible) return;
	const pb = state.speechModel?.playback ?? getSpeechPlaybackSnapshot();
	const active = pb?.speakingId === state.currentId;
	btn.classList.toggle("is-speaking", active);
	btn.setAttribute("aria-label", active ? "Stop reading aloud" : "Read aloud");
	writeText(label, active ? (pb?.loading ? "Loading…" : "Stop") : "Speak");
	if (pb?.errorId === state.currentId && pb?.error) btn.title = pb.error;
	else btn.removeAttribute("title");
}

export function createSpeakButton(host, { id, getText, onSpeak, onStop } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectVoiceStyles(doc);
	const life = createLife();
	const btn = el(doc, "button", {
		className: "peer-speak-btn",
		attrs: { type: "button", "data-testid": "speak-button", "aria-label": "Read aloud", hidden: true },
	});
	const label = textNode(doc, btn, "Speak");
	const state = { currentId: String(id ?? ""), speechModel: null };
	const paint = () => { if (!life.dead) syncSpeakButtonDom(btn, label, state, getText); };

	life.add(subscribeSpeechPlayback(paint));
	life.on(btn, "click", () => {
		const pb = state.speechModel?.playback ?? getSpeechPlaybackSnapshot();
		if (pb?.speakingId === state.currentId) {
			if (onStop) onStop(); else stopSpeaking();
			return;
		}
		const md = String(getText?.() ?? "");
		if (!md.trim()) return;
		if (onSpeak) onSpeak(state.currentId, md); else speak(state.currentId, md);
	});
	host.append(btn);
	paint();

	return {
		node: btn,
		update(next = {}) {
			if ("id" in next) state.currentId = String(next.id ?? "");
			if ("speech" in next) state.speechModel = next.speech;
			paint();
		},
		destroy: () => { if (life.destroy()) btn.remove(); },
	};
}

function recordSeenMessageIds(seenIds, list) {
	for (const msg of list) {
		if (msg?.id) seenIds.add(String(msg.id));
	}
}

export function createAutoSpeakTracker({ onSpeak } = {}) {
	let seeded = false;
	let chatId = "";
	const seenIds = new Set();

	const observe = ({ nextChatId, messages, status, speech }) => {
		if (nextChatId !== chatId) { chatId = String(nextChatId ?? ""); seeded = false; seenIds.clear(); }
		const list = Array.isArray(messages) ? messages : [];
		if (!seeded) { recordSeenMessageIds(seenIds, list); seeded = true; return; }
		const cfg = speech?.speech ?? speech;
		if (!cfg || cfg.speak !== "auto" || !speechEndpointReady(cfg)) {
			if (status === "ready") recordSeenMessageIds(seenIds, list);
			return;
		}
		if (status !== "ready") return;
		const last = list.at(-1);
		if (!last || last.role !== "assistant" || !last.id || seenIds.has(String(last.id))) return;
		seenIds.add(String(last.id));
		const text = (last.parts ?? []).filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n\n");
		if (!toSpeakable(text)) return;
		const msgId = `msg:${last.id}`;
		if (onSpeak) onSpeak(msgId, text); else speak(msgId, text);
	};

	return { observe, reset() { seeded = false; seenIds.clear(); } };
}
