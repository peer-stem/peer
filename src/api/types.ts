import type { IncomingMessage, ServerResponse } from "node:http";

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type Params = Record<string, string | string[]>;
export type RouteHandler = (request: Request, context: { params: Promise<Params> }) => Response | Promise<Response>;

export interface RouteRecord {
	method: Method;
	pattern: string;
	handler: RouteHandler;
	file: string;
}

export type Dispatch = (request: Request) => Promise<Response>;
export type ServeHttp = (message: IncomingMessage, res: ServerResponse, dispatch: Dispatch) => Promise<void>;
