import { CheckCircle2, Clock, Hourglass, NotebookPen } from "lucide-react";
import type { Session } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { visibleTo } from "@/lib/memories";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoutButton } from "../logout-button";
import { AddMemoryForm } from "./memory-forms";

const STATUS: Record<string, { label: string; style: string }> = {
  unverified: { label: "Waiting for family", style: "bg-secondary text-primary" },
  verified: { label: "Verified by family", style: "bg-success/10 text-success" },
  superseded: { label: "Updated by family", style: "bg-muted text-muted-foreground" },
  retracted: { label: "Not used", style: "bg-muted text-muted-foreground" },
};
// A deny sets status "retracted" with review.state "denied"; other retractions keep "Not used".
const DECLINED = { label: "Declined by family", style: "bg-muted text-muted-foreground" };
const fmt = (d?: Date | null) => d?.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
const panel = "rounded-2xl border-border/70 shadow-[0_20px_50px_-35px_rgba(80,40,50,0.35)]";

// Caregivers only add notes. They see what they themselves sent and whether family has checked it, nothing else.
export async function CaregiverView({ me, personName }: { me: Session; personName?: string }) {
  const notes = await (await getDb()).collection("memories")
    .find({ ...visibleTo(me), "source.user_id": me.user_id }, { projection: { text: 1, status: 1, "review.state": 1, created_at: 1, expires_at: 1 } })
    .sort({ created_at: -1 }).limit(20).toArray();

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Logo href="/dashboard" />
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-muted-foreground sm:inline">{me.name} · Caregiver</span>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-4 py-10 sm:px-6">
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">Care team space</p>
          <h1 className="font-serif text-5xl leading-tight">Care notes for <em className="text-primary">{personName}</em></h1>
          <p className="text-muted-foreground">Family checks each note before Keepsake treats it as fact.</p>
        </section>

        <Card className={panel}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-serif text-xl font-normal"><NotebookPen className="size-4 text-primary" aria-hidden /> Add a note</CardTitle>
          </CardHeader>
          <CardContent>
            <AddMemoryForm personName={personName} scopes={["caregiver"]} caregiver />
          </CardContent>
        </Card>

        <Card className={cn(panel, "gap-0 py-0")}>
          <CardHeader className="border-b px-6 py-5">
            <CardTitle className="font-serif text-2xl font-normal">Your recent notes</CardTitle>
            <CardDescription>What you&apos;ve sent, and whether family has checked it.</CardDescription>
          </CardHeader>
          {notes.length ? (
            <ul className="divide-y">
              {notes.map((n) => {
                const s = (n.status === "retracted" && n.review?.state === "denied" ? DECLINED : STATUS[n.status]) ?? { label: n.status, style: "bg-muted text-muted-foreground" };
                return (
                  <li key={n._id.toString()} className="space-y-2 px-6 py-4">
                    <p className="text-[15px]">{n.text}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <Badge className={cn("gap-1 rounded-full border-0", s.style)}>
                        {n.status === "verified" ? <CheckCircle2 aria-hidden /> : n.status === "unverified" ? <Hourglass aria-hidden /> : null}
                        {s.label}
                      </Badge>
                      <span>{fmt(n.created_at)}</span>
                      {n.expires_at && <span className="flex items-center gap-1"><Clock className="size-3" aria-hidden /> expires {fmt(n.expires_at)}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-6 py-10 text-center text-muted-foreground">You haven&apos;t added any notes yet.</p>
          )}
        </Card>
      </main>
    </div>
  );
}
