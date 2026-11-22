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
