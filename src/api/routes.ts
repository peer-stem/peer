import * as r01 from "@/src/api/handlers/activity/abort/route.ts";
import * as r02 from "@/src/api/handlers/activity/route.ts";
import * as r03 from "@/src/api/handlers/chat/route.ts";
import * as r04 from "@/src/api/handlers/chats/[id]/artifact-ui/route.ts";
import * as r05 from "@/src/api/handlers/chats/[id]/dismiss/route.ts";
import * as r06 from "@/src/api/handlers/chats/[id]/images/[snapshotId]/route.ts";
import * as r07 from "@/src/api/handlers/chats/[id]/markdown/route.ts";
import * as r08 from "@/src/api/handlers/chats/[id]/route.ts";
import * as r09 from "@/src/api/handlers/chats/[id]/settings/route.ts";
import * as r10 from "@/src/api/handlers/chats/[id]/side-chats/route.ts";
import * as r11 from "@/src/api/handlers/chats/[id]/side-chats/[threadId]/route.ts";
import * as r12 from "@/src/api/handlers/chats/[id]/side-chats/[threadId]/stop/route.ts";
import * as r13 from "@/src/api/handlers/chats/[id]/steer/route.ts";
import * as r14 from "@/src/api/handlers/chats/[id]/stream/route.ts";
import * as r15 from "@/src/api/handlers/chats/route.ts";
import * as r16 from "@/src/api/handlers/claude-code/route.ts";
import * as r17 from "@/src/api/handlers/custom-provider/route.ts";
import * as r18 from "@/src/api/handlers/events/route.ts";
import * as r19 from "@/src/api/handlers/external-cli/route.ts";
import * as r20 from "@/src/api/handlers/graph/costs/route.ts";
import * as r21 from "@/src/api/handlers/graph/coverage/extract/route.ts";
import * as r22 from "@/src/api/handlers/graph/import/route.ts";
import * as r23 from "@/src/api/handlers/graph/nodes/[id]/route.ts";
import * as r24 from "@/src/api/handlers/graph/positions/route.ts";
import * as r25 from "@/src/api/handlers/graph/render-settings/route.ts";
import * as r26 from "@/src/api/handlers/graph/route.ts";
import * as r27 from "@/src/api/handlers/graph/sources/route.ts";
import * as r27b from "@/src/api/handlers/graph/sources/folders/[id]/route.ts";
import * as r28 from "@/src/api/handlers/graph/status/route.ts";
import * as r29 from "@/src/api/handlers/jobs/route.ts";
import * as r30 from "@/src/api/handlers/keys/[id]/route.ts";
import * as r31 from "@/src/api/handlers/keys/route.ts";
import * as r32 from "@/src/api/handlers/models/route.ts";
import * as r33 from "@/src/api/handlers/plugins/[id]/assets/[...file]/route.ts";
import * as r34 from "@/src/api/handlers/plugins/[id]/call/route.ts";
import * as r35 from "@/src/api/handlers/plugins/[id]/documents/markdown/route.ts";
import * as r36 from "@/src/api/handlers/plugins/[id]/route.ts";
import * as r37 from "@/src/api/handlers/plugins/route.ts";
import * as r38 from "@/src/api/handlers/search/route.ts";
import * as r39 from "@/src/api/handlers/settings/import-learnharness/route.ts";
import * as r40 from "@/src/api/handlers/settings/prompts/route.ts";
import * as r41 from "@/src/api/handlers/settings/prompts/[...segment]/route.ts";
import * as r42 from "@/src/api/handlers/settings/route.ts";
import * as r43 from "@/src/api/handlers/settings/[section]/route.ts";
import * as r44 from "@/src/api/handlers/stt/token/route.ts";
import * as r45 from "@/src/api/handlers/stt/transcribe/route.ts";
import * as r46 from "@/src/api/handlers/subscriptions/browser/route.ts";
import * as r47 from "@/src/api/handlers/subscriptions/route.ts";
import * as r48 from "@/src/api/handlers/themes/[id]/route.ts";
import * as r49 from "@/src/api/handlers/themes/route.ts";
import * as r50 from "@/src/api/handlers/tts/speak/route.ts";
import * as r51 from "@/src/api/handlers/tts/voices/route.ts";
import type { Method, RouteHandler, RouteRecord } from "./types.ts";

