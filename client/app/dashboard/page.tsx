import Link from "next/link";
import type { WithId, Document, ObjectId } from "mongodb";
import { Check, Clock, Eraser, History, Link2, PencilLine, Plus, Replace, X } from "lucide-react";
import { requireSession } from "@/lib/auth";
import { loadGuidance } from "@/lib/guidance";
import { GuidanceForm } from "./guidance-form";
import { getDb } from "@/lib/db";
import { SCOPES, visibleTo } from "@/lib/memories";
import { careTeam } from "@/lib/users";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoutButton } from "../logout-button";
import { CaregiverView } from "./caregiver";
import { ConfirmButton } from "./confirm-button";
import { denyMemory, forgetMemory, verifyMemory } from "./actions";
import { AddMemoryForm, CorrectForm } from "./memory-forms";
import { readableScopes } from "@/lib/recall";

const VERBS: Record<string, string> = {
  write: "added", verify: "verified", approve: "approved", deny: "denied",
  correct: "corrected", forget: "forgot", expire: "expired", rescope: "rescoped",
};
const SCOPE_STYLE: Record<string, string> = {
  family: "bg-secondary text-primary",
  caregiver: "bg-success/10 text-success",
  private: "bg-muted text-muted-foreground",
};
const fmt = (d?: Date | null) => d?.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
const panel = "rounded-2xl border-border/70 shadow-[0_20px_50px_-35px_rgba(80,40,50,0.35)]";

