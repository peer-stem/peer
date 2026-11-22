/**
 * Pure question normalization, seeded option shuffle, lettering, grading, and
 * `QuestionAnswerData` builders for `question-dock.js`.
 */

export const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100];
export const DEFAULT_CONFIDENCE = 50;
export const OPTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function toolQuestionKind(tool) {
	if (tool === "quiz" || tool === "probe") return "quiz";
	if (tool === "explain" || tool === "recall") return "explain";
	return "ask";
}

function stripDebris(raw) {
	const trimmed = String(raw ?? "").trim();
	return trimmed.replace(/^['"`]+|['"`]+$/g, "").trim();
}

function parseOptionsIfString(raw) {
	if (typeof raw !== "string") return raw;
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) return parsed;
	} catch { /* literal */ }
	return raw;
}

export function normalizeQuestionOptions(rawOptions) {
	const coerced = parseOptionsIfString(rawOptions);
	if (!Array.isArray(coerced)) return [];
	const seen = new Set();
	const out = [];
	for (let i = 0; i < coerced.length; i += 1) {
		const item = coerced[i];
		const rec = typeof item === "string" ? { label: item } : (item && typeof item === "object" ? item : null);
		if (!rec) continue;
		const label = String(rec.label ?? rec.text ?? rec.value ?? "").trim();
		if (!label) continue;
		const value = String(rec.value ?? "").trim() || label;
		if (seen.has(value)) continue;
		seen.add(value);
		const description = rec.description ? String(rec.description).trim() : undefined;
		out.push({ ...(description ? { label, value, description } : { label, value }), authoredPosition: i + 1 });
	}
	return out;
}

export function seededRandom(seed) {
	let h = 2166136261;
	const str = String(seed ?? "");
	for (let i = 0; i < str.length; i += 1) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	let a = h >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffleOptions(options, rand) {
	const out = [...options];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rand() * (i + 1));
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

function buildOptionOrder(displayed, kind, multiSelect) {
	if (kind === "explain" || multiSelect || displayed.length === 0 || displayed.length > OPTION_LETTERS.length) {
		return undefined;
	}
	const order = {};
	for (let i = 0; i < displayed.length; i += 1) {
		order[OPTION_LETTERS[i]] = displayed[i].authoredPosition ?? (i + 1);
	}
	return order;
}

function coerceCorrectValues(correctAnswer, optionValues) {
	if (correctAnswer === undefined || correctAnswer === null) return [];
	const cleanOne = (v) => {
		const str = String(v ?? "").trim();
		return optionValues.includes(str) ? str : stripDebris(str);
	};
	if (Array.isArray(correctAnswer)) return correctAnswer.map(cleanOne).filter(Boolean);
	const trimmed = String(correctAnswer).trim();
	if (optionValues.includes(trimmed)) return [trimmed];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map(cleanOne).filter(Boolean);
		} catch { /* single string */ }
	}
	const single = cleanOne(trimmed);
	return single ? [single] : [];
}

export function resolveCorrectIndices(correctAnswer, options) {
	const values = coerceCorrectValues(correctAnswer, options.map((o) => o.value));
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices = [];
	for (const val of values) {
		const idx = byValue.get(val);
		if (idx !== undefined && !indices.includes(idx)) indices.push(idx);
	}
	return indices.sort((a, b) => a - b);
}

function isExactMatch(selectedIndices, correctIndices) {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((val, i) => val === b[i]);
}

export function deriveQuestionData(pending) {
	if (!pending || typeof pending !== "object") return null;
	const toolCallId = String(pending.toolCallId ?? "");
	if (!toolCallId) return null;
	const tool = String(pending.tool ?? "ask_user_question");
	const kind = toolQuestionKind(tool);
	const input = pending.input && typeof pending.input === "object" ? pending.input : {};
	const question = String(input.question ?? input.prompt ?? "").trim();
	const context = input.details ? String(input.details).trim() : "";
	const multiSelect = input.multiSelect === true;
	const rawOptions = normalizeQuestionOptions(input.options ?? input.choices);
	const ordered = kind === "quiz" && rawOptions.length > 0
		? shuffleOptions(rawOptions, seededRandom(toolCallId))
		: rawOptions;
	const optionOrder = buildOptionOrder(ordered, kind, multiSelect);
	const mode = kind === "quiz"
		? (multiSelect ? "multi-select" : "single-select")
		: ordered.length > 0 ? (multiSelect ? "multi-select" : "single-select") : "text";
	const rawType = stripDebris(input.type ?? "");
	const questionType = kind === "quiz" && (rawType === "predict" || rawType === "check") ? rawType : undefined;
	return {
		toolCallId,
		questionKey: String(pending.key ?? toolCallId),
		tool,
		kind,
		questionType,
		question,
		context,
		mode,
		multiSelect,
		options: ordered.map(({ authoredPosition: _pos, ...rest }) => rest),
		optionOrder,
		correctIndices: kind === "quiz" ? resolveCorrectIndices(input.correctAnswer, ordered) : [],
		explanation: kind === "quiz" && input.explanation ? String(input.explanation) : undefined,
		committedAnswer: kind === "explain" && input.correctAnswer ? String(input.correctAnswer) : undefined,
	};
}

function appendQuizOrExplainFields(out, qd, form, dontKnow, answers) {
	if (qd.kind === "quiz") {
		out.correctIndices = qd.correctIndices;
		if (qd.explanation !== undefined) out.explanation = qd.explanation;
		out.correct = dontKnow ? false : isExactMatch(answers.map((a) => a.index), qd.correctIndices);
		if (!dontKnow) {
			const rawConf = Number(form.confidence ?? DEFAULT_CONFIDENCE);
			out.confidence = Math.max(0, Math.min(100, Math.round(Number.isFinite(rawConf) ? rawConf : DEFAULT_CONFIDENCE)));
		}
	}
	if (qd.kind === "explain" && qd.committedAnswer !== undefined) {
		out.committed = qd.committedAnswer;
	}
}

export function buildQuestionAnswer(qd, form) {
	const answers = [];
	for (const idx of [...form.selected].sort((a, b) => a - b)) {
		const opt = qd.options[idx];
		if (opt) answers.push({ label: opt.label, value: opt.value, index: idx + 1 });
	}
	const dontKnow = Boolean(form.dontKnow);
	const out = {
		kind: qd.kind,
		tool: qd.tool,
		...(qd.questionType ? { questionType: qd.questionType } : {}),
		questionText: qd.question,
		options: qd.options.map((o, i) => ({ index: i + 1, label: o.label })),
		...(qd.optionOrder ? { optionOrder: qd.optionOrder } : {}),
		dontKnow,
		answers,
		answeredAt: new Date().toISOString(),
	};
	const other = form.otherSelected ? String(form.other ?? "").trim() : "";
	const text = qd.mode === "text" ? String(form.text ?? "").trim() : "";
	const thinking = String(form.thinking ?? "").trim();
	const readingThinking = String(form.readingThinking ?? "").trim();
	if (other) out.other = other;
	if (text) out.text = text;
	if (thinking) out.thinking = thinking;
	if (readingThinking) out.readingThinking = readingThinking;
	appendQuizOrExplainFields(out, qd, form, dontKnow, answers);
	return out;
}

export function buildDismissedAnswer(qd) {
	return {
		kind: qd.kind,
		tool: qd.tool,
		questionText: qd.question,
		dontKnow: false,
		answers: [],
		dismissed: true,
		answeredAt: new Date().toISOString(),
	};
}
