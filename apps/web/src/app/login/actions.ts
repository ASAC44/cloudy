"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

async function getOrigin() {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");

  if (origin) return origin;

  const host =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";

  if (!host) redirect("/login?error=config");
  return `${protocol}://${host}`;
}

export async function signInWithGoogle() {
  const supabase = await createClient();
  const origin = await getOrigin();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback?next=/home` },
  });

  if (error || !data.url) redirect("/login?error=oauth");
  redirect(data.url);
}

export async function signInWithEmail(formData: FormData) {
  const email = formData.get("email");

  if (typeof email !== "string" || !email.trim()) {
    redirect("/login?error=email");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: {
      emailRedirectTo: `${await getOrigin()}/auth/callback?next=/home`,
      shouldCreateUser: true,
    },
  });

  if (error) {
    if (error.code === "email_address_not_authorized") {
      redirect("/login?error=email_config");
    }
    if (
      error.code === "over_email_send_rate_limit" ||
      error.code === "over_request_rate_limit"
    ) {
      redirect("/login?error=email_rate");
    }
    redirect("/login?error=email");
  }
  redirect("/login?sent=1");
}