export default async function DashboardPage() {
  // requireSession re-reads role and household from households.members on every request.
  const me = await requireSession(["family", "caregiver"]);
  const team = await careTeam(me);
  const person = team.find((p) => p.role === "person");
  // Caregivers only add notes; the review dashboard below is family-only.
  if (me.role === "caregiver") return <CaregiverView me={me} personName={person?.name} />;
  const guidance = await loadGuidance(me);

  const db = await getDb();
  const live = { ...visibleTo(me), status: { $in: ["unverified", "verified"] } };

  const [memories, activity] = await Promise.all([
    db.collection("memories").find(live, { projection: { embedding: 0 } }).sort({ created_at: -1 }).toArray(),
    db.collection("audit_log").find({ person_id: me.person_id, scope: { $in: SCOPES[me.role] } }).sort({ at: -1 }).limit(20).toArray(),
  ]);

  const names = Object.fromEntries(team.map((p) => [p.user_id, p.name]));
  const review = memories.filter((m) => m.status === "unverified" || m.flagged);
  const verified = memories.filter((m) => !review.includes(m));

  // Texts for review candidates, through the same visibility filter so nothing leaks via a candidate link.
  const candidateIds = review.flatMap((m) => (m.review?.candidates ?? []).map((c: { memory_id: ObjectId }) => c.memory_id));
  const candidates = candidateIds.length
    ? await db.collection("memories").find({ _id: { $in: candidateIds }, ...visibleTo(me) }, { projection: { text: 1 } }).toArray()
    : [];
  const textOf = Object.fromEntries(candidates.map((c) => [c._id.toString(), c.text]));

  const Memory = ({ m }: { m: WithId<Document> }) => {
    const id = m._id.toString();
    const inReview = review.includes(m);
    const replaces = m.review?.proposed_supersedes && textOf[m.review.proposed_supersedes.toString()];
    const related: string[] = (m.review?.candidates ?? [])
      .filter((c: { label: string; memory_id: ObjectId }) => c.label === "related" && textOf[c.memory_id.toString()])
      .map((c: { memory_id: ObjectId }) => textOf[c.memory_id.toString()]);

    return (
      <li className="space-y-3 px-6 py-5">
        <p className={cn(inReview ? "font-serif text-2xl leading-snug" : "text-[15px]")}>{m.text}</p>
        {replaces && (
          <p className="flex gap-2 rounded-xl bg-muted px-4 py-2.5 text-sm text-muted-foreground">
            <Replace className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>Would replace: <span className="line-through">{replaces}</span></span>
          </p>
        )}
        {related.map((t) => (
          <p key={t} className="flex gap-2 text-sm text-muted-foreground"><Link2 className="mt-0.5 size-4 shrink-0" aria-hidden /> Related: {t}</p>
        ))}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <Badge className={cn("rounded-full border-0 capitalize", SCOPE_STYLE[m.scope])}>{m.scope}</Badge>
          <span>from {names[m.source.user_id] ?? m.source.user_id}</span>
          <span>{fmt(m.created_at)}</span>
          {m.expires_at && <span className="flex items-center gap-1"><Clock className="size-3" aria-hidden /> expires {fmt(m.expires_at)}</span>}
          {m.supersedes && <span className="flex items-center gap-1"><PencilLine className="size-3" aria-hidden /> corrected</span>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {inReview && (
            <>
              <form action={verifyMemory}>
                <input type="hidden" name="id" value={id} />
                <Button size="sm" className="rounded-full"><Check /> {replaces ? "Approve and replace" : "Approve"}</Button>
              </form>
              <form action={denyMemory}>
                <input type="hidden" name="id" value={id} />
                <Button size="sm" variant="outline" className="rounded-full"><X /> Deny</Button>
              </form>
            </>
          )}
          <details>
            <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              <PencilLine className="size-4" aria-hidden /> Correct
            </summary>
            <CorrectForm id={id} text={m.text} />
          </details>
          <form action={forgetMemory}>
            <input type="hidden" name="id" value={id} />
            <ConfirmButton message="Forget this memory? This can't be undone." size="sm" variant="ghost" className="rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive">
              <Eraser /> Forget
            </ConfirmButton>
          </form>
        </div>
      </li>
    );
  };

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Logo href="/dashboard" />
            <nav className="flex gap-1">
              <span aria-current="page" className="rounded-full bg-secondary px-3 py-1.5 text-sm text-primary">Memories</span>
              <Link href="/trace" className="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">Trace</Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {me.name} · <span className="capitalize">{me.role}</span>
            </span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-4 py-10 sm:px-6">
        <section className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Family space
            </p>
            <h1 className="font-serif text-5xl leading-tight">{person?.name}&apos;s <em className="text-primary">memory</em></h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex -space-x-2">
              {team.map((p) => (
                <Avatar key={p.user_id} className="size-9 ring-2 ring-background" title={`${p.name} (${p.relation ?? p.role})`}>
                  <AvatarFallback className={cn("font-serif", p.role === "person" ? "bg-secondary text-primary" : p.role === "caregiver" ? "bg-success/10 text-success" : "bg-muted")}>
                    {p.name[0]}
                  </AvatarFallback>
                </Avatar>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              Care circle<br />
              <span className="text-foreground">{team.map((p) => p.name).join(", ")}</span>
            </p>
          </div>
        </section>

        <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-6">
            <Card className={cn(panel, "gap-0 py-0")}>
              <CardHeader className="flex flex-row items-center justify-between gap-4 border-b px-6 py-5">
                <div className="space-y-1">
                  <CardTitle className="font-serif text-2xl font-normal">Needs your review</CardTitle>
                  <CardDescription>New things {person?.name} or the care team mentioned. Nothing is treated as true until you approve it.</CardDescription>
                </div>
                <Badge className="rounded-full bg-primary px-2.5 text-primary-foreground">{review.length}</Badge>
              </CardHeader>
              {review.length ? (
                <ul className="divide-y">{review.map((m) => <Memory key={m._id.toString()} m={m} />)}</ul>
              ) : (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center text-muted-foreground">
                  <Check className="size-6 text-success" aria-hidden />
                  <p>You&apos;re all caught up.</p>
                </div>
              )}
            </Card>

            <Card className={cn(panel, "gap-0 py-0")}>
              <CardHeader className="flex flex-row items-center justify-between gap-4 border-b px-6 py-5">
                <div className="space-y-1">
                  <CardTitle className="font-serif text-2xl font-normal">Verified memories</CardTitle>
                  <CardDescription>What Keepsake can tell {person?.name}.</CardDescription>
                </div>
                <Badge variant="secondary" className="rounded-full px-2.5">{verified.length}</Badge>
              </CardHeader>
              <ul className="divide-y">{verified.map((m) => <Memory key={m._id.toString()} m={m} />)}</ul>
            </Card>
          </div>

          <aside className="space-y-6 lg:sticky lg:top-24">
            <Card className={panel}>
              <CardHeader>
                <CardTitle className="font-serif text-xl font-normal">Conversation guidance</CardTitle>
                <CardDescription>Help Keepsake respond gently to sensitive topics. Only family can edit. Changes apply from the next question.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {guidance.map((g) => <div key={g.topic} className="border-b pb-5"><GuidanceForm topic={g.topic} guidance={g.guidance} /></div>)}
                <details><summary className="cursor-pointer text-sm font-medium">Add a topic</summary><div className="pt-3"><GuidanceForm /></div></details>
              </CardContent>
            </Card>
            <Card className={panel}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-serif text-xl font-normal"><Plus className="size-4 text-primary" aria-hidden /> Add a memory</CardTitle>
              </CardHeader>
              <CardContent>
                <AddMemoryForm personName={person?.name} scopes={readableScopes(me.role)} />
              </CardContent>
            </Card>

            <Card className={panel}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 font-serif text-xl font-normal"><History className="size-4 text-primary" aria-hidden /> Activity</CardTitle>
                <CardDescription>Who changed what. The words themselves are never kept here.</CardDescription>
              </CardHeader>
              <CardContent>
                {activity.length ? (
                  <ol className="space-y-3 text-sm">
                    {activity.map((a) => (
                      <li key={a._id.toString()} className="flex gap-3">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
                        <span>
                          <span className="font-medium">{names[a.actor.user_id] ?? a.actor.user_id}</span> {a.action === "guidance" ? "updated conversation guidance" : `${VERBS[a.action] ?? a.action} a ${a.scope} memory`}
                          <span className="block text-xs text-muted-foreground">{fmt(a.at)}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : <p className="text-sm text-muted-foreground">No changes yet.</p>}
              </CardContent>
            </Card>
          </aside>
        </div>
      </main>
    </div>
  );
}
