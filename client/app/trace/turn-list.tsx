"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, ChevronRight, HelpCircle } from "lucide-react";
import type { TurnSummary } from "@/lib/turns";
import { Card } from "@/components/ui/card";
import { DEGRADED, score, when } from "./format";

const POLL_MS = 3000;

// Polls so a question she just asked appears on the family's screen without a refresh.
export function TurnList({ initial }: { initial: TurnSummary[] }) {
  const [turns, setTurns] = useState(initial);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/turns", { cache: "no-store" });
        if (res.ok && !stopped) setTurns((await res.json()).turns);
      } catch {
        // Offline for a moment; the next tick retries.
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  if (!turns.length) {
    return <p className="rounded-2xl border border-dashed px-6 py-10 text-center text-muted-foreground">No questions yet. When she asks something, it shows up here.</p>;
  }

  return (
    <ul className="space-y-3">
      {turns.map((t) => (
        <li key={t.id}>
          <Link href={`/trace/${t.id}`} className="group block rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            <Card className="flex-row items-center gap-4 rounded-2xl border-border/70 px-5 py-4 transition-colors group-hover:bg-muted/40">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-serif text-xl leading-snug">{t.question}</p>
                <p className="line-clamp-2 text-sm text-muted-foreground">{t.answer ?? "Waiting for the answer…"}</p>
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
                  <span>{when(t.at)}</span>
                  {t.result_count ? (
                    <span>{t.result_count} {t.result_count === 1 ? "memory" : "memories"} · best {score(t.top_rerank_score)}</span>
                  ) : (
                    <span className="flex items-center gap-1"><HelpCircle className="size-3" aria-hidden /> No memory matched</span>
                  )}
                  {t.degraded && (
                    <span className="flex items-center gap-1 text-destructive" title={DEGRADED[t.degraded]}>
                      <AlertTriangle className="size-3" aria-hidden /> degraded
                    </span>
                  )}
                </p>
              </div>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
