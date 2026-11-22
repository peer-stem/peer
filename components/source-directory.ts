"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OrganizationAction, SourceDirectory } from "@/src/core";
import { fetchSourceDirectory, postSourceOrganizationAction } from "../src/client/engine/dom/source-directory.ts";
import { useServerEvent, useServerResync } from "./server-events";

export * from "../src/client/engine/dom/source-directory.ts";

export function useSourceDirectory(enabled: boolean) {
	const [directory, setDirectory] = useState<SourceDirectory>();
	const [failure, setFailure] = useState("");
	const version = useRef(0);
	const request = useRef<AbortController | null>(null);
	const tail = useRef<Promise<unknown>>(Promise.resolve());

	const read = useCallback(async () => {
		const current = ++version.current;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		try {
			const body = await fetchSourceDirectory(controller.signal);
			if (!controller.signal.aborted && current === version.current) setDirectory(body);
		} catch {
			/* Retain last good organization on transient failure. */
		}
	}, []);

	useEffect(() => {
		if (!enabled) return;
		void read();
		return () => {
			version.current++;
			request.current?.abort();
			request.current = null;
		};
	}, [enabled, read]);

	useServerEvent("sources-changed", () => { if (enabled) void read(); });
	useServerEvent("chats-changed", () => { if (enabled) void read(); });
	useServerResync(() => { if (enabled) void read(); });

	const change = useCallback((action: OrganizationAction): Promise<string | undefined> => {
		const operation = tail.current.catch(() => {}).then(async () => {
			try {
				const createdFolderId = await postSourceOrganizationAction(action);
				await read();
				setFailure("");
				return createdFolderId;
			} catch (error) {
				setFailure(error instanceof Error ? error.message : String(error));
				throw error;
			}
		});
		tail.current = operation;
		return operation;
	}, [read]);

	return { directory, failure, clearFailure: () => setFailure(""), reportFailure: setFailure, change };
}
