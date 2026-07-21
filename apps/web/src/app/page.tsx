import Image from "next/image";
import Link from "next/link";

import { MorphicNavbar } from "@/components/kokonutui/morphic-navbar";
import { Hero } from "@/components/landing/hero";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="relative px-4 py-4 sm:px-6">
        <Link
          href="/"
          className="flex w-fit items-center gap-2 text-foreground sm:absolute sm:top-1/2 sm:left-6 sm:-translate-y-1/2"
        >
          <Image
            src="/cloudy-mascot.png"
            alt=""
            width={40}
            height={40}
            priority
          />
          <span className="font-heading text-heading-sm">Cloudy</span>
        </Link>
        <MorphicNavbar className="mt-3 sm:mt-0" />
        <div className="absolute top-4 right-4 flex items-center gap-2 sm:top-1/2 sm:right-6 sm:-translate-y-1/2">
          <Button
            nativeButton={false}
            render={<Link href={signedIn ? "/home" : "/login"} />}
            size="lg"
          >
            {signedIn ? "Dashboard" : "Login"}
          </Button>
        </div>
      </header>
      <main id="main-content">
        <Hero />
      </main>
    </div>
  );
}
