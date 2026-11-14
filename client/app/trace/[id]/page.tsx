import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, HelpCircle, MessageCircle, Replace } from "lucide-react";
import { requireSession } from "@/lib/auth";
import { getTurn, type TurnResult } from "@/lib/turns";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { FamilyShell } from "../shell";
import { DEGRADED, day, score, when } from "../format";

const SCOPE_STYLE: Record<string, string> = {
  family: "bg-secondary text-primary",
  caregiver: "bg-success/10 text-success",
};

function Memory({ r, rank }: { r: TurnResult; rank: number }) {
  // Snapshot status is what the agent saw; current_status shows if family has since changed it.
  const changed = r.current_status && r.current_status !== r.status;
  return (
    <li className="space-y-2 px-6 py-5">
      <div className="flex items-start gap-3">
        <span className="mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs text-muted-foreground">{rank}</span>
        <p className="font-serif text-xl leading-snug">{r.text}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 text-xs text-muted-foreground">
        <Badge className={cn("rounded-full border-0 capitalize", SCOPE_STYLE[r.scope])}>{r.scope}</Badge>
        <Badge variant="outline" className="rounded-full capitalize">{r.status}</Badge>
        <span>from {r.author_name ?? "unknown"} ({r.author_role})</span>
        <span>added {day(r.created_at)}</span>
        <span>rerank {score(r.rerank_score)} · vector {score(r.vector_score)}</span>
      </div>
      {changed && (
        <p className="ml-9 flex gap-2 rounded-xl bg-muted px-4 py-2 text-sm text-muted-foreground">
          <Replace className="mt-0.5 size-4 shrink-0" aria-hidden />
          Since {r.current_status} by family. Keepsake won&apos;t say this again.
        </p>
      )}
    </li>
  );
}

// One question: the answer, and the memories Keepsake was given for it, as they were at the time.
export default async function TurnPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireSession(["family"]);
  const turn = await getTurn(me, (await params).id);
  if (!turn) notFound();

  return (
    <FamilyShell me={me} active="trace">
      <Link href="/trace" className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All questions
      </Link>

      <div className="space-y-6">
        <section className="space-y-2">
          <p className="text-sm text-muted-foreground">{turn.asked_by.name ?? "Someone"} asked · {when(turn.at)}</p>
          <h1 className="font-serif text-4xl leading-tight">{turn.question}</h1>
          <p className="flex gap-2 pt-2 text-lg">
            <MessageCircle className="mt-1 size-5 shrink-0 text-primary" aria-hidden />
            <span>{turn.answer ?? <span className="text-muted-foreground">No answer recorded yet.</span>}</span>
          </p>
        </section>

        {!!turn.guidance.length && <Card className="p-6 space-y-3">
          <h2 className="font-medium">Conversation guidance used</h2>
          {turn.guidance.map((g) => <div key={g.topic}><p className="font-medium">{g.topic}</p><p className="text-sm">{g.guidance}</p><p className="text-xs text-muted-foreground">Set by {g.set_by.name}</p></div>)}
        </Card>}

        {turn.degraded && (
          <p role="status" className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {DEGRADED[turn.degraded]}
          </p>
        )}

        <Card className="gap-0 rounded-2xl border-border/70 py-0">
          <CardContent className="border-b px-6 py-4">
            <h2 className="font-medium">How did it know this?</h2>
            <p className="text-sm text-muted-foreground">
              Verified memories that scored at least {score(turn.min_rerank_score)} for this question, best first.
            </p>
          </CardContent>
          {turn.results.length ? (
            <ol className="divide-y">
              {turn.results.map((r, i) => <Memory key={r.memory_id} r={r} rank={i + 1} />)}
            </ol>
          ) : (
            <p className="flex gap-2 px-6 py-5 text-muted-foreground">
              <HelpCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {turn.top_rerank_score == null
                ? "No memory matched, so Keepsake said it wasn't sure."
                : `The closest memory scored ${score(turn.top_rerank_score)}, below the ${score(turn.min_rerank_score)} cutoff, so Keepsake said it wasn't sure.`}
            </p>
          )}
        </Card>
      </div>
    </FamilyShell>
  );
}
