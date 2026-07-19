"use client";

import { useState } from "react";
import { MoreHorizontal, Unplug } from "lucide-react";

import { revokePod } from "@/app/(dashboard)/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function PodActionsMenu({ podId, podName }: { podId: string; podName: string }) {
  const [unpairOpen, setUnpairOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label="More Pod actions" />}
        >
          <MoreHorizontal aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem variant="destructive" onClick={() => setUnpairOpen(true)}>
            <Unplug aria-hidden="true" />
            Unpair Pod
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={unpairOpen} onOpenChange={setUnpairOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpair {podName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This Pod will stop receiving Pings and must be paired again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep paired</AlertDialogCancel>
            <form action={revokePod}>
              <input type="hidden" name="pod_id" value={podId} />
              <AlertDialogAction type="submit" variant="destructive">Unpair Pod</AlertDialogAction>
            </form>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
