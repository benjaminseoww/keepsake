import { beforeEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";
import { fakeDb } from "./fake-db";

// Login and care team, ported from the old backend/ user service tests.
const SECRET = "test-secret-test-secret-test-secret-123";
process.env.AUTH_SECRET = SECRET;
// Demo password "keepsake" (same hash as db/seed.py).
const SEED_HASH = "$2b$10$OwUnGqFauqbAzW8RROu5M.1cVcMbd1ZrVxJvdXg13n74VvWsoys9m";
const PASSWORD = "keepsake";

let f: ReturnType<typeof fakeDb>;
vi.mock("@/lib/db", () => ({ getDb: async () => f.db, getClient: async () => f.client }));

const { login, careTeam } = await import("@/lib/users");

// "former" has a login but no household: their access was removed.
const logins = ["margaret", "anna", "ravi", "harold", "former"];

beforeEach(() => {
  f = fakeDb({
    people: logins.map((u) => ({ user_id: u, email: `${u}@keepsake.test`, password_hash: SEED_HASH })),
    households: [
      {
        person_id: "margaret",
        members: [
          { user_id: "ravi", name: "Ravi", role: "caregiver", shift: "weekday mornings" },
          { user_id: "anna", name: "Anna", role: "family", relation: "daughter", admin: true },
          { user_id: "margaret", name: "Margaret", role: "person" },
        ],
      },
      { person_id: "harold", members: [{ user_id: "harold", name: "Harold", role: "person" }] },
    ],
  });
});

describe("login", () => {
  it("returns a token and the user, with role and household from households", async () => {
    const res = await login("Anna@Keepsake.test ", PASSWORD);
    expect(res).toMatchObject({ ok: true, user: { user_id: "anna", name: "Anna", role: "family", person_id: "margaret" } });
    expect(JSON.stringify(res)).not.toContain("password_hash");
  });

  it("signs a token that getSession can verify, valid for 7 days", async () => {
    const res = await login("ravi@keepsake.test", PASSWORD);
    if (!res.ok) throw new Error("login failed");
    const { payload } = await jwtVerify(res.token, new TextEncoder().encode(SECRET));
    expect(payload).toMatchObject({ user_id: "ravi", name: "Ravi", role: "caregiver", person_id: "margaret", sub: "ravi" });
    expect(payload.exp! - payload.iat!).toBe(7 * 24 * 60 * 60);
  });

  it.each([
    ["wrong password", "anna@keepsake.test", "nope"],
    ["unknown email", "nobody@keepsake.test", PASSWORD],
  ])("rejects %s with the same generic error", async (_label, email, password) => {
    expect(await login(email, password)).toEqual({ ok: false, error: "invalid_credentials" });
  });

  it("refuses a login with no household", async () => {
    expect(await login("former@keepsake.test", PASSWORD)).toEqual({ ok: false, error: "no_household" });
  });

  it("refuses a member removed from their household", async () => {
    f.store.households = f.store.households.map((h) => ({
      ...h, members: (h.members as { user_id: string }[]).filter((m) => m.user_id !== "ravi"),
    }));
    expect(await login("ravi@keepsake.test", PASSWORD)).toEqual({ ok: false, error: "no_household" });
  });
});

describe("careTeam", () => {
  it("lists the caller's household, sorted by role then name, without credentials", async () => {
    const team = await careTeam({ user_id: "anna", name: "Anna", role: "family", person_id: "margaret" });
    expect(team.map((m) => m.user_id)).toEqual(["margaret", "anna", "ravi"]);
    expect(team[2]).toEqual({ user_id: "ravi", name: "Ravi", role: "caregiver", relation: undefined, shift: "weekday mornings" });
    expect(JSON.stringify(team)).not.toMatch(/admin|email|password/);
  });

  it("never returns another household", async () => {
    const team = await careTeam({ user_id: "harold", name: "Harold", role: "person", person_id: "harold" });
    expect(team.map((m) => m.user_id)).toEqual(["harold"]);
  });
});
