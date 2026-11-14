"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { saveGuidance, type FormState } from "./actions";

export function GuidanceForm({ topic = "", guidance = "" }: { topic?: string; guidance?: string }) {
  const [state, action, pending] = useActionState(saveGuidance, { kind: "idle" } as FormState);
  return (
    <form action={action} className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span>Topic</span>
        <input name="topic" aria-label="Topic" defaultValue={topic} readOnly={!!topic} required maxLength={100}
          placeholder="A topic that may be upsetting" className="w-full rounded-lg border bg-background p-2" />
      </label>
      <label className="block space-y-1 text-sm">
        <span>How should Keepsake respond?</span>
        <textarea name="guidance" defaultValue={guidance} maxLength={2000} rows={4}
          placeholder="Describe a gentle way to respond or change the subject. Add personal facts as verified memories."
          className="w-full rounded-lg border bg-background p-2" />
      </label>
      {topic && <p className="text-xs text-muted-foreground">Clear the guidance and save to remove this topic.</p>}
      <Button disabled={pending} size="sm" className="rounded-full">{pending ? "Saving…" : "Save guidance"}</Button>
      {(state.kind === "saved" || state.kind === "error") && <p role={state.kind === "error" ? "alert" : "status"} className="text-sm">{state.message}</p>}
    </form>
  );
}
