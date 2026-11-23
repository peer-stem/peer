/** PR #62's single custom endpoint: discover/manual connect, offline pins,
 * and disconnect. Host boundaries and mutations live behind the server barrel. */
import { customProviderGet, customProviderMutation } from "@/src/server";

export const GET = customProviderGet;
export const POST = customProviderMutation;
export const PATCH = customProviderMutation;
export const DELETE = customProviderMutation;
