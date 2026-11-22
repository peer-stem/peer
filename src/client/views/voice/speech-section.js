/**
 * Speech & TTS settings subview (`[data-testid="speech-settings"]`,
 * `components/settings/speech-settings.tsx` parity).
 * Mounted inside `views/settings/keys-section.js`.
 */
import { button, createLife, documentOf, el, injectUiStyles, input, show, textNode, writeText } from "cloudcanvas-lib/ui";
import { DICTATION_LANGUAGES, FACTORY_SPEECH, normalizeSpeechEndpoint, resolveSpeech, speechEndpointReady } from "peer-engine";
import { injectVoiceStyles } from "./voice.css.js";

function populateLanguageOptions(doc, selectEl) {
	for (const entry of DICTATION_LANGUAGES) {
		selectEl.append(el(doc, "option", { text: entry.label, attrs: { value: entry.code } }));
	}
}

function buildEngineAndSpeakRows(doc, life, commitPatch) {
	const dictRow = el(doc, "div", { className: "peer-settings-row" });
	const dictEngine = el(doc, "select", {
		className: "peer-settings-select peer-settings-select-narrow",
		attrs: { "aria-label": "Dictation engine", "data-testid": "speech-dictation-engine" },
	});
	dictEngine.append(
		el(doc, "option", { text: "Deepgram (hosted)", attrs: { value: "deepgram" } }),
		el(doc, "option", { text: "Local Whisper endpoint", attrs: { value: "local" } }),
	);
	life.on(dictEngine, "change", () => commitPatch({ dictation: dictEngine.value }));
	dictRow.append(el(doc, "span", { className: "peer-settings-row-label", text: "Dictation engine" }), dictEngine);

	const langRow = el(doc, "div", { className: "peer-settings-row", attrs: { "data-testid": "group-dictation" } });
	const langSelect = el(doc, "select", {
		className: "peer-settings-select peer-settings-select-narrow",
		attrs: { "aria-label": "Dictation language", "data-testid": "dictation-language-select", "data-peer-dictation-language": "" },
	});
	populateLanguageOptions(doc, langSelect);
	langRow.append(el(doc, "span", { className: "peer-settings-row-label", text: "Dictation language" }), langSelect);

	const speakRow = el(doc, "div", { className: "peer-settings-row" });
	const speakMode = el(doc, "select", {
		className: "peer-settings-select peer-settings-select-narrow",
		attrs: { "aria-label": "Read responses aloud", "data-testid": "speech-speak-mode" },
	});
	speakMode.append(
		el(doc, "option", { text: "Off", attrs: { value: "off" } }),
		el(doc, "option", { text: "Speak button", attrs: { value: "button" } }),
		el(doc, "option", { text: "Automatic", attrs: { value: "auto" } }),
	);
	life.on(speakMode, "change", () => commitPatch({ speak: speakMode.value }));
	speakRow.append(el(doc, "span", { className: "peer-settings-row-label", text: "Read responses aloud" }), speakMode);
	return { dictRow, dictEngine, langRow, langSelect, speakRow, speakMode };
}

function buildEndpointFields(doc, life, commitPatch, onRefreshVoices) {
	const box = el(doc, "div", { className: "peer-speech-settings", attrs: { "data-peer-speech-local-fields": "" } });
	const endpointInput = input(doc, {
		label: "Speech endpoint URL",
		placeholder: "http://127.0.0.1:8000/v1",
		signal: life.signal,
		attrs: { "data-testid": "speech-endpoint" },
	});
	const sttModelInput = input(doc, {
		label: "STT model",
		placeholder: FACTORY_SPEECH.sttModel,
		signal: life.signal,
		attrs: { "data-testid": "speech-stt-model" },
	});
	const voiceInput = input(doc, {
		label: "TTS voice",
		placeholder: FACTORY_SPEECH.ttsVoice || "af_heart",
		signal: life.signal,
		attrs: { "data-testid": "speech-voice", list: "peer-speech-voices-list" },
	});
	const voiceDatalist = el(doc, "datalist", { attrs: { id: "peer-speech-voices-list" } });
	const saveEndpoint = () => {
		const normalized = normalizeSpeechEndpoint(endpointInput.value);
		commitPatch({
			endpoint: normalized ?? "",
			sttModel: sttModelInput.value.trim() || FACTORY_SPEECH.sttModel,
			ttsVoice: voiceInput.value.trim(),
		});
	};
	life.on(endpointInput, "change", saveEndpoint);
	life.on(sttModelInput, "change", saveEndpoint);
	life.on(voiceInput, "change", saveEndpoint);

	const controls = el(doc, "div", { className: "peer-settings-controls" });
	controls.append(
		endpointInput,
		sttModelInput,
		voiceInput,
		voiceDatalist,
		button(doc, { label: "Save speech endpoint", signal: life.signal, onClick: saveEndpoint, attrs: { "data-testid": "speech-save-endpoint" } }),
		button(doc, { label: "Refresh voices", signal: life.signal, onClick: onRefreshVoices, attrs: { "data-testid": "speech-refresh-voices" } }),
	);
	const hintEl = el(doc, "p", { className: "peer-settings-hint", attrs: { hidden: true } });
	const hintText = textNode(doc, hintEl, "");
	box.append(controls, hintEl);
	return { box, endpointInput, sttModelInput, voiceInput, voiceDatalist, hintEl, hintText };
}

