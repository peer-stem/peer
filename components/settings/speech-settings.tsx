"use client";

import { useCallback, useEffect, useState } from "react";
import { DICTATION_ENGINES, SPEAK_MODES, speechEndpointReady, type SpeechSettings, type SpeechVoice } from "@/src/core";
import { saveSpeech, useSpeechSettings, type ResolvedSpeech } from "@/components/speech-settings";
import { CommitInput, ThinSelect } from "./controls";

const ENGINE_LABELS: Record<(typeof DICTATION_ENGINES)[number], string> = { deepgram: "Deepgram (hosted)", local: "Local speech endpoint" };
const SPEAK_LABELS: Record<(typeof SPEAK_MODES)[number], string> = { off: "Off", button: "Play button on replies", auto: "Read each reply aloud" };

/** Only explicit choices are stored; a field at its default is left out. */
function toStored(speech: ResolvedSpeech, patch: SpeechSettings): SpeechSettings {
	const next = { ...speech, ...patch };
	return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== "")) as SpeechSettings;
}

function useVoices(ready: boolean, endpoint: string) {
	const [voices, setVoices] = useState<SpeechVoice[]>([]);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(async (signal?: AbortSignal) => {
		try {
			const response = await fetch("/api/tts/voices", { cache: "no-store", signal });
			const body = await response.json().catch(() => null) as { voices?: SpeechVoice[]; message?: string } | null;
			if (!response.ok) throw new Error(body?.message ?? "Voices unavailable");
			setVoices(body?.voices ?? []);
			setError(null);
		} catch (failure) {
			if (signal?.aborted) return;
			setVoices([]);
			setError(failure instanceof Error ? failure.message : "Voices unavailable");
		}
	}, []);
	useEffect(() => {
		if (!ready) { setVoices([]); setError(null); return; }
		const controller = new AbortController();
		void load(controller.signal);
		return () => controller.abort();
	}, [ready, endpoint, load]);
	return { voices, error };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		<span className="w-28 shrink-0">{label}</span>
		{children}
	</label>;
}

/** Local dictation and spoken replies through any OpenAI-compatible speech
 * server. Hosted Deepgram dictation stays the default. */
export function SpeechSettingsControls() {
	const speech = useSpeechSettings();
	const [failed, setFailed] = useState(false);
	const ready = speechEndpointReady(speech);
	const { voices, error } = useVoices(ready, speech?.endpoint ?? "");
	if (!speech) return null;
	const save = async (patch: SpeechSettings) => {
		const ok = await saveSpeech(toStored(speech, patch));
		setFailed(!ok);
		return ok;
	};
	const known = voices.some((voice) => voice.id === speech.ttsVoice);
	return <div className="space-y-2 px-1" data-testid="speech-settings">
		<Field label="Dictation engine">
			<ThinSelect value={speech.dictation} ariaLabel="Dictation engine" testid="speech-dictation-engine" onChange={(next) => void save({ dictation: next as ResolvedSpeech["dictation"] })}>
				{DICTATION_ENGINES.map((engine) => <option key={engine} value={engine}>{ENGINE_LABELS[engine]}</option>)}
			</ThinSelect>
		</Field>
		<Field label="Speech endpoint">
			<CommitInput value={speech.endpoint} placeholder="http://127.0.0.1:3901/v1" ariaLabel="Speech endpoint URL" testid="speech-endpoint" onCommit={(next) => save({ endpoint: next.trim() })} />
		</Field>
		<Field label="Dictation model">
			<CommitInput value={speech.sttModel} placeholder="whisper-1" ariaLabel="Dictation model" testid="speech-stt-model" onCommit={(next) => save({ sttModel: next.trim() })} />
		</Field>
		<Field label="Read aloud">
			<ThinSelect value={speech.speak} ariaLabel="Read replies aloud" testid="speech-speak-mode" onChange={(next) => void save({ speak: next as ResolvedSpeech["speak"] })}>
				{SPEAK_MODES.map((mode) => <option key={mode} value={mode}>{SPEAK_LABELS[mode]}</option>)}
			</ThinSelect>
		</Field>
		<Field label="Voice">
			<ThinSelect value={speech.ttsVoice} ariaLabel="Voice" testid="speech-voice" disabled={!ready} onChange={(next) => void save({ ttsVoice: next })}>
				<option value="">Endpoint default</option>
				{!known && speech.ttsVoice && <option value={speech.ttsVoice}>{speech.ttsVoice}</option>}
				{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
			</ThinSelect>
		</Field>
		{speech.dictation === "local" && !ready && <p role="alert" className="text-[11px] text-error">Local dictation needs a speech endpoint URL.</p>}
		{ready && error && <p role="alert" className="text-[11px] text-error">{error}</p>}
		{failed && <p role="alert" className="text-[11px] text-error">Could not save. Check the endpoint URL (http or https, no query string).</p>}
		<p className="text-[11px] leading-relaxed text-muted-foreground/70">A local endpoint is any server with the common <code>/audio/transcriptions</code>, <code>/audio/speech</code> and <code>/audio/voices</code> routes. LearnHarness does not install or start one. A voice that is not loaded yet can take minutes to answer the first time.</p>
	</div>;
}
