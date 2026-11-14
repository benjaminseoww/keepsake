import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { fakeDb } from "./fake-db";

// The token is trusted for user_id only: household and role always come from households.members.
process.env.AUTH_SECRET = "test-secret";
let f: ReturnType<typeof fakeDb>;
let token: string | undefined;
vi.mock("@/lib/db", () => ({ getDb: async () => f.db, getClient: async () => f.client }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => (token ? { value: token } : undefined) }) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));

const { getMemberSession, requireSession } = await import("@/lib/auth");
const { route } = await import("@/lib/api");

// What the user service signed at login: Anna as family in Margaret's household.
const sign = (claims: object) =>
  new SignJWT(claims as never).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode("test-secret"));

beforeEach(async () => {
  token = await sign({ user_id: "anna", name: "Anna", role: "family", person_id: "margaret" });
  f = fakeDb({
    households: [
      { person_id: "margaret", members: [{ user_id: "margaret", name: "Margaret", role: "person" }] },
      // Anna has since moved to Harold's household as a caregiver.
      { person_id: "harold", members: [{ user_id: "harold", name: "Harold", role: "person" }, { user_id: "anna", name: "Anna", role: "caregiver" }] },
    ],
  });
});

describe("household comes from households, not the token", () => {
  it("getMemberSession uses the current household and role", async () => {
    expect(await getMemberSession()).toEqual({ user_id: "anna", name: "Anna", role: "caregiver", person_id: "harold" });
  });

  it("requireSession applies the current role, so the old family role is refused", async () => {
    await expect(requireSession(["family"])).rejects.toThrow("redirect /dashboard");
    expect(await requireSession(["caregiver"])).toMatchObject({ person_id: "harold", role: "caregiver" });
  });

  it("API routes run as the current household", async () => {
    const res = await route(async (s) => s);
    expect(await res.json()).toMatchObject({ person_id: "harold", role: "caregiver" });
  });

  it("a member removed from every household is signed out everywhere", async () => {
    f.store.households = f.store.households.map((h) => ({ ...h, members: (h.members as { user_id: string }[]).filter((m) => m.user_id !== "anna") }));
    expect(await getMemberSession()).toBeNull();
    await expect(requireSession()).rejects.toThrow("redirect /login");
    expect((await route(async (s) => s)).status).toBe(401);
  });
});