function syncSpeechDom(doc, nodes, state) {
	const sp = state.current;
	nodes.top.dictEngine.value = sp.dictation;
	nodes.top.speakMode.value = sp.speak;
	nodes.top.langSelect.value = state.language;
	const needsEndpoint = sp.dictation === "local" || sp.speak !== "off";
	show(nodes.local.box, needsEndpoint);
	if (doc.activeElement !== nodes.local.endpointInput) nodes.local.endpointInput.value = sp.endpoint;
	if (doc.activeElement !== nodes.local.sttModelInput) nodes.local.sttModelInput.value = sp.sttModel;
	if (doc.activeElement !== nodes.local.voiceInput) nodes.local.voiceInput.value = sp.ttsVoice;

	const voices = state.speechStore?.voices ?? [];
	const sig = voices.join("|");
	if (sig !== state.voicesSig) {
		state.voicesSig = sig;
		nodes.local.voiceDatalist.replaceChildren(...voices.map((v) => el(doc, "option", { attrs: { value: v } })));
	}
	const err = state.speechStore?.error ?? state.speechStore?.voicesError ?? "";
	const statusMsg = err || (needsEndpoint && !speechEndpointReady(sp) ? "Enter an OpenAI-compatible speech server URL (e.g. Speaches / Kokoro / Faster-Whisper)." : "");
	show(nodes.local.hintEl, statusMsg !== "");
	writeText(nodes.local.hintText, statusMsg);
}

export function createSpeechSettingsView(host, { onSpeechIntent, onSettingsIntent } = {}) {
	const doc = documentOf(host);
	injectUiStyles(doc);
	injectVoiceStyles(doc);
	const life = createLife();
	const root = el(doc, "div", { className: "peer-settings-group peer-speech-settings", attrs: { "data-testid": "speech-settings" } });
	root.append(el(doc, "h3", { className: "peer-settings-group-title", text: "Voice, Dictation & Read Aloud" }));

	const state = { current: FACTORY_SPEECH, language: "en", speechStore: null, voicesSig: "" };
	const commitPatch = (patch) => {
		const next = { ...state.current, ...patch };
		state.current = resolveSpeech(next);
		if (onSpeechIntent) onSpeechIntent({ type: "save-speech", speech: next });
		else onSettingsIntent?.({ type: "save-section", section: "speech", value: next });
	};
	const top = buildEngineAndSpeakRows(doc, life, commitPatch);
	life.on(top.langSelect, "change", () => {
		state.language = top.langSelect.value;
		if (onSpeechIntent) onSpeechIntent({ type: "save-language", language: top.langSelect.value });
		else onSettingsIntent?.({ type: "save-section", section: "dictation", value: { language: top.langSelect.value } });
	});
	const local = buildEndpointFields(doc, life, commitPatch, () => onSpeechIntent?.({ type: "load-voices" }));
	const nodes = { top, local };
	root.append(top.dictRow, top.langRow, top.speakRow, local.box);
	host.append(root);

	const update = ({ settings = null, speech = null } = {}) => {
		if (life.dead) return;
		state.speechStore = speech;
		const rawSpeech = speech?.speech ?? settings?.record?.speech ?? settings?.effective?.speech;
		state.current = resolveSpeech(rawSpeech);
		state.language = speech?.language ?? settings?.record?.dictation?.language ?? settings?.effective?.dictation?.language ?? "en";
		syncSpeechDom(doc, nodes, state);
	};
	update({});

	return { node: root, update, destroy: () => { if (life.destroy()) root.remove(); } };
}
