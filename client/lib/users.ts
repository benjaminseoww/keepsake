import "server-only";
import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { getDb } from "./db";
import type { Role, Session } from "./auth";

// Accounts: people is auth only (email + bcrypt hash); households.members owns role and household.

type PersonDoc = { user_id: string; email: string; password_hash: string };
type Member = { user_id: string; name: string; role: Role; relation?: string; shift?: string };
type HouseholdDoc = { person_id: string; members: Member[] };

export type TeamMember = { user_id: string; name: string; role: Role; relation?: string; shift?: string };
export type LoginResult =
  | { ok: true; token: string; user: Session }
  | { ok: false; error: "invalid_credentials" | "no_household" };

const TOKEN_TTL = "7d"; // same lifetime as the keepsake_session cookie
const ROLE_ORDER: Record<Role, number> = { person: 0, family: 1, caregiver: 2 };
// Compared against when the email is unknown, so a miss costs the same as a wrong password.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export const signSession = ({ user_id, name, role, person_id }: Session) =>
  new SignJWT({ user_id, name, role, person_id })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user_id)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(new TextEncoder().encode(process.env.AUTH_SECRET));

export async function login(email: string, password: string): Promise<LoginResult> {
  const db = await getDb();
  const doc = await db.collection<PersonDoc>("people").findOne({ email: email.trim().toLowerCase() });
  const ok = await bcrypt.compare(password, doc?.password_hash ?? DUMMY_HASH);
  if (!doc || !ok) return { ok: false, error: "invalid_credentials" };

  const household = await db.collection<HouseholdDoc>("households").findOne({ "members.user_id": doc.user_id });
  const member = household?.members.find((m) => m.user_id === doc.user_id);
  if (!household || !member) return { ok: false, error: "no_household" };

  const user: Session = { user_id: doc.user_id, name: member.name, role: member.role, person_id: household.person_id };
  return { ok: true, token: await signSession(user), user };
}

// The caller's household only. No emails or credentials leave here.
export async function careTeam(s: Session): Promise<TeamMember[]> {
  const household = await (await getDb()).collection<HouseholdDoc>("households").findOne({ person_id: s.person_id });
  return (household?.members ?? [])
    .map(({ user_id, name, role, relation, shift }) => ({ user_id, name, role, relation, shift }))
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
}
