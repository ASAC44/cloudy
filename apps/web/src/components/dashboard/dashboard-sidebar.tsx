"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenText, ChevronsUpDown, LogOut } from "lucide-react";

import { signOut } from "@/app/(dashboard)/actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

const navigation = [
  { label: "Home", href: "/home" },
  { label: "Logs", href: "/logs" },
  { label: "Configure", href: "/configure" },
  { label: "Connections", href: "/connections" },
  { label: "Automations", href: "/automations/n8n" },
  { label: "Codex", href: "/codex" },
  { label: "Settings", href: "/settings" },
];

type SidebarUser = { name: string; email: string; avatarUrl?: string };

export function DashboardSidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname();
  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="p-2">
        <div className="flex items-center gap-1">
          <Link
            href="/"
            className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-sidebar-foreground hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <Image
              src="/cloudy-mascot.png"
              alt=""
              width={32}
              height={32}
              className="size-8 shrink-0"
              priority
            />
            <span className="font-heading text-lg">Cloudy</span>
          </Link>
          <DashboardSidebarCollapseControl />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              {navigation.map(({ label, href }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={pathname === href}
                    render={<Link href={href} />}
                  >
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <SidebarMenuItem className="mt-3 border-t border-sidebar-border pt-3">
                <SidebarMenuButton
                  className="bg-clay/10 text-clay hover:bg-clay/15 hover:text-clay"
                  render={<Link href="/docs" />}
                >
                  <BookOpenText aria-hidden="true" />
                  <span>Docs</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-lg border border-sidebar-border px-2 py-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              />
            }
          >
            <Avatar>
              {user.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" referrerPolicy="no-referrer" /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{user.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{user.email}</span>
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={8}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="grid gap-0.5 px-2 py-1.5">
                <span className="truncate text-sm text-foreground">{user.name}</span>
                <span className="truncate font-normal">{user.email}</span>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <form action={signOut}>
              <DropdownMenuItem
                variant="destructive"
                nativeButton
                render={<button type="submit" className="w-full" />}
              >
                <LogOut aria-hidden="true" />
                Sign out
              </DropdownMenuItem>
            </form>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function DashboardSidebarCollapseControl() {
  const { state } = useSidebar();

  if (state === "collapsed") {
    return null;
  }

  return <SidebarTrigger className="shrink-0" />;
}

export function DashboardSidebarReopen() {
  const { isMobile, state } = useSidebar();

  if (!isMobile && state === "expanded") {
    return null;
  }

  return <SidebarTrigger className="absolute top-4 left-4 z-20" />;
}
