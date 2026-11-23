import { pluginTransport } from "@/src/server";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
	return pluginTransport.call((await context.params).id, request);
}
