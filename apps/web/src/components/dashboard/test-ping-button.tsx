"use client";

import { useActionState } from "react";
import { Radio } from "lucide-react";

import { createPing } from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";

export function TestPingButton() {
  const [state, action, pending] = useActionState(createPing, {});

  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="title" value="Pod connection test" />
      <input type="hidden" name="source" value="Dashboard · Test Ping" />
      <input type="hidden" name="summary" value="Confirm this Ping appears on the paired Pod." />
      <input type="hidden" name="details" value="Use this Ping to verify the Pod can receive and record a decision." />
      <input type="hidden" name="affected_context" value="Paired Pod" />
      <input type="hidden" name="risk" value="low" />
      <input type="hidden" name="warnings" value="" />
      <input type="hidden" name="expires_in_minutes" value="5" />
      {state.error ? <span role="alert" className="text-caption text-destructive">{state.error}</span> : null}
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <Radio aria-hidden="true" />
        {pending ? "Sending…" : state.success ? "Ping sent" : "Test Ping"}
      </Button>
    </form>
  );
}
