import { getMemberSession, type Session } from "./auth";
import { apiError } from "./http";
import { ConfirmMismatch, WriteError } from "./writes";

// Runs a route body for a signed-in caller and maps write-path errors to HTTP (docs/api-writes.yaml).
export async function route<T>(fn: (s: Session) => Promise<T>, statusOf: (result: T) => number = () => 200) {
  const s = await getMemberSession();
  if (!s) return apiError("unauthorized", "Sign in required");
  try {
    const result = await fn(s);
    return Response.json(result, { status: statusOf(result) });
  } catch (e) {
    if (e instanceof WriteError) return apiError(e.code, e.message);
    // R21: a stale confirm gets a fresh needs-confirmation payload, not the error shape.
    if (e instanceof ConfirmMismatch) return Response.json(e.payload, { status: 409 });
    // Anything else (e.g. a transaction that could not commit): it rolled back, so say so in the error shape.
    console.error("write route failed:", (e as Error)?.message);
    return apiError("server_error", "Something went wrong. Nothing was saved. Please try again.");
  }
}

// JSON body, or {} when it's missing or malformed (the write functions validate fields).
export const body = async (req: Request) => (await req.json().catch(() => ({}))) as Record<string, unknown>;

// 201 when a write saved something, 200 when it only asked for confirmation (a batch with saved: false too).
export const savedStatus = (r: object) => ((r as { saved?: boolean }).saved === true ? 201 : 200);

// Accepts true or "true", for clients that post forms.
export const flag = (v: unknown) => v === true || v === "true";
