let active = false;
const listeners = new Set<() => void>();

export function isDictationActive(): boolean {
	return active;
}

export function setDictationActive(next: boolean): void {
	if (active === next) return;
	active = next;
	for (const listener of listeners) listener();
}

export function subscribeDictationActive(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function joinDictation(current: string, chunk: string): string {
	const trimmed = chunk.trim();
	if (!trimmed) return current;
	if (!current || /\s$/.test(current)) return current + trimmed;
	return `${current} ${trimmed}`;
}

export function rmsToMeter(rms: number): number {
	if (!Number.isFinite(rms) || rms <= 0) return 0;
	const db = 20 * Math.log10(Math.max(rms, 1e-5));
	return Math.max(0, Math.min(1, (db + 48) / 42));
}
