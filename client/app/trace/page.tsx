import { requireSession } from "@/lib/auth";
import { listTurns } from "@/lib/turns";
import { FamilyShell } from "./shell";
import { TurnList } from "./turn-list";

// "How did it know this?": every question she asked the voice agent. Family only (D-A2).
export default async function TracePage() {
  const me = await requireSession(["family"]);
  const turns = await listTurns(me);

  return (
    <FamilyShell me={me} active="trace">
      <div className="mb-6 space-y-1">
        <h1 className="font-serif text-4xl">Trace</h1>
        <p className="text-muted-foreground">What she asked, what Keepsake said, and the memories behind each answer.</p>
      </div>
      <TurnList initial={turns} />
    </FamilyShell>
  );
}
