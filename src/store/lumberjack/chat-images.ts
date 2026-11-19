import { createHash } from "node:crypto";
import type { ImageSnapshot } from "../../core/contracts.ts";
import type { LumberJackForest } from "./binding.ts";

export interface StoredImageRef {
	objectId: string;
	sha256: string;
	mimeType: ImageSnapshot["mimeType"];
	width: number;
	height: number;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

export function storeSessionImageObject(
	forest: LumberJackForest,
	currentRefs: Record<string, StoredImageRef> | undefined,
	snapshotId: string,
	image: ImageSnapshot,
): { nextRefs: Record<string, StoredImageRef>; existed: boolean } {
	const digest = createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
	if (!SHA256_RE.test(snapshotId) || digest !== snapshotId) {
		throw new Error("Invalid image snapshot identity");
	}
	const receipt = forest.putObject(snapshotId, image.mimeType, image.data);
	const nextRefs: Record<string, StoredImageRef> = {
		...currentRefs,
		[snapshotId]: {
			objectId: receipt.id,
			sha256: snapshotId,
			mimeType: image.mimeType,
			width: image.width,
			height: image.height,
		},
	};
	return { nextRefs, existed: receipt.existed };
}

export function hydrateSessionImages(
	forest: LumberJackForest,
	refs?: Record<string, StoredImageRef>,
): Record<string, ImageSnapshot> | undefined {
	if (!refs) return undefined;
	const keys = Object.keys(refs);
	if (keys.length === 0) return undefined;
	const out: Record<string, ImageSnapshot> = {};
	for (const snapshotId of keys) {
		const ref = refs[snapshotId]!;
		const objectId = ref.objectId ?? ref.sha256;
		const obj = forest.getObject(objectId);
		if (obj.found && obj.data_base64 !== undefined) {
			out[snapshotId] = {
				mimeType: ref.mimeType,
				data: obj.data_base64,
				width: ref.width,
				height: ref.height,
			};
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
