import * as r01 from "@/app/api/activity/abort/route.ts";
import * as r02 from "@/app/api/activity/route.ts";
import * as r03 from "@/app/api/chat/route.ts";
import * as r04 from "@/app/api/chats/[id]/artifact-ui/route.ts";
import * as r05 from "@/app/api/chats/[id]/dismiss/route.ts";
import * as r06 from "@/app/api/chats/[id]/images/[snapshotId]/route.ts";
import * as r07 from "@/app/api/chats/[id]/markdown/route.ts";
import * as r08 from "@/app/api/chats/[id]/route.ts";
import * as r09 from "@/app/api/chats/[id]/settings/route.ts";
import * as r10 from "@/app/api/chats/[id]/side-chats/route.ts";
import * as r11 from "@/app/api/chats/[id]/side-chats/[threadId]/route.ts";
import * as r12 from "@/app/api/chats/[id]/side-chats/[threadId]/stop/route.ts";
import * as r13 from "@/app/api/chats/[id]/steer/route.ts";
import * as r14 from "@/app/api/chats/[id]/stream/route.ts";
import * as r15 from "@/app/api/chats/route.ts";
import * as r16 from "@/app/api/claude-code/route.ts";
import * as r17 from "@/app/api/custom-provider/route.ts";
import * as r18 from "@/app/api/events/route.ts";
import * as r19 from "@/app/api/external-cli/route.ts";
import * as r20 from "@/app/api/graph/costs/route.ts";
import * as r21 from "@/app/api/graph/coverage/extract/route.ts";
import * as r22 from "@/app/api/graph/import/route.ts";
import * as r23 from "@/app/api/graph/nodes/[id]/route.ts";
import * as r24 from "@/app/api/graph/positions/route.ts";
import * as r25 from "@/app/api/graph/render-settings/route.ts";
import * as r26 from "@/app/api/graph/route.ts";
import * as r27 from "@/app/api/graph/sources/route.ts";
import * as r28 from "@/app/api/graph/status/route.ts";
import * as r29 from "@/app/api/jobs/route.ts";
import * as r30 from "@/app/api/keys/[id]/route.ts";
import * as r31 from "@/app/api/keys/route.ts";
import * as r32 from "@/app/api/models/route.ts";
import * as r33 from "@/app/api/plugins/[id]/assets/[...file]/route.ts";
import * as r34 from "@/app/api/plugins/[id]/call/route.ts";
import * as r35 from "@/app/api/plugins/[id]/documents/markdown/route.ts";
import * as r36 from "@/app/api/plugins/[id]/route.ts";
import * as r37 from "@/app/api/plugins/route.ts";
import * as r38 from "@/app/api/search/route.ts";
import * as r39 from "@/app/api/settings/prompts/route.ts";
import * as r40 from "@/app/api/settings/prompts/[...segment]/route.ts";
import * as r41 from "@/app/api/settings/route.ts";
import * as r42 from "@/app/api/settings/[section]/route.ts";
import * as r43 from "@/app/api/stt/token/route.ts";
import * as r44 from "@/app/api/stt/transcribe/route.ts";
import * as r45 from "@/app/api/subscriptions/browser/route.ts";
import * as r46 from "@/app/api/subscriptions/route.ts";
import * as r47 from "@/app/api/themes/[id]/route.ts";
import * as r48 from "@/app/api/themes/route.ts";
import * as r49 from "@/app/api/tts/speak/route.ts";
import * as r50 from "@/app/api/tts/voices/route.ts";
import type { Method, RouteHandler, RouteRecord } from "./types.ts";

const METHODS: readonly Method[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ROUTE_FILE_PREFIX = "app/api/";
const ROUTE_FILE_SUFFIX = "/route.ts";

type RouteModule = Partial<Record<Method, unknown>>;

const ROUTE_MODULES: readonly (readonly [string, RouteModule])[] = [
	["app/api/activity/abort/route.ts", r01],
	["app/api/activity/route.ts", r02],
	["app/api/chat/route.ts", r03],
	["app/api/chats/[id]/artifact-ui/route.ts", r04],
	["app/api/chats/[id]/dismiss/route.ts", r05],
	["app/api/chats/[id]/images/[snapshotId]/route.ts", r06],
	["app/api/chats/[id]/markdown/route.ts", r07],
	["app/api/chats/[id]/route.ts", r08],
	["app/api/chats/[id]/settings/route.ts", r09],
	["app/api/chats/[id]/side-chats/route.ts", r10],
	["app/api/chats/[id]/side-chats/[threadId]/route.ts", r11],
	["app/api/chats/[id]/side-chats/[threadId]/stop/route.ts", r12],
	["app/api/chats/[id]/steer/route.ts", r13],
	["app/api/chats/[id]/stream/route.ts", r14],
	["app/api/chats/route.ts", r15],
	["app/api/claude-code/route.ts", r16],
	["app/api/custom-provider/route.ts", r17],
	["app/api/events/route.ts", r18],
	["app/api/external-cli/route.ts", r19],
	["app/api/graph/costs/route.ts", r20],
	["app/api/graph/coverage/extract/route.ts", r21],
	["app/api/graph/import/route.ts", r22],
	["app/api/graph/nodes/[id]/route.ts", r23],
	["app/api/graph/positions/route.ts", r24],
	["app/api/graph/render-settings/route.ts", r25],
	["app/api/graph/route.ts", r26],
	["app/api/graph/sources/route.ts", r27],
	["app/api/graph/status/route.ts", r28],
	["app/api/jobs/route.ts", r29],
	["app/api/keys/[id]/route.ts", r30],
	["app/api/keys/route.ts", r31],
	["app/api/models/route.ts", r32],
	["app/api/plugins/[id]/assets/[...file]/route.ts", r33],
	["app/api/plugins/[id]/call/route.ts", r34],
	["app/api/plugins/[id]/documents/markdown/route.ts", r35],
	["app/api/plugins/[id]/route.ts", r36],
	["app/api/plugins/route.ts", r37],
	["app/api/search/route.ts", r38],
	["app/api/settings/prompts/route.ts", r39],
	["app/api/settings/prompts/[...segment]/route.ts", r40],
	["app/api/settings/route.ts", r41],
	["app/api/settings/[section]/route.ts", r42],
	["app/api/stt/token/route.ts", r43],
	["app/api/stt/transcribe/route.ts", r44],
	["app/api/subscriptions/browser/route.ts", r45],
	["app/api/subscriptions/route.ts", r46],
	["app/api/themes/[id]/route.ts", r47],
	["app/api/themes/route.ts", r48],
	["app/api/tts/speak/route.ts", r49],
	["app/api/tts/voices/route.ts", r50],
];

export function patternFromFile(file: string): string {
	if (file === "app/api/route.ts") return "/api";
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