const METHODS: readonly Method[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ROUTE_FILE_PREFIX = "src/api/handlers/";
const ROUTE_FILE_SUFFIX = "/route.ts";

type RouteModule = Partial<Record<Method, unknown>>;

const ROUTE_MODULES: readonly (readonly [string, RouteModule])[] = [
	["src/api/handlers/activity/abort/route.ts", r01],
	["src/api/handlers/activity/route.ts", r02],
	["src/api/handlers/chat/route.ts", r03],
	["src/api/handlers/chats/[id]/artifact-ui/route.ts", r04],
	["src/api/handlers/chats/[id]/dismiss/route.ts", r05],
	["src/api/handlers/chats/[id]/images/[snapshotId]/route.ts", r06],
	["src/api/handlers/chats/[id]/markdown/route.ts", r07],
	["src/api/handlers/chats/[id]/route.ts", r08],
	["src/api/handlers/chats/[id]/settings/route.ts", r09],
	["src/api/handlers/chats/[id]/side-chats/route.ts", r10],
	["src/api/handlers/chats/[id]/side-chats/[threadId]/route.ts", r11],
	["src/api/handlers/chats/[id]/side-chats/[threadId]/stop/route.ts", r12],
	["src/api/handlers/chats/[id]/steer/route.ts", r13],
	["src/api/handlers/chats/[id]/stream/route.ts", r14],
	["src/api/handlers/chats/route.ts", r15],
	["src/api/handlers/claude-code/route.ts", r16],
	["src/api/handlers/custom-provider/route.ts", r17],
	["src/api/handlers/events/route.ts", r18],
	["src/api/handlers/external-cli/route.ts", r19],
	["src/api/handlers/graph/costs/route.ts", r20],
	["src/api/handlers/graph/coverage/extract/route.ts", r21],
	["src/api/handlers/graph/import/route.ts", r22],
	["src/api/handlers/graph/nodes/[id]/route.ts", r23],
	["src/api/handlers/graph/positions/route.ts", r24],
	["src/api/handlers/graph/render-settings/route.ts", r25],
	["src/api/handlers/graph/route.ts", r26],
	["src/api/handlers/graph/sources/route.ts", r27],
	["src/api/handlers/graph/sources/folders/[id]/route.ts", r27b],
	["src/api/handlers/graph/status/route.ts", r28],
	["src/api/handlers/jobs/route.ts", r29],
	["src/api/handlers/keys/[id]/route.ts", r30],
	["src/api/handlers/keys/route.ts", r31],
	["src/api/handlers/models/route.ts", r32],
	["src/api/handlers/plugins/[id]/assets/[...file]/route.ts", r33],
	["src/api/handlers/plugins/[id]/call/route.ts", r34],
	["src/api/handlers/plugins/[id]/documents/markdown/route.ts", r35],
	["src/api/handlers/plugins/[id]/route.ts", r36],
	["src/api/handlers/plugins/route.ts", r37],
	["src/api/handlers/search/route.ts", r38],
	["src/api/handlers/settings/import-learnharness/route.ts", r39],
	["src/api/handlers/settings/prompts/route.ts", r40],
	["src/api/handlers/settings/prompts/[...segment]/route.ts", r41],
	["src/api/handlers/settings/route.ts", r42],
	["src/api/handlers/settings/[section]/route.ts", r43],
	["src/api/handlers/stt/token/route.ts", r44],
	["src/api/handlers/stt/transcribe/route.ts", r45],
	["src/api/handlers/subscriptions/browser/route.ts", r46],
	["src/api/handlers/subscriptions/route.ts", r47],
	["src/api/handlers/themes/[id]/route.ts", r48],
	["src/api/handlers/themes/route.ts", r49],
	["src/api/handlers/tts/speak/route.ts", r50],
	["src/api/handlers/tts/voices/route.ts", r51],
];

export function patternFromFile(file: string): string {
	if (file === "src/api/handlers/route.ts") return "/api";
	if (!file.startsWith(ROUTE_FILE_PREFIX) || !file.endsWith(ROUTE_FILE_SUFFIX)) {
		throw new Error(`Invalid API route file path: ${file}`);
	}
	const inner = file.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length);
	if (!inner || inner.startsWith("/") || inner.endsWith("/")) {
		throw new Error(`Invalid API route file path: ${file}`);
	}
	return `/api/${inner}`;
}

function deriveRoutes(entries: readonly (readonly [string, RouteModule])[]): readonly RouteRecord[] {
	const list: RouteRecord[] = [];
	for (const [file, mod] of entries) {
		const pattern = patternFromFile(file);
		for (const method of METHODS) {
			const fn = mod[method];
			if (typeof fn === "function") list.push({ method, pattern, handler: fn as RouteHandler, file });
		}
	}
	return list;
}

export const routes: readonly RouteRecord[] = deriveRoutes(ROUTE_MODULES);
