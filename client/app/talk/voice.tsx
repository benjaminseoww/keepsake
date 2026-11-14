"use client";

import { useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { Loader2, Mic, Square } from "lucide-react";
import { Card } from "@/components/ui/card";
import { FIRST_MESSAGE, PROMPT } from "@/lib/prompt";

// One conversation per page. The current turn collects the agent's spoken answer for the trace.
const convo = { conversationId: null as string | null, turnId: null as string | null, parts: new Map<string, string>() };

async function post(path: string, body: unknown) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

// recall is the agent's only tool in the MVP; the person doesn't add memories by voice (A16).
const clientTools = {
  recall: async ({ query }: { query: string }) => {
    const data = await post("/api/talk/recall", { query, conversation_id: convo.conversationId });
    if (data.turn_id) {
      convo.turnId = data.turn_id;
      convo.parts.clear();
    }
    return JSON.stringify(data);
  },
};

// Everything the agent says after a recall, until the next recall, is that turn's answer.
// Parts are keyed by response id, so streamed resends replace rather than repeat; the whole answer is sent each time.
function saveAnswer(message: string, key: string) {
  if (!convo.turnId) return;
  convo.parts.set(key, message);
  post(`/api/turns/${convo.turnId}/answer`, { answer: [...convo.parts.values()].join(" ") }).catch(() => {});
}

function Talk() {
  const [caption, setCaption] = useState("");
  const [error, setError] = useState("");
  const { startSession, endSession, status, isSpeaking } = useConversation({
    clientTools,
    onConnect: ({ conversationId }) => { convo.conversationId = conversationId; },
    onDisconnect: () => { convo.conversationId = null; convo.turnId = null; convo.parts.clear(); },
    onMessage: ({ message, source, response_id, event_id }) => {
      if (source !== "ai") return;
      setCaption(message);
      saveAnswer(message, response_id ?? String(event_id));
    },
    onError: (message) => setError(String(message)),
  });

  const live = status === "connected";
  const busy = status === "connecting";

  async function start() {
    setError("");
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setError("Please allow the microphone so I can hear you.");
    }
    const res = await fetch("/api/talk/session");
    if (!res.ok) return setError("I couldn't start. Please try again.");
    const { signedUrl, agentId, name, today, topic_guidance } = await res.json();
    const shared = {
      clientTools,
      dynamicVariables: { name, today, topic_guidance },
      overrides: { agent: { prompt: { prompt: PROMPT }, firstMessage: FIRST_MESSAGE } },
    };
    startSession(signedUrl ? { ...shared, signedUrl } : { ...shared, agentId });
  }

  return (
    <div className="flex w-full flex-col items-center gap-8">
      <div className="relative grid place-items-center">
        {live && (
          <span
            className={`absolute size-60 rounded-full bg-primary/15 ${isSpeaking ? "animate-ping" : "scale-110"} motion-reduce:animate-none`}
            aria-hidden
          />
        )}
        <button
          onClick={live ? endSession : start}
          disabled={busy}
          aria-pressed={live}
          className={`relative grid size-56 place-items-center rounded-full font-serif text-4xl text-primary-foreground shadow-[0_30px_70px_-25px_rgba(160,78,102,0.65)] outline-none transition-transform focus-visible:ring-[6px] focus-visible:ring-primary/30 active:scale-95 disabled:opacity-70 ${
            live ? "bg-foreground" : "bg-primary hover:scale-[1.03]"
          }`}
        >
          <span className="flex flex-col items-center gap-2">
            {busy ? <Loader2 className="size-10 animate-spin" aria-hidden /> : live ? <Square className="size-9" aria-hidden /> : <Mic className="size-10" aria-hidden />}
            {busy ? "One moment" : live ? "Stop" : "Talk to me"}
          </span>
        </button>
      </div>

      <p className="flex h-8 items-center gap-2 text-xl text-muted-foreground" aria-live="polite">
        {live && <span className={`size-2.5 rounded-full ${isSpeaking ? "bg-primary" : "bg-success"}`} aria-hidden />}
        {live ? (isSpeaking ? "Speaking…" : "I'm listening…") : "Press the button and ask me anything."}
      </p>

      {caption && live && (
        <Card className="w-full max-w-xl rounded-2xl border-0 bg-card/90 px-8 py-6 shadow-[0_24px_60px_-30px_rgba(80,40,50,0.35)]">
          <p className="font-serif text-3xl leading-snug" aria-live="polite">{caption}</p>
        </Card>
      )}
      {error && <p role="alert" className="max-w-md text-xl text-destructive">{error}</p>}
    </div>
  );
}

export function Voice() {
  return (
    <ConversationProvider>
      <Talk />
    </ConversationProvider>
  );
}
