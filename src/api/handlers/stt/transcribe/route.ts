import { transcribeResponse } from "@/src/server";

/** Local dictation: one recorded chunk (audio/wav) in, its transcript out. */
export async function POST(request: Request) {
	return transcribeResponse(request);
}
