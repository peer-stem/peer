import type { LhViewMessage } from "../../../core/index.ts";

export function isSubagentSteer(message: LhViewMessage): boolean {
	return (message.metadata as { subagentResult?: unknown } | undefined)?.subagentResult != null;
}

export function newestLearnerTurnFrom(messages: readonly LhViewMessage[]): number {
	return messages.findLastIndex(
		(message) =>
			message.role === "user" &&
			!isSubagentSteer(message) &&
			message.parts.some((part) => part.type === "text" || part.type === "image"),
	);
}
