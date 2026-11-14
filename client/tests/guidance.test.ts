import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth";
import { fakeDb } from "./fake-db";

let f: ReturnType<typeof fakeDb>;
vi.mock("@/lib/db", () => ({ getDb: async () => f.db, getClient: async () => f.client }));
const { saveGuidance } = await import("@/lib/writes");
const { loadGuidance } = await import("@/lib/guidance");
const family: Session = { user_id: "family-a", name: "Family A", person_id: "household-a", role: "family" };
beforeEach(() => { f = fakeDb(); });

describe("family conversation guidance", () => {
  it("creates, updates and removes a topic without creating duplicate records", async () => {
    await saveGuidance(family, " Travel ", "Offer to talk about a favourite holiday.");
    await saveGuidance(family, "travel", "Offer a quiet activity.");
    expect(await loadGuidance(family)).toMatchObject([{ topic: "travel", guidance: "Offer a quiet activity.", set_by: { name: "Family A" } }]);
    expect(f.store.topic_guidance).toHaveLength(1);
    await saveGuidance(family, "travel", "");
    expect(await loadGuidance(family)).toEqual([]);
    expect(f.store.audit_log).toHaveLength(3);
    for (const a of f.store.audit_log) {
      expect(a.action).toBe("guidance");
      expect(a).not.toHaveProperty("guidance");
      expect(a).not.toHaveProperty("text");
    }
  });

  it("isolates households, including updates and deletion", async () => {
    const other = { ...family, person_id: "household-b" };
    await saveGuidance(family, "travel", "Offer a quiet activity.");
    expect(await loadGuidance(other)).toEqual([]);
    await saveGuidance(other, "travel", "Offer music.");
    await saveGuidance(other, "travel", "");
    expect(await loadGuidance(family)).toMatchObject([{ guidance: "Offer a quiet activity." }]);
  });

  it("allows the voice agent to read but only family to write; caregivers cannot read", async () => {
    await saveGuidance(family, "travel", "Offer music.");
    const person = { ...family, role: "person" as const };
    const caregiver = { ...family, role: "caregiver" as const };
    expect(await loadGuidance(person)).toHaveLength(1);
    await expect(loadGuidance(caregiver)).rejects.toThrow();
    for (const s of [person, caregiver]) await expect(saveGuidance(s, "travel", "Override")).rejects.toMatchObject({ code: "forbidden" });
    expect(f.store.audit_log).toHaveLength(1);
  });

  it("rolls back guidance if auditing fails", async () => {
    f.failNextInsert();
    await expect(saveGuidance(family, "travel", "Offer music.")).rejects.toThrow();
    expect(await loadGuidance(family)).toEqual([]);
  });

  it("rejects invalid input before writing", async () => {
    for (const [topic, guidance] of [["", "text"], ["x".repeat(101), "text"], ["topic", "x".repeat(2001)], ["topic", null]]) {
      await expect(saveGuidance(family, topic, guidance)).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(f.store.audit_log).toEqual([]);
  });
});
