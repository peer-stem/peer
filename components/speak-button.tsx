"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle, Square, Volume2 } from "lucide-react";
import { speechEndpointReady, type LhViewMessage } from "@/src/core";
import { speak, stopSpeaking, useSpeechPlayback } from "@/components/speech-playback";
import { useSpeechSettings } from "@/components/speech-settings";

type Reply = { id: string; text: string };

/** One id per text part: its play button and auto-read both speak under it. */
export function speechIdOf(messageId: string, partId: string | undefined, index: number): string {
	return partId || `${messageId}:${index}`;
}

/** A finished teacher reply, read whole under its first passage's id, so that
 * passage's button shows it playing and can stop it. */
export function replyToSpeak(message: LhViewMessage | undefined): Reply | undefined {
	if (message?.role !== "assistant") return undefined;
	const index = message.parts.findIndex((part) => part.type === "text" && !!part.text?.trim());
	if (index < 0) return undefined;
	const text = message.parts.flatMap((part) => part.type === "text" && part.text ? [part.text] : []).join("\n\n");
	return { id: speechIdOf(message.id, message.parts[index]!.id, index), text };
}

/** Reads one teacher passage aloud through the configured speech endpoint.
 * Renders nothing unless reading aloud is switched on in Settings. */
export function SpeakButton({ id, text }: { id: string; text: string }) {
	const speech = useSpeechSettings();
	const playback = useSpeechPlayback();
	if (!speech || speech.speak === "off" || !speechEndpointReady(speech) || !text.trim()) return null;
	const active = playback.speakingId === id;
	const Icon = active ? (playback.loading ? LoaderCircle : Square) : Volume2;
	return <span className="mt-1 flex items-center gap-2">
		<button type="button" aria-label={active ? "Stop reading" : "Read aloud"} title={active ? "Stop reading" : "Read aloud"} data-testid="speak-button"
			onClick={() => active ? stopSpeaking() : speak(id, text)}
			className="inline-flex size-6 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground">
			<Icon className={active && playback.loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
		</button>
		{active && playback.loading && <span role="status" className="text-[11px] text-muted-foreground">Preparing voice…</span>}
		{!active && playback.error && playback.errorId === id && <span role="alert" className="text-[11px] text-error">{playback.error}</span>}
	</span>;
}

/** `auto` reads each finished teacher reply aloud, once. Reading stops when
 * the conversation changes or its view unmounts. */
export function useAutoSpeak(conversationId: string, status: string, last: Reply | undefined): void {
	const speech = useSpeechSettings();
	const previous = useRef(status);
	const spoken = useRef<string | null>(null);
	useEffect(() => stopSpeaking, [conversationId]);
	useEffect(() => {
		const finished = previous.current !== "ready" && status === "ready";
		previous.current = status;
		if (!finished || speech?.speak !== "auto" || !speechEndpointReady(speech)) return;
		if (!last?.text.trim() || spoken.current === last.id) return;
		spoken.current = last.id;
		speak(last.id, last.text);
	}, [status, speech, last]);
}
