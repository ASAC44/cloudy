import {
  DashboardSidebar,
  DashboardSidebarReopen,
} from "@/components/dashboard/dashboard-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export default async function DashboardLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims) redirect("/login");

  const metadata = claims.user_metadata;
  const metadataName = metadata?.full_name;
  const email = typeof claims.email === "string" ? claims.email : "";
  const user = {
    name: typeof metadataName === "string" ? metadataName : email.split("@")[0] || "Cloudy user",
    email,
    avatarUrl: typeof metadata?.avatar_url === "string"
      ? metadata.avatar_url
      : typeof metadata?.picture === "string"
        ? metadata.picture
        : undefined,
  };

  return (
    <SidebarProvider>
      <DashboardSidebar user={user} />
      <SidebarInset className="relative">
        <DashboardSidebarReopen />
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
