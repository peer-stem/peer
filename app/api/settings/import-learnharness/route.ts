import { runLearnHarnessImport } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
	const raw = await request.json().catch(() => null);
	const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { sourceDirectory?: unknown }) : null;
	if (!body || typeof body.sourceDirectory !== "string" || body.sourceDirectory.trim() === "") {
		return Response.json({ error: "sourceDirectory must be a non-empty string" }, { status: 400 });
	}
	try {
		const report = runLearnHarnessImport(body.sourceDirectory.trim());
		return Response.json(report, { status: 200 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	}
}
