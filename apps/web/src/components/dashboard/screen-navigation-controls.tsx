"use client";

import { useState, useTransition } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsDown, ChevronsUp, X } from "lucide-react";

import { decidePendingPing, navigatePodScreen } from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import type { ScreenNavigation } from "@/types/api";

export function ScreenNavigationControls({ podId, online, requestId }: { podId: string; online: boolean; requestId?: string }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState(requestId ? "Navigate or decide the oldest pending Ping." : online ? "Navigate the Pod screens." : "Bring your Pod online to navigate.");

  function navigate(direction: ScreenNavigation) {
    startTransition(async () => {
      const result = await navigatePodScreen(podId, direction);
      setMessage(result.error ?? result.success ?? "Navigation queued.");
    });
  }

  function decide(outcome: "approved" | "rejected") {
    if (!requestId) return;
    startTransition(async () => {
      const result = await decidePendingPing(requestId, outcome);
      setMessage(result.error ?? result.success ?? "Decision recorded.");
    });
  }

  return (
    <div className="mt-5 flex flex-col items-start gap-4 py-4">
      <div>
        <p className="font-heading text-lg">Navigate screens</p>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {pending ? "Moving the Pod…" : message}
        </p>
      </div>
      <div className="flex max-w-full flex-wrap gap-2">
        <ButtonGroup aria-label="Pod screen navigation">
          <Button type="button" variant="outline" size="icon" aria-label="Swipe up" title="Swipe up" disabled={!online || pending} onClick={() => navigate("up")}>
            <ChevronUp aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon" aria-label="Previous screen" title="Previous screen" disabled={!online || pending} onClick={() => navigate("left")}>
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon" aria-label="Next screen" title="Next screen" disabled={!online || pending} onClick={() => navigate("right")}>
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="icon" aria-label="Swipe down" title="Swipe down" disabled={!online || pending} onClick={() => navigate("down")}>
            <ChevronDown aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" aria-label="Scroll details up" title="Scroll details up" disabled={!online || pending} onClick={() => navigate("scroll_up")}>
            <ChevronsUp aria-hidden="true" />
            Scroll up
          </Button>
          <Button type="button" variant="outline" aria-label="Scroll details down" title="Scroll details down" disabled={!online || pending} onClick={() => navigate("scroll_down")}>
            <ChevronsDown aria-hidden="true" />
            Scroll down
          </Button>
        </ButtonGroup>
        <ButtonGroup aria-label="Ping decision">
          <Button type="button" disabled={!requestId || pending} onClick={() => decide("approved")}>
            <Check aria-hidden="true" />
            Approve
          </Button>
          <Button type="button" variant="destructive" disabled={!requestId || pending} onClick={() => decide("rejected")}>
            <X aria-hidden="true" />
            Reject
          </Button>
        </ButtonGroup>
      </div>
    </div>
  );
}
