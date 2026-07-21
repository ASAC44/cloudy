"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { Bot, QrCode, ShieldCheck } from "lucide-react";

import {
  beginTelegramUserAuth,
  cancelTelegramUserAuth,
  getTelegramUserAuth,
  saveConnection,
  submitTelegramUserPassword,
} from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Connection, TelegramAuthSession } from "@/types/api";

export function TelegramConnectionDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (connection?: Connection) => void;
}) {
  const [mode, setMode] = useState("personal");
  const [name, setName] = useState("Telegram");
  const [session, setSession] = useState<TelegramAuthSession | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open || !session || ["connected", "failed", "cancelled", "expired"].includes(session.status)) return;
    const timer = window.setInterval(() => {
      startTransition(async () => {
        const result = await getTelegramUserAuth(session.id);
        if (result.session) {
          setSession(result.session);
          if (result.session.status === "connected") onConnected();
        } else if (result.error) setError(result.error);
      });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [open, session, onConnected]);

  function begin() {
    setError("");
    startTransition(async () => {
      const result = await beginTelegramUserAuth(name.trim() || "Telegram");
      if (result.session) setSession(result.session);
      else setError(result.error === "provider not configured"
        ? "Telegram QR sign-in is not enabled on this Cloudy server yet. Add the Telegram app credentials to both the API and worker service."
        : result.error ?? "Telegram setup could not start.");
    });
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    startTransition(async () => {
      const result = await submitTelegramUserPassword(session.id, password);
      if (result.error) setError(result.error);
      else setError("");
    });
  }

  function connectBot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const botName = String(form.get("name") ?? "Telegram bot").trim();
    const token = String(form.get("token") ?? "").trim();
    startTransition(async () => {
      const result = await saveConnection({ provider: "telegram", name: botName, token });
      if (result.connection) onConnected(result.connection);
      else setError(result.error ?? "The Telegram bot could not be connected.");
    });
  }

  function changeOpen(nextOpen: boolean) {
    if (nextOpen) return;
    if (session && !["connected", "failed", "cancelled", "expired"].includes(session.status)) {
      void cancelTelegramUserAuth(session.id);
    }
    setSession(null);
    setError("");
    setMode("personal");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect Telegram</DialogTitle>
          <DialogDescription>Use your personal account for DMs, groups, and channels, or connect a BotFather bot.</DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={setMode} className="mt-2">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="personal"><QrCode />Personal account</TabsTrigger>
            <TabsTrigger value="bot"><Bot />Bot</TabsTrigger>
          </TabsList>

          <TabsContent value="personal" className="pt-5">
            {!session ? (
              <div className="grid gap-5">
                <div className="grid gap-2">
                  <Label htmlFor="telegram-user-name">Connection name</Label>
                  <Input id="telegram-user-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
                </div>
                <p className="text-sm leading-6 text-muted-foreground">Cloudy uses Telegram’s QR sign-in. Your session is encrypted; Cloudy never marks messages read.</p>
                <Button onClick={begin} disabled={pending}>{pending ? <Spinner /> : <QrCode />}{pending ? "Starting…" : "Show QR code"}</Button>
              </div>
            ) : session.status === "waiting_2fa" ? (
              <form onSubmit={submitPassword} className="grid gap-4">
                <p className="text-sm text-muted-foreground">Telegram requires your two-step verification password{session.password_hint ? ` (${session.password_hint})` : ""}. It is encrypted and discarded after this attempt.</p>
                <div className="grid gap-2">
                  <Label htmlFor="telegram-password">2FA password</Label>
                  <Input id="telegram-password" name="password" type="password" autoComplete="current-password" required maxLength={512} />
                </div>
                <Button type="submit" disabled={pending}>{pending ? <Spinner /> : <ShieldCheck />}{pending ? "Checking…" : "Continue"}</Button>
              </form>
            ) : session.status === "connected" ? (
              <div className="flex items-start gap-3 border-y border-border py-5">
                <ShieldCheck className="mt-0.5 size-5 text-emerald-600" />
                <div><p className="font-medium">Telegram connected</p><p className="mt-1 text-sm text-muted-foreground">You can return to the Ping chat and choose chats to watch.</p></div>
              </div>
            ) : session.status === "failed" || session.status === "expired" ? (
              <div className="grid gap-4 border-y border-destructive/30 py-5">
                <p className="text-sm text-destructive">{session.last_error ?? "The QR session expired."}</p>
                <Button variant="outline" onClick={() => setSession(null)}>Try again</Button>
              </div>
            ) : session.qr_data_url ? (
              <div className="grid justify-items-center gap-4">
                {/* A short-lived QR data URL generated server-side; it contains no reusable account credential. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={session.qr_data_url} alt="Telegram sign-in QR code" className="size-64 rounded-xl bg-white p-2" />
                <p className="max-w-sm text-center text-sm leading-6 text-muted-foreground">On your phone, open Telegram → Settings → Devices → Link Desktop Device, then scan this code.</p>
                {session.last_error ? <p className="text-sm text-destructive">{session.last_error}</p> : null}
              </div>
            ) : (
              <div className="flex items-center gap-3 py-10 text-sm text-muted-foreground"><Spinner />Preparing a secure QR code…</div>
            )}
          </TabsContent>

          <TabsContent value="bot" className="pt-5">
            <form onSubmit={connectBot} className="grid gap-5">
              <div className="grid gap-2"><Label htmlFor="telegram-bot-name">Connection name</Label><Input id="telegram-bot-name" name="name" defaultValue="Telegram bot" maxLength={80} required /></div>
              <div className="grid gap-2"><Label htmlFor="telegram-bot-token">Bot token</Label><Input id="telegram-bot-token" name="token" type="password" autoComplete="off" maxLength={5000} required /></div>
              <Button type="submit" disabled={pending}>{pending ? <Spinner /> : <Bot />}{pending ? "Checking…" : "Connect bot"}</Button>
            </form>
          </TabsContent>
        </Tabs>

        {error ? <p className="mt-4 text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter><Button variant="ghost" onClick={() => changeOpen(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
