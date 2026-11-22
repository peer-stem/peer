"use client";

import { useEffect, useRef } from "react";
import { onSettingsSaved, type SettingsSection } from "../src/client/engine/dom/settings-signal.ts";

export * from "../src/client/engine/dom/settings-signal.ts";

export function useSettingsSaved(handler: (section: SettingsSection) => void): void {
	const saved = useRef(handler);
	saved.current = handler;
	useEffect(() => onSettingsSaved((section) => saved.current(section)), []);
}
