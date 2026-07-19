"use client";

import { useActionState } from "react";
import { Cable } from "lucide-react";

import { claimPod } from "@/app/(dashboard)/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PairPodButton() {
  const [state, action, pending] = useActionState(claimPod, {});
  if (state.success) return null;

  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        <Cable aria-hidden="true" />
        Pair Pod
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form action={action}>
          <DialogHeader>
            <DialogTitle>Pair your Pod</DialogTitle>
            <DialogDescription>
              Enter the Pod name and the eight-character code shown on your Pod.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 py-6">
            <div className="grid gap-2">
              <Label htmlFor="pod-name">Pod name</Label>
              <Input id="pod-name" name="name" required maxLength={80} defaultValue="My Pod" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pair-code">Pairing code</Label>
              <Input
                id="pair-code"
                name="code"
                required
                minLength={8}
                maxLength={8}
                autoComplete="off"
                className="font-mono uppercase"
                placeholder="ABCD1234"
              />
            </div>
          </div>
          {state.error ? <p className="mb-4 text-sm text-destructive">{state.error}</p> : null}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Pairing…" : "Pair Pod"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
