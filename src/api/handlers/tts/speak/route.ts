import { speakResponse } from "@/src/server";

/** Spoken replies: text in, the configured speech endpoint's audio out. */
export async function POST(request: Request) {
	return speakResponse(request);
}
