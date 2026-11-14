"use client";

import { useActionState, useState } from "react";
import { Replace } from "lucide-react";
import type { Scope } from "@/lib/memories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { addMemory, correctMemory, type FormState } from "./actions";

const idle: FormState = { kind: "idle" };
const select = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

// A6: before a family write replaces a memory, show which one and ask. "Yes" resends with confirm_supersedes (R21).
function ConfirmSupersede({ state, action, pending, hidden, onCancel }: {
  state: Extract<FormState, { kind: "confirm" }>; action: (f: FormData) => void; pending: boolean; hidden?: Record<string, string>; onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-labelledby="supersede-q" className="space-y-3 rounded-xl border border-primary/30 bg-secondary/60 p-4">
      <p id="supersede-q" className="font-medium">Are you sure? This will supersede:</p>
      <p className="flex gap-2 text-sm">
        <Replace className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <span><span className="line-through">{state.old.text}</span> <span className="text-muted-foreground">(from {state.old.author_name})</span></span>
      </p>
      <form action={action} className="flex flex-wrap gap-2">
        {Object.entries({ ...hidden, text: state.text, ...(state.scope && { scope: state.scope }), confirm: "true", confirm_supersedes: state.old.memory_id })
          .map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
        <Button size="sm" className="rounded-full" disabled={pending}>Yes, replace it</Button>
        <Button size="sm" variant="ghost" className="rounded-full" type="button" onClick={onCancel}>Cancel</Button>
      </form>
    </div>
  );
}

// Multi-fact note with conflicts: one "This will supersede" line per conflicting fact, one confirm for all.
function ConfirmBatch({ state, action, pending }: { state: Extract<FormState, { kind: "confirm_batch" }>; action: (f: FormData) => void; pending: boolean }) {
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm font-medium">Are you sure? This note has {state.facts.length} facts:</p>
      <ul className="space-y-2 text-sm">
        {state.facts.map((f, i) => {
          const c = state.conflicts.find((x) => x.text === f.text);
          return (
            <li key={i}>
              {f.text}
              {c && <span className="block text-muted-foreground">This will supersede <span className="line-through">{c.old.text}</span> (from {c.old.author_name})</span>}
            </li>
          );
        })}
      </ul>
      <input type="hidden" name="facts" value={JSON.stringify(state.facts)} />
      <input type="hidden" name="facts_token" value={state.facts_token} />
      <input type="hidden" name="confirm" value="true" />
      {state.scope && <input type="hidden" name="scope" value={state.scope} />}
      <Button size="sm" className="rounded-full" disabled={pending}>Yes, save all</Button>
    </form>
  );
}

function Status({ state }: { state: FormState }) {
  if (state.kind === "saved") return <p role="status" className="text-sm text-success">{state.message}</p>;
  if (state.kind === "error") return <p role="alert" className="text-sm text-destructive">{state.message}</p>;
  return null;
}

// The confirm prompt shows until the writer answers it; Cancel goes back to the form with nothing saved.
function useConfirmable(action: typeof addMemory) {
  const [state, run, pending] = useActionState(action, idle);
  const [cancelled, setCancelled] = useState<FormState | null>(null);
  const asking = state.kind === "confirm" && state !== cancelled ? state : null;
  return { state: asking ? state : state === cancelled ? idle : state, asking, run, pending, cancel: () => setCancelled(state) };
}

// Family add form (with a scope picker) or caregiver note form (always caregiver scope).
export function AddMemoryForm({ personName, scopes, caregiver }: { personName?: string; scopes: Scope[]; caregiver?: boolean }) {
  const { state, asking, run: action, pending, cancel } = useConfirmable(addMemory);
  if (asking) return <ConfirmSupersede state={asking} action={action} pending={pending} onCancel={cancel} />;
  if (state.kind === "confirm_batch") return <ConfirmBatch state={state} action={action} pending={pending} />;

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="new-text">{caregiver ? `What should ${personName} know?` : `What should ${personName} remember?`}</Label>
        <Textarea id="new-text" name="text" required rows={3} placeholder={caregiver ? "Reading glasses are on the bedside table now" : "Her daughter is bringing dinner at 6 tonight"} />
      </div>
      {!caregiver && (
        <div className="grid gap-2">
          <Label htmlFor="new-scope">Who can see it</Label>
          <select id="new-scope" name="scope" className={select}>
            {scopes.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Status state={state} />
        <Button className="ml-auto rounded-full px-6" disabled={pending}>{caregiver ? "Add note" : "Add memory"}</Button>
      </div>
    </form>
  );
}

// Inline correction of one verified memory (family only).
export function CorrectForm({ id, text }: { id: string; text: string }) {
  const { state, asking, run: action, pending, cancel } = useConfirmable(correctMemory);
  if (asking) return <div className="mt-2 sm:w-[28rem]"><ConfirmSupersede state={asking} action={action} pending={pending} hidden={{ id }} onCancel={cancel} /></div>;

  return (
    <form action={action} className="mt-2 flex w-full flex-wrap gap-2 sm:w-[28rem]">
      <input type="hidden" name="id" value={id} />
      <Input name="text" defaultValue={text} required aria-label="Corrected text" className="min-w-0 flex-1" />
      <Button size="sm" className="h-9 rounded-full" disabled={pending}>Save</Button>
      <Status state={state} />
    </form>
  );
}
