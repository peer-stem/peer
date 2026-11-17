import type { PlanTree } from "../core/contracts/plan.ts";
import type { LhMessage } from "../core/native-messages.ts";
import {
	getActiveMfnRuntime,
	ingestSettledTurnWithMfn,
	messageMemoryId,
	prepareTurnContextWithMfn,
	type RecalledMemory,
} from "../memory/mfn/index.ts";

export interface MfnTurnBridgeInput {
	chatId: string;
	priorMessages: readonly LhMessage[];
	appends: readonly LhMessage[];
	agentMessages: LhMessage[];
	tree?: PlanTree;
	stagedAutomatic: boolean;
}

export interface MfnTurnBridgeHandle {
	projectedMessages: LhMessage[];
	initialPersistBaseCount: number;
	committedPersistBaseCount: number;
	finish: (stamped: readonly LhMessage[], isAborted: boolean, dispatched?: boolean) => void;
}

export function isMfnRuntimeActive(): boolean {
	return getActiveMfnRuntime() !== null;
}

function findPredecessorMemoryId(chatId: string, priorMessages: readonly LhMessage[]): string | null {
	for (let i = priorMessages.length - 1; i >= 0; i--) {
		const msg = priorMessages[i]!;
		if (msg.role === "custom" && ["plan-block", "problem-dismissed", "compaction"].includes(msg.customType)) {
			continue;
		}
		return messageMemoryId(chatId, msg.id);
	}
	return null;
}

function scheduleSettledIngest(
	chatId: string,
	priorMessages: readonly LhMessage[],
	appends: readonly LhMessage[],
	stamped: readonly LhMessage[],
	recalledMemories: readonly RecalledMemory[],
): void {
	const runtime = getActiveMfnRuntime();
	if (!runtime) return;
	const settledMessages = [...appends, ...stamped];
	if (settledMessages.length === 0) return;
	const predecessorMemoryId = findPredecessorMemoryId(chatId, priorMessages);
	void ingestSettledTurnWithMfn({
		client: runtime.client,
		outbox: runtime.outbox,
		chatId,
		turnMessages: settledMessages,
		mainPoolId: runtime.mainPoolId,
		lexicalPoolId: runtime.lexicalPoolId,
		recalledMemories,
		predecessorMemoryId,
	}).catch((err) => {
		console.error(`[chat ${chatId}] MFN turn ingest failed:`, err);
	});
}

function buildFallbackBridge(input: MfnTurnBridgeInput, scheduleOnFinish: boolean): MfnTurnBridgeHandle {
	return {
		projectedMessages: input.agentMessages,
		initialPersistBaseCount: input.stagedAutomatic ? input.priorMessages.length : input.agentMessages.length,
		committedPersistBaseCount: input.agentMessages.length,
		finish: (stamped, isAborted, dispatched = true) => {
			if (!scheduleOnFinish || isAborted || !dispatched) return;
			scheduleSettledIngest(input.chatId, input.priorMessages, input.appends, stamped, []);
		},
	};
}

function buildProjectedBridge(
	input: MfnTurnBridgeInput,
	projected: LhMessage[],
	recalledMemories: readonly RecalledMemory[],
): MfnTurnBridgeHandle {
	const stagedTailCount = input.stagedAutomatic ? input.appends.length : 0;
	return {
		projectedMessages: projected,
		initialPersistBaseCount: Math.max(0, projected.length - stagedTailCount),
		committedPersistBaseCount: projected.length,
		finish: (stamped, isAborted, dispatched = true) => {
			if (isAborted || !dispatched) return;
			scheduleSettledIngest(input.chatId, input.priorMessages, input.appends, stamped, recalledMemories);
		},
	};
}

export async function prepareMfnTurnBridge(input: MfnTurnBridgeInput): Promise<MfnTurnBridgeHandle> {
	const runtime = getActiveMfnRuntime();
	if (!runtime) return buildFallbackBridge(input, false);
	try {
		const prepared = await prepareTurnContextWithMfn({
			client: runtime.client,
			chatId: input.chatId,
			messages: input.agentMessages,
			tree: input.tree,
			mainPoolId: runtime.mainPoolId,
			lexicalPoolId: runtime.lexicalPoolId,
			liveTailTokens: runtime.liveTailTokens,
		});
		return buildProjectedBridge(input, prepared.agentMessages, prepared.recalledMemories);
	} catch (err) {
		console.error(`[chat ${input.chatId}] MFN turn preparation failed; falling back to raw transcript:`, err);
		return buildFallbackBridge(input, true);
	}
}
