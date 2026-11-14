"use server";

import { redirect } from "next/navigation";
import { destroySession, homeFor, setSessionCookie } from "@/lib/auth";
import { login as checkLogin } from "@/lib/users";

export async function login(_: string | null, form: FormData) {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return "Enter your email and password.";

  let result;
  try {
    result = await checkLogin(email, password);
  } catch (e) {
    console.error("login failed", e);
    return "Sign-in is unavailable right now. Try again in a moment.";
  }
  if (!result.ok) {
    return result.error === "no_household" ? "This account isn't linked to a household yet." : "Email or password is incorrect.";
  }
  await setSessionCookie(result.token);
  redirect(homeFor(result.user.role)); // outside try: redirect() works by throwing
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
