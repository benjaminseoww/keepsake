import "server-only";

// Gemini REST client (A18). Plain fetch, no SDK dependency.
// The key is read from process.env on the server only and is never logged.
// Flash-lite: ~1s per note in the smoke test, same answers as flash. gemini-3.8-flash returned 503
// "high demand" and gemini-3.5-flash hit the free-tier daily quota (20 requests) during testing.
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
// Per attempt. A healthy call takes 2-6s; worst case with retries is about 3 x 8s + 1.4s.
export const GEMINI_TIMEOUT_MS = 8000;

export class GeminiError extends Error {
  constructor(public kind: "no_key" | "timeout" | "http" | "network" | "bad_output", message: string) {
    super(message);
    this.name = "GeminiError";
  }
}

// Calls generateContent with structured JSON output and returns the parsed object.
// Retries a timeout, network error or 429/5xx (Gemini returns 503 "high demand" often):
// 3 tries in total, with 400ms then 1000ms waits. Other errors fail straight away.
export const GEMINI_RETRY_DELAYS_MS = [400, 1000];
// A 429 for an exhausted daily quota is not retried; it won't clear in a second.
const retryable = (e: unknown) =>
  e instanceof GeminiError && (e.kind === "timeout" || e.kind === "network" ||
    (e.kind === "http" && /^Gemini (429|5\d\d)/.test(e.message) && !/quota/i.test(e.message)));

export async function generateJson<T>(prompt: string, responseSchema: object, timeoutMs = GEMINI_TIMEOUT_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await generateOnce<T>(prompt, responseSchema, timeoutMs);
    } catch (e) {
      if (!retryable(e) || attempt >= GEMINI_RETRY_DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, GEMINI_RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function generateOnce<T>(prompt: string, responseSchema: object, timeoutMs: number): Promise<T> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError("no_key", "GEMINI_API_KEY is not set");
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0, thinkingConfig: { thinkingLevel: "low" } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new GeminiError("timeout", `Gemini timed out after ${timeoutMs}ms`);
    throw new GeminiError("network", `Gemini request failed: ${err.message}`);
  }
  // The error body never contains the key, but keep it short anyway.
  if (!res.ok) throw new GeminiError("http", `Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeminiError("bad_output", "Gemini returned text that is not JSON");
  }
}
