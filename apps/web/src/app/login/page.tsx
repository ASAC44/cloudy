import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { createClient } from "@/lib/supabase/server";

import { signInWithEmail, signInWithGoogle } from "./actions";

const errors: Record<string, string> = {
  callback: "That sign-in attempt is invalid or expired. Please try again.",
  config: "Authentication is not configured correctly.",
  email: "We could not send the sign-in email. Please try again shortly.",
  email_config:
    "Email delivery is not configured for this address. Please use Google sign-in for now.",
  email_rate: "Too many sign-in emails were requested. Please wait and try again.",
  oauth: "Google sign-in could not be started. Please try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (claims) redirect("/home");

  const params = await searchParams;
  const error = params.error ? errors[params.error] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md">
        <Link
          href="/"
          className="mx-auto mb-6 flex w-fit items-center gap-2 text-foreground"
        >
          <Image src="/cloudy-mascot.png" alt="" width={40} height={40} />
          <span className="font-heading text-heading-sm">Cloudy</span>
        </Link>

        <Card>
          <CardHeader className="text-center">
            <CardTitle className="font-heading text-heading-sm">
              Sign in to Cloudy
            </CardTitle>
            <CardDescription>
              Approve agent actions from your trusted Pod.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {params.sent ? (
              <p
                role="status"
                className="rounded-lg bg-muted px-4 py-3 text-sm text-foreground"
              >
                Check your email for a secure sign-in link.
              </p>
            ) : null}
            {error ? (
              <p
                role="alert"
                className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}

            <form action={signInWithGoogle}>
              <Button type="submit" variant="outline" className="w-full">
                Continue with Google
              </Button>
            </form>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-caption text-muted-foreground">or</span>
              <Separator className="flex-1" />
            </div>

            <form action={signInWithEmail} className="space-y-3">
              <label htmlFor="email" className="text-sm font-medium">
                Email address
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
              />
              <Button type="submit" className="w-full">
                Continue
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
