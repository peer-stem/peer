import { voicesResponse } from "@/src/server";

/** The configured speech endpoint's voices, for the settings picker. */
export async function GET() {
	return voicesResponse();
}
