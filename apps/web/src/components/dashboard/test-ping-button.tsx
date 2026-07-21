"use client";

import { useActionState, useState } from "react";
import { BellPlus } from "lucide-react";

import { createPing } from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MOCK_NOTIFICATIONS, type MockNotificationType, type MockScreen } from "@/components/dashboard/mock-notifications";

export function TestPingButton() {
  const [state, action, pending] = useActionState(createPing, {});
  const [type, setType] = useState<MockNotificationType>("general");
  const [screen, setScreen] = useState<MockScreen>("down");
  const notification = MOCK_NOTIFICATIONS[type];

  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>
        <BellPlus aria-hidden="true" />
        Send mock notification
      </DialogTrigger>
      <DialogContent>
        <form action={action}>
          <DialogHeader>
            <DialogTitle>Send a mock notification</DialogTitle>
            <DialogDescription>Choose what the notification represents and where it should open on the Pod.</DialogDescription>
          </DialogHeader>

          <input type="hidden" name="title" value={notification.title} />
          <input type="hidden" name="source" value={notification.source} />
          <input type="hidden" name="summary" value={notification.summary} />
          <input type="hidden" name="details" value={notification.details} />
          <input type="hidden" name="affected_context" value={notification.context} />
          <input type="hidden" name="risk" value={notification.risk} />
          <input type="hidden" name="warnings" value={notification.warnings} />
          <input type="hidden" name="expires_in_minutes" value="5" />

          <div className="grid gap-5 py-6">
            <div className="grid gap-2">
              <Label htmlFor="mock-notification-type">Notification type</Label>
              <Select name="mock_type" value={type} onValueChange={(value) => value && setType(value as MockNotificationType)}>
                <SelectTrigger id="mock-notification-type" className="w-full"><SelectValue>{(value) => MOCK_NOTIFICATIONS[value as MockNotificationType].label}</SelectValue></SelectTrigger>
                <SelectContent align="start">
                  {Object.entries(MOCK_NOTIFICATIONS).map(([value, option]) => <SelectItem key={value} value={value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="mock-notification-screen">Pod screen</Label>
              <Select name="screen" value={screen} onValueChange={(value) => value && setScreen(value as MockScreen)}>
                <SelectTrigger id="mock-notification-screen" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="left">Screen 1 · Left</SelectItem>
                  <SelectItem value="down">Screen 2 · Default</SelectItem>
                  <SelectItem value="right">Screen 3 · Right</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="border-y py-4">
              <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">{notification.source}</p>
              <p className="mt-2 font-medium">{notification.title}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{notification.summary}</p>
            </div>
            {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
            {state.success ? <p role="status" className="text-sm text-emerald-700">Mock notification sent.</p> : null}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" disabled={pending}>{pending ? "Sending…" : "Send notification"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
