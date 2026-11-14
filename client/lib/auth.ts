import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { jwtVerify } from "jose";
import { getDb } from "./db";

export type Role = "person" | "family" | "caregiver";
// person_id is the household link: Anna and Ravi both carry person_id "margaret".
export type Session = { user_id: string; name: string; role: Role; person_id: string };

const COOKIE = "keepsake_session";
const key = () => new TextEncoder().encode(process.env.AUTH_SECRET);

// lib/users.ts signs the token at login; this stores and verifies it with AUTH_SECRET.
export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    return payload as unknown as Session;
  } catch {
    return null; // expired or tampered
  }
}

// For API routes: trusts the token for user_id only and re-reads name, role and person_id from
// households.members (same lookup as login), so a removed member or changed role applies at once.
export async function getMemberSession(): Promise<Session | null> {
  const user_id = (await getSession())?.user_id;
  if (typeof user_id !== "string") return null;
  const household = await (await getDb())
    .collection<{ person_id: string; members: { user_id: string; name: string; role: Role }[] }>("households")
    .findOne({ "members.user_id": user_id }, { projection: { person_id: 1, members: { $elemMatch: { user_id } } } });
  const member = household?.members?.find((m) => m.user_id === user_id);
  return household && member ? { user_id, name: member.name, role: member.role, person_id: household.person_id } : null;
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export const homeFor = (role: Role) => (role === "person" ? "/talk" : "/dashboard");

// For pages, actions and route handlers: redirects if signed out or the wrong role.
// Household and role are re-read like getMemberSession, so a member who was removed or moved loses access at once.
export async function requireSession(roles?: Role[]) {
  const s = await getMemberSession();
  if (!s) redirect("/login");
  if (roles && !roles.includes(s.role)) redirect(homeFor(s.role));
  return s;
}
