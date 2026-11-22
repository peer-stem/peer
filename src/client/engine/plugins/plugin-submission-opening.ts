/** Defer opening setup until its owning effect and native boundary have committed. */
export function scheduleOpeningSubmission(isCurrent: () => boolean, start: () => void): () => void {
	let live = true;
	queueMicrotask(() => {
		if (live && isCurrent()) start();
	});
	return () => {
		live = false;
	};
}
