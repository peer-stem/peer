import { externalCliStatusResponse, initAuthEnv } from "@/src/server";

/** Installation, version and model list only; never reads sign-in state or
 * makes a model request. `?id=` names the CLI. */
export async function GET(request: Request) {
	// Key provenance must exist before a CLI child environment is copied.
	initAuthEnv();
	return externalCliStatusResponse(request);
}
