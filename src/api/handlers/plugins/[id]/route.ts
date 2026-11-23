import { pluginTransport } from "@/src/server";

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
	return pluginTransport.setEnabled((await context.params).id, request);
}
