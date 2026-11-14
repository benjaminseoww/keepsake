// Voyage AI client: embeddings for storage and search, rerank for ordering search hits.
// One documented constant set (R12): voyage-3.5, 1024 dims, cosine; input_type document on write, query on recall.

export const EMBED_MODEL = "voyage-3.5";
export const RERANK_MODEL = "rerank-2.5";

// Recall runs inside a live voice turn, so callers fail fast instead of retrying.
export const EMBED_TIMEOUT_MS = 3000;
export const RERANK_TIMEOUT_MS = 2000;

export type InputType = "document" | "query";
export type Reranked = { index: number; relevance_score: number };

// kind "timeout": we aborted. "http": Voyage answered with a non-2xx status (429, 5xx, or a 4xx bug/bad key).
// "network": the request never got an answer.
export class VoyageError extends Error {
  constructor(public kind: "timeout" | "http" | "network", message: string, public status?: number, public retryAfterMs?: number) {
    super(message);
    this.name = "VoyageError";
  }
}

async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://api.voyageai.com/v1/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new VoyageError("timeout", `Voyage ${path} timed out after ${timeoutMs}ms`);
    }
    throw new VoyageError("network", `Voyage ${path} failed: ${err.message}`);
  }
  if (!res.ok) throw new VoyageError("http", `Voyage ${path} ${res.status}: ${await res.text()}`, res.status, retryAfter(res.headers.get("retry-after")));
  return res.json() as Promise<T>;
}

// Retry-After is seconds or an HTTP date.
function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(h) - Date.now();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

// For the write path only (recall still fails fast). Retries 429, 5xx, timeouts and network errors:
// up to 3 tries, waiting Retry-After when Voyage sends it, else 0.5s then 1.5s. Gives up when the
// next wait would take the total past budgetMs. Logs every failure (status and Voyage's message, never the key).
export type RetryOpts = { tries?: number; budgetMs?: number; sleep?: (ms: number) => Promise<void> };
export async function withRetry<T>(fn: () => Promise<T>, label: string, opts: RetryOpts = {}): Promise<T> {
  const tries = opts.tries ?? 3, budget = opts.budgetMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = Date.now();
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof VoyageError)) throw e;
      console.error(`voyage ${label} failed (try ${i}/${tries}):`, e.kind, e.status ?? "", e.message.slice(0, 300));
      const retryable = e.kind !== "http" || e.status === 429 || (e.status ?? 0) >= 500;
      const wait = e.retryAfterMs ?? (i === 1 ? 500 : 1500);
      if (!retryable || i >= tries || Date.now() - start + wait > budget) throw e;
      await sleep(wait);
    }
  }
}

// Returns one 1024-dim vector per input text, in input order.
export async function embed(texts: string[], input_type: InputType, timeoutMs = EMBED_TIMEOUT_MS): Promise<number[][]> {
  const { data } = await call<{ data: { index: number; embedding: number[] }[] }>(
    "embeddings", { input: texts, model: EMBED_MODEL, input_type }, timeoutMs,
  );
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Scores each doc against the query; returns the top_k, best first. index points into docs.
export async function rerank(query: string, docs: string[], top_k: number, timeoutMs = RERANK_TIMEOUT_MS): Promise<Reranked[]> {
  if (!docs.length) return [];
  const { data } = await call<{ data: Reranked[] }>(
    "rerank", { query, documents: docs, model: RERANK_MODEL, top_k: Math.min(top_k, docs.length) }, timeoutMs,
  );
  return data;
}
