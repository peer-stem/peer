import { pluginTransport } from "@/src/server";

export function GET() { return pluginTransport.list(); }
export function POST(request: Request) { return pluginTransport.refresh(request); }
