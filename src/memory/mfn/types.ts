export type MfnDurability = "accepted" | "committed";

export type MfnResponseStatus =
	| "ok"
	| "accepted"
	| "pending"
	| "committed"
	| "partial"
	| "error";

export type MfnWorkflowState =
	| "pending"
	| "reconciling"
	| "committed"
	| "needs_attention"
	| "expired";

export interface MfnWireError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface MfnReceipt {
	store_generation: string;
	writer_epoch: string;
	sequence: number;
	operation_id: string;
	state: string;
}

export interface MfnTargetOutcome<TResult = unknown> {
	layer: number;
	state: string;
	result?: TResult;
	error?: MfnWireError | null;
	receipt?: MfnReceipt | null;
}

export interface MfnExecutionResult<TComposite = unknown, TOutcome = unknown> {
	operation_id?: string | null;
	workflow_state?: MfnWorkflowState | string;
	workflow_revision?: string | null;
	complete?: boolean;
	outcomes?: MfnTargetOutcome<TOutcome>[];
	readiness?: unknown;
	result?: TComposite;
}

export interface MfnRequestEnvelope<TPayload = Record<string, unknown>> {
	version: 2;
	request_id: string;
	operation: string;
	pool_id?: string;
	payload: TPayload;
	timeout_ms?: number;
	operation_id?: string;
	durability?: MfnDurability;
}

export interface MfnExecuteWireBody<TPayload = Record<string, unknown>> {
	request: MfnRequestEnvelope<TPayload>;
	target_layers?: number[];
}

export interface MfnExecuteResponse<TComposite = unknown, TOutcome = unknown> {
	version: 2;
	request_id: string;
	status: MfnResponseStatus;
	result?: MfnExecutionResult<TComposite, TOutcome> | null;
	receipts?: MfnReceipt[];
	error?: MfnWireError | null;
}

export interface MfnVectorSpace {
	id: string;
	dimensions: number;
	mode: "caller" | "hash_v1";
}

export interface MfnPoolPutPayload {
	capacity: number;
	vector_space?: MfnVectorSpace | null;
}

export interface MfnRetention {
	pinned?: boolean;
	expires_at_us?: number | null;
}

export interface MfnEmbedding {
	space_id: string;
	values: number[];
}

export interface MfnMemoryPutPayload {
	memory_id: string;
	content: string;
	embedding?: MfnEmbedding | null;
	tags?: string[];
	metadata?: Record<string, string>;
	retention?: MfnRetention;
}

export interface MfnMemorySearchPayload {
	query?: string;
	embedding?: MfnEmbedding;
	tags?: string[];
	top_k?: number;
	minimum_score?: number;
	start_memory_ids?: string[];
}

export interface LexicalSearchMatch {
	memory_id: string;
	score: number;
	content: string;
	tags: string[];
	metadata: Record<string, string>;
	created_at_us?: number;
}

export interface MfnSession {
	kind: "chat" | "room" | "scene" | "feed";
	id: string;
}

export interface TurnRecallLimits {
	top_k?: number;
	per_anchor?: number;
	themes?: number;
	anticipations?: number;
	min_semantic?: number;
}

export interface TurnRecallPayload {
	query: {
		text: string;
		context?: string | null;
	};
	session: MfnSession;
	actor?: { key: string } | null;
	scope?: { any?: string[][] };
	window?: {
		memory_ids: string[];
		score?: boolean;
	};
	exclude_memory_ids?: string[];
	limits?: TurnRecallLimits;
	weights?: {
		tags?: Record<string, number>;
	};
}

export type TurnDegradedReason =
	| "embedder"
	| "embedder_unavailable"
	| "layer1_error"
	| "layer2_error"
	| "layer3_error"
	| "layer4_error"
	| "layer5_error"
	| "neighborhood_truncated";

export interface RecalledMemoryActivation {
	cue: number;
	spread: number;
	strength: number;
	total: number;
	weight: number;
}

export interface RecalledMemoryEvidence {
	layer: number;
	rank: number;
	score: number;
	via?: string;
	edge?: string;
	weight?: number;
	depth?: number;
	subject_id?: string;
	pattern_id?: string;
}

export interface RecalledMemory {
	memory_id: string;
	content: string;
	tags: string[];
	metadata: Record<string, string>;
	created_at_us: number;
	activation: RecalledMemoryActivation;
	anchor_memory_id: string | null;
	evidence: RecalledMemoryEvidence[];
}

export interface RecalledTheme {
	pattern_id: string;
	label: string;
	summary: string;
	score: number;
	confidence: number;
	activation_count: number;
	members: string[];
}

export interface RecalledAnticipation {
	subject_id: string;
	label: string;
	confidence: number;
	evidence_count: number;
}

export interface RecalledAnticipations {
	actors: RecalledAnticipation[];
	entities: RecalledAnticipation[];
	topics: RecalledAnticipation[];
}

export interface TurnRecallLayerState {
	layer: number;
	state: "ok" | "error" | "skipped";
	ms: number;
	error: MfnWireError | null;
}

export interface TurnRecallResult {
	format_version?: 1;
	space_id?: string;
	memories: RecalledMemory[];
	themes: RecalledTheme[];
	anticipations: RecalledAnticipations;
	window_scores?: Record<string, number>;
	layers?: TurnRecallLayerState[];
	complete?: boolean;
	degraded?: TurnDegradedReason[];
}

export interface TurnIngestSubject {
	kind: "actor" | "entity";
	key: string;
	label: string;
}

export interface TurnIngestMemory {
	memory_id: string;
	content: string;
	tags?: string[];
	metadata?: Record<string, string>;
	retention?: MfnRetention;
	association_keys?: string[];
	subjects?: TurnIngestSubject[];
}

export interface TurnIngestDelivered {
	memory_id: string;
	anchor: string;
	used?: boolean;
	activation?: number;
}

export interface TurnIngestPayload {
	turn_id: string;
	session: MfnSession;
	occurred_at_us: number;
	predecessor_memory_id?: string | null;
	memories: TurnIngestMemory[];
	delivered?: TurnIngestDelivered[];
}

export interface TurnIngestGroupResult {
	group: {
		format_version: 1;
		turn_id: string;
		core: MfnWorkflowState;
		enrichment: "pending" | "complete" | "partial";
		children: unknown[];
		plan_summary: unknown;
	};
}
