import { afterEach, describe, expect, it, vi } from "vitest";
import { embed, withRetry, VoyageError } from "@/lib/voyage";

const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };
afterEach(() => { sleeps.length = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("withRetry (write path)", () => {
  it("retries a 429 and honours Retry-After", async () => {
    quiet();
    let n = 0;
    const r = await withRetry(async () => { if (n++ === 0) throw new VoyageError("http", "429", 429, 2000); return "ok"; }, "embed", { sleep });
    expect(r).toBe("ok");
    expect(sleeps).toEqual([2000]);
  });
  it("retries 5xx and timeouts with backoff, up to 3 tries", async () => {
    quiet();
    const fn = vi.fn(async () => { throw new VoyageError("http", "503", 503); });
    await expect(withRetry(fn, "rerank", { sleep })).rejects.toBeInstanceOf(VoyageError);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1500]);
  });
  it("does not retry a 400/401, or a non-Voyage error", async () => {
    quiet();
    const bad = vi.fn(async () => { throw new VoyageError("http", "401", 401); });
    await expect(withRetry(bad, "embed", { sleep })).rejects.toMatchObject({ status: 401 });
    expect(bad).toHaveBeenCalledTimes(1);
    const other = vi.fn(async () => { throw new Error("bug"); });
    await expect(withRetry(other, "embed", { sleep })).rejects.toThrow("bug");
    expect(other).toHaveBeenCalledTimes(1);
  });
  it("gives up when Retry-After would go past the budget (Voyage free tier asks for ~60s)", async () => {
    quiet();
    const fn = vi.fn(async () => { throw new VoyageError("http", "429", 429, 60_000); });
    await expect(withRetry(fn, "embed", { sleep })).rejects.toMatchObject({ status: 429 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
  it("logs the status and Voyage's message, not the API key", async () => {
    process.env.VOYAGE_API_KEY = "sk-secret-test";
    const log = quiet();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limit exceeded", { status: 429, headers: { "retry-after": "1" } })));
    await expect(withRetry(() => embed(["x"], "document"), "embed", { sleep, tries: 2 })).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
    expect(sleeps).toEqual([1000]);
    const out = JSON.stringify(log.mock.calls);
    expect(out).toContain("429");
    expect(out).toContain("rate limit exceeded");
    expect(out).not.toContain("sk-secret-test");
  });
});
