import { body, flag, route, savedStatus } from "@/lib/api";
import { createMemory, listMemories, type FactInput } from "@/lib/writes";

// GET /api/memories: live memories the caller can read. Contract: docs/api-writes.yaml.
export async function GET(req: Request) {
  const status = new URL(req.url).searchParams.get("status") ?? undefined;
  return route(async (s) => ({ memories: await listMemories(s, status) }));
}

// POST /api/memories: family or caregiver adds a memory. 201 when saved, 200 when it needs confirmation first.
export async function POST(req: Request) {
  const b = await body(req);
  const input = {
    text: b.text as string | undefined, scope: b.scope as string | undefined, confirm: flag(b.confirm),
    confirm_supersedes: b.confirm_supersedes as string | undefined,
    // Confirm resend of a multi-fact note (A17): the split facts, each with its own confirm_supersedes.
    facts: Array.isArray(b.facts) ? (b.facts as FactInput[]) : undefined,
  };
  return route((s) => createMemory(s, input), savedStatus);
}
