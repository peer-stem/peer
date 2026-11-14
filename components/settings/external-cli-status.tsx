"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ADDED_CLI_IDS, CLAUDE_CODE_PROVIDER, EXTERNAL_CLI_MODEL_ID, externalCli,
	type ExternalCliId, type ExternalCliSettings, type ExternalCliSettingsMap, type ExternalCliStatus, type UserSettings,
} from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { CommitInput, Toggle } from "./controls";

/** Where each CLI keeps its own login when no directory is named. */
const HOME_PLACEHOLDERS: Record<ExternalCliId, string> = {
	[CLAUDE_CODE_PROVIDER]: "",
	claudex: "~/.claudeex",
	"codex-cli": "~/.codex",
	"agy-cli": "~",
};

type Save = (id: ExternalCliId, entry: ExternalCliSettings) => Promise<boolean>;

export function externalCliStatusLabel(status: ExternalCliStatus | null): string {
	if (!status) return "Could not be checked";
	if (status.state === "not-found") return "Not found";
	const models = `${status.models.length} model${status.models.length === 1 ? "" : "s"}`;
	return status.version ? `Version ${status.version} · ${models}` : models;
}

/** Commas or whitespace separate IDs; anything else is refused, not trimmed away. */
export function parseModelIds(text: string): string[] | null {
	const ids = text.split(/[\s,]+/).filter(Boolean);
	return ids.every((id) => EXTERNAL_CLI_MODEL_ID.test(id)) ? [...new Set(ids)] : null;
}

function useCliStatus(id: ExternalCliId, enabled: boolean) {
	const [status, setStatus] = useState<ExternalCliStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
	const refresh = useCallback(async () => {
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch(`/api/external-cli?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: controller.signal, headers: { "x-learnharness-external-cli": "1" } });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as ExternalCliStatus;
			if (!controller.signal.aborted) setStatus(value);
			// A fresh model list changes what the pickers offer.
			if (!controller.signal.aborted) notifySettingsSaved("externalCli");
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [id]);
	useEffect(() => {
		if (enabled) void refresh();
		else { request.current?.abort(); setStatus(null); setBusy(false); }
		return () => request.current?.abort();
	}, [enabled, refresh]);
	return { status, busy, refresh };
}

function ModelIdsInput({ id, entry, save, disabled }: { id: ExternalCliId; entry: ExternalCliSettings; save: Save; disabled: boolean }) {
	const label = `${externalCli(id)!.label} extra model IDs`;
	return <CommitInput value={(entry.models ?? []).join(", ")} placeholder="Extra model IDs, comma separated" ariaLabel={label}
		testid={`external-cli-models-${id}`} disabled={disabled}
		onCommit={(next) => {
			const models = parseModelIds(next);
			return models === null ? false : save(id, { ...entry, models });
		}} />;
}

function CliRow({ id, entry, save, disabled }: { id: ExternalCliId; entry: ExternalCliSettings; save: Save; disabled: boolean }) {
	const { label } = externalCli(id)!;
	const enabled = entry.enabled === true;
	const { status, busy, refresh } = useCliStatus(id, enabled);
	return <div className="space-y-2" data-testid={`external-cli-${id}`}>
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">{label}</span>
			<Toggle label={label} checked={enabled} disabled={disabled} onChange={(next) => void save(id, { ...entry, enabled: next })} />
		</div>
		{enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : externalCliStatusLabel(status)}</span>
				<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} onClick={() => void refresh()}>Check again</Button>
			</div>
			<CommitInput value={entry.home ?? ""} placeholder={`Configuration directory (default ${HOME_PLACEHOLDERS[id]})`} ariaLabel={`${label} configuration directory`}
				testid={`external-cli-home-${id}`} disabled={disabled}
				onCommit={(next) => save(id, { ...entry, home: next.trim() || undefined })} />
			<ModelIdsInput id={id} entry={entry} save={save} disabled={disabled} />
		</>}
	</div>;
}

function useExternalCliSettings() {
	const [map, setMap] = useState<ExternalCliSettingsMap | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		const controller = new AbortController();
		fetch("/api/settings", { cache: "no-store", signal: controller.signal })
			.then((response) => response.ok ? response.json() as Promise<{ settings: UserSettings | null }> : Promise.reject(new Error("settings unavailable")))
			.then((body) => setMap(body.settings?.externalCli ?? {}))
			.catch(() => { if (!controller.signal.aborted) setError("Could not load CLI settings."); });
		return () => controller.abort();
	}, []);
	const save: Save = async (id, entry) => {
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/settings/externalCli", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...map, [id]: entry }) });
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			setMap(body.settings.externalCli ?? {});
			notifySettingsSaved("externalCli");
			return true;
		} catch {
			setError("Could not save CLI settings.");
			return false;
		} finally {
			setSaving(false);
		}
	};
	return { map, error, saving, save };
}

/** Further CLI bindings beside Claude Code, and extra model IDs for each. */
export function ExternalCliSettingsRows() {
	const { map, error, saving, save } = useExternalCliSettings();
	const disabled = map === null || saving;
	return <div className="space-y-4" data-testid="external-cli-settings">
		<ModelIdsInput id={CLAUDE_CODE_PROVIDER} entry={map?.[CLAUDE_CODE_PROVIDER] ?? {}} save={save} disabled={disabled} />
		{ADDED_CLI_IDS.map((id) => <CliRow key={id} id={id} entry={map?.[id] ?? {}} save={save} disabled={disabled} />)}
		{error && <p role="alert" className="text-xs text-error">{error}</p>}
		<p className="text-xs leading-relaxed text-muted-foreground">Each CLI is installed and signed in outside LearnHarness and controls its own billing. LearnHarness runs it without your own agent instructions, skills, plugins or MCP servers, and gives it only the tutor&rsquo;s tools.</p>
	</div>;
}
