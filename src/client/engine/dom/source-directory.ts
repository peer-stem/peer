import type { OrganizationAction, SourceDirectory } from "../../../core/index.ts";

export async function fetchSourceDirectory(signal?: AbortSignal): Promise<SourceDirectory> {
	const response = await fetch("/api/graph/sources", { cache: "no-store", signal });
	if (!response.ok) throw new Error("Could not read folders.");
	return (await response.json()) as SourceDirectory;
}

export async function postSourceOrganizationAction(action: OrganizationAction): Promise<string | undefined> {
	const response = await fetch("/api/graph/sources", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(action),
	});
	const body = (await response.json()) as { createdFolderId?: unknown; error?: unknown };
	if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Could not save folders.");
	return typeof body.createdFolderId === "string" ? body.createdFolderId : undefined;
}
