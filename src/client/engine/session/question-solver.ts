export interface ColumnSpec {
	min: number;
	preferredMin: number;
	max: number;
	height(width: number): number;
	widths?: readonly number[];
}

export type QuestionLayout =
	| { kind: "stacked"; width: number; binding: boolean }
	| { kind: "columns"; question: number; answer: number; width: number; height: number; binding: boolean };

export const HEIGHT_TOLERANCE = 1;
export const WIDTH_STEP = 16;

export function stackedWidth(base: number, need: number, available: number): number {
	return Math.max(base, Math.min(Math.max(base, need), available));
}

export function twoColumnTriggered(questionHeight: number, answerHeight: number): boolean {
	return questionHeight + HEIGHT_TOLERANCE >= answerHeight;
}

export function widthGrid(min: number, max: number, step = WIDTH_STEP): number[] {
	const lo = Math.ceil(min);
	const hi = Math.max(lo, Math.floor(max));
	const out: number[] = [];
	for (let w = lo; w < hi; w += step) out.push(w);
	out.push(hi);
	return out;
}

function firstTrue(lo: number, hi: number, pred: (i: number) => boolean): number {
	let a = lo;
	let b = hi + 1;
	while (a < b) {
		const mid = (a + b) >> 1;
		if (pred(mid)) b = mid;
		else a = mid + 1;
	}
	return a;
}

function solveWithFloors(q: ColumnSpec, a: ColumnSpec, qMin: number, aMin: number, available: number, step: number) {
	if (qMin + aMin > available + 0.5) return null;
	const qMax = Math.max(qMin, Math.min(Math.max(q.max, qMin), available - aMin));
	const aMax = Math.max(aMin, Math.min(Math.max(a.max, aMin), available - qMin));
	const grid = (c: ColumnSpec, lo: number, hi: number) =>
		c.widths ? c.widths.filter((w) => w >= lo - 0.5 && w <= hi + 0.5) : widthGrid(lo, hi, step);
	const qs = grid(q, qMin, qMax);
	const as = grid(a, aMin, aMax);
	if (!qs.length || !as.length) return null;
	const qMemo = new Map<number, number>();
	const aMemo = new Map<number, number>();
	const qh = (i: number) => {
		let h = qMemo.get(i);
		if (h === undefined) qMemo.set(i, (h = q.height(qs[i]!)));
		return h;
	};
	const ah = (j: number) => {
		let h = aMemo.get(j);
		if (h === undefined) aMemo.set(j, (h = a.height(as[j]!)));
		return h;
	};
	const aFor = (i: number) => firstTrue(0, as.length - 1, (j) => as[j]! > available - qs[i]! + 0.5) - 1;
	const iLast = firstTrue(0, qs.length - 1, (i) => aFor(i) < 0) - 1;
	if (iLast < 0) return null;
	const cost = (i: number) => Math.max(qh(i), ah(aFor(i)));
	const cross = firstTrue(0, iLast, (i) => qh(i) <= ah(aFor(i)));
	let best = Infinity;
	for (const i of [cross - 1, cross]) {
		if (i >= 0 && i <= iLast) best = Math.min(best, cost(i));
	}
	const qi = firstTrue(0, qs.length - 1, (i) => qh(i) <= best + HEIGHT_TOLERANCE);
	const aj = firstTrue(0, as.length - 1, (j) => ah(j) <= best + HEIGHT_TOLERANCE);
	const binding = Math.max(q.max, qMin) + Math.max(a.max, aMin) > available + 0.5;
	return { question: qs[qi]!, answer: as[aj]!, height: best, binding };
}

export function solveColumns(q: ColumnSpec, a: ColumnSpec, available: number, step = WIDTH_STEP) {
	const preferred = solveWithFloors(q, a, q.preferredMin, a.preferredMin, available, step);
	if (preferred) return preferred;
	const rest = Math.floor(available - a.min);
	if (q.preferredMin > q.min && q.preferredMin > rest && rest >= q.min) {
		return { question: rest, answer: a.min, height: Math.max(q.height(rest), a.height(a.min)), binding: true };
	}
	const hard = solveWithFloors(q, a, q.min, a.min, available, step);
	return hard && { ...hard, binding: true };
}

export interface LayoutInput {
	available: number;
	base: number;
	stackedNeed: number;
	columns?: { triggered: boolean; question: ColumnSpec; answer: ColumnSpec };
}

export function solveQuestionLayout(input: LayoutInput, step = WIDTH_STEP): QuestionLayout {
	if (input.columns?.triggered) {
		const solved = solveColumns(input.columns.question, input.columns.answer, input.available, step);
		if (solved) return { kind: "columns", ...solved, width: solved.question + solved.answer };
	}
	const binding = Boolean(input.columns?.triggered) || Math.max(input.base, input.stackedNeed) > input.available + 0.5;
	return { kind: "stacked", width: stackedWidth(input.base, input.stackedNeed, input.available), binding };
}
