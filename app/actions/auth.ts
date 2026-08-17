"use server";

import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { AuthState } from "@/lib/auth";

export async function login(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const next = safeRedirectPath(formData.get("next"));

  if (!isValidEmail(email) || !password) {
    return { error: "Email and password are required.", success: null };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message, success: null };
  }

  redirect(next);
}

export async function signup(
  _prevState: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!isValidEmail(email) || !password) {
    return { error: "Email and password are required.", success: null };
  }

  if (password.length < 8) {
    return {
      error: "Password must be at least 8 characters.",
      success: null,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    return { error: error.message, success: null };
  }

  // Supabase returns a user with empty identities when the email already exists
  if (data.user && data.user.identities?.length === 0) {
    return {
      error: "An account with this email already exists.",
      success: null,
    };
  }

  // Email confirmation enabled — session won't be created yet
  if (data.user && !data.session) {
    return {
      error: null,
      success: "Check your email for a confirmation link.",
    };
  }

  redirect("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

function safeRedirectPath(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }
  return value;
}
