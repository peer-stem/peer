const DURATION = 120;
const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const EPSILON = 1;

export function naturalDockHeight(shell: HTMLElement): number {
	const value = shell.style.getPropertyValue("height");
	const priority = shell.style.getPropertyPriority("height");
	try {
		shell.style.setProperty("height", "auto", "important");
		return shell.getBoundingClientRect().height;
	} finally {
		if (value) shell.style.setProperty("height", value, priority);
		else shell.style.removeProperty("height");
	}
}

interface OwnedMorph {
	shell: HTMLElement;
	key: string;
	animation: Animation;
	opening: boolean;
	target: number;
	duration: number;
}

interface MorphState {
	previous: { shell: HTMLElement; key: string; height: number } | null;
	owned: OwnedMorph | null;
}

const isLiveAnimation = (animation: Animation) =>
	animation.playState !== "finished" && animation.playState !== "idle";

function layoutDockMorph(
	state: MorphState,
	shell: HTMLElement,
	key: string,
	opening: boolean,
	onNaturalLayout: () => void,
): void {
	if (state.previous?.shell === shell && state.previous.key === key) {
		if (state.owned && isLiveAnimation(state.owned.animation)) return;
		state.previous.height = shell.getBoundingClientRect().height;
		onNaturalLayout();
		return;
	}
	state.owned?.animation.cancel();
	state.owned = null;
	const height = shell.getBoundingClientRect().height;
	onNaturalLayout();
	if (state.previous?.shell === shell && Math.abs(state.previous.height - height) > EPSILON) {
		const keyframes = [{ height: `${state.previous.height}px` }, { height: `${height}px` }];
		const animation = shell.animate(keyframes, { duration: DURATION, easing: EASING });
		state.owned = { shell, key, animation, opening, target: height, duration: DURATION };
	}
	state.previous = { shell, key, height };
}

function retargetActiveMorph(state: MorphState, key: string): void {
	const active = state.owned;
	if (!active || active.key !== key || !active.opening || !isLiveAnimation(active.animation)) return;
	const effect = active.animation.effect as KeyframeEffect | null;
	if (!effect) return;
	const visible = active.shell.getBoundingClientRect().height;
	const currentTime = active.animation.currentTime;
	const remaining = active.duration - (typeof currentTime === "number" ? currentTime : 0);
	if (remaining <= 0) return;
	const target = naturalDockHeight(active.shell);
	if (Math.abs(target - active.target) <= EPSILON || !isLiveAnimation(active.animation)) return;
	active.animation.currentTime = 0;
	effect.setKeyframes([{ height: `${visible}px` }, { height: `${target}px` }]);
	effect.updateTiming({ duration: remaining });
	active.duration = remaining;
	active.target = target;
	if (state.previous?.key === key) state.previous.height = target;
}

export function createDockMorph() {
	const state: MorphState = { previous: null, owned: null };
	return {
		layout(shell: HTMLElement, key: string, opening: boolean, onNaturalLayout: () => void) {
			layoutDockMorph(state, shell, key, opening, onNaturalLayout);
		},
		retarget(key: string) {
			retargetActiveMorph(state, key);
		},
		dispose() {
			state.owned?.animation.cancel();
			state.owned = null;
			state.previous = null;
		},
	};
}

interface WidthMorphState {
	painted: { el: HTMLElement; width: number } | null;
	pending: { el: HTMLElement; width: number } | null;
	frame: number;
	running: Animation | null;
}

function layoutDockWidthMorph(s: WidthMorphState, el: HTMLElement, width: number, onFinish: () => void): void {
	const isLive = Boolean(s.running && isLiveAnimation(s.running));
	const from = isLive ? Number.parseFloat(getComputedStyle(el).maxWidth) : s.painted?.el === el ? s.painted.width : NaN;
	const changed = s.pending?.el !== el || Math.abs(s.pending.width - width) > EPSILON;
	s.pending = { el, width };
	if (!s.frame && typeof requestAnimationFrame === "function") {
		s.frame = requestAnimationFrame(() => { s.frame = 0; s.painted = s.pending; });
	}
	if (!changed) return;
	s.running?.cancel();
	s.running = null;
	if (!Number.isFinite(from) || Math.abs(from - width) <= EPSILON) return;
	const animation = el.animate([{ maxWidth: `${from}px` }, { maxWidth: `${width}px` }], { duration: DURATION, easing: EASING });
	s.running = animation;
	animation.finished.then(() => { if (s.running === animation) { s.running = null; onFinish(); } }, () => {});
}

export function createDockWidthMorph() {
	const s: WidthMorphState = { painted: null, pending: null, frame: 0, running: null };
	return {
		layout: (el: HTMLElement, width: number, onFinish: () => void) => layoutDockWidthMorph(s, el, width, onFinish),
		animating: () => Boolean(s.running && isLiveAnimation(s.running)),
		dispose() {
			s.running?.cancel();
			s.running = null;
			if (s.frame) cancelAnimationFrame(s.frame);
			s.frame = 0;
			s.painted = s.pending = null;
		},
	};
}
