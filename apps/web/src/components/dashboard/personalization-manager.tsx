"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";

import { deleteMemory, saveMemory, setPersonalization } from "@/app/(dashboard)/actions";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { AgentMemory } from "@/types/api";

type Kind = "preference" | "writing_sample";

export function PersonalizationManager({ initialMemories, initialEnabled, configured }: {
  initialMemories: AgentMemory[];
  initialEnabled: boolean;
  configured: boolean;
}) {
  const [memories, setMemories] = useState(initialMemories);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [editing, setEditing] = useState<AgentMemory | "new" | null>(null);
  const [removing, setRemoving] = useState<AgentMemory | null>(null);
  const [kind, setKind] = useState<Kind>("preference");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function open(memory?: AgentMemory) {
    setEditing(memory ?? "new");
    setKind(memory?.source.kind === "writing_sample" ? "writing_sample" : "preference");
    setContent(memory?.content ?? "");
    setError("");
  }

  function toggle(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    setError("");
    startTransition(async () => {
      const result = await setPersonalization(next);
      if (result.error) {
        setEnabled(previous);
        setError(result.error);
      }
    });
  }

  function save() {
    if (!content.trim() || !editing) return;
    startTransition(async () => {
      const result = await saveMemory({
        memoryKey: editing === "new" ? undefined : editing.memory_key,
        content: content.trim(),
        kind,
      });
      if (!result.memory) return setError(result.error ?? "Memory could not be saved.");
      setMemories((current) => editing === "new"
        ? [result.memory!, ...current]
        : current.map((memory) => memory.id === result.memory!.id ? result.memory! : memory));
      setEditing(null);
      router.refresh();
    });
  }

  function remove() {
    if (!removing) return;
    startTransition(async () => {
      const result = await deleteMemory(removing.id);
      if (result.error) return setError(result.error);
      setMemories((current) => current.filter(({ id }) => id !== removing.id));
      setRemoving(null);
      router.refresh();
    });
  }

  return (
    <div className="py-5">
      <div className="flex items-center justify-between gap-6">
        <div>
          <Label htmlFor="personalization">Personalize drafted replies</Label>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">
            Use only the preferences, examples, and corrections you explicitly save.
          </p>
        </div>
        <Switch id="personalization" checked={enabled} disabled={!configured || pending} onCheckedChange={toggle} />
      </div>

      {!configured ? <p className="mt-4 border-y border-border py-3 text-sm text-muted-foreground">Configure an AI provider before enabling personalization.</p> : null}
      {error ? <p className="mt-4 border-y border-destructive/30 py-3 text-sm text-destructive">{error}</p> : null}

      <div className="mt-6 flex items-center justify-between gap-4 border-t border-border pt-5">
        <div>
          <p className="font-medium">Remembered writing</p>
          <p className="mt-1 text-sm text-muted-foreground">You can inspect or remove every saved item.</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={!enabled || pending} onClick={() => open()}><Plus />Add</Button>
      </div>

      <div className="mt-4 divide-y divide-border border-y border-border">
        {memories.length ? memories.map((memory) => (
          <div key={memory.id} className="flex items-start justify-between gap-4 py-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {memory.source.kind === "correction" ? "Correction" : memory.source.kind === "writing_sample" ? "Writing sample" : "Preference"}
                {memory.provider ? ` · ${memory.provider.replaceAll("_", " ")}` : ""}
              </p>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6">{memory.content}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              {memory.source.kind !== "correction" ? <Button type="button" variant="ghost" size="icon-sm" aria-label="Edit memory" onClick={() => open(memory)}><Pencil /></Button> : null}
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete memory" onClick={() => setRemoving(memory)}><Trash2 /></Button>
            </div>
          </div>
        )) : <p className="py-6 text-sm text-muted-foreground">No writing preferences or examples saved yet.</p>}
      </div>

      <Dialog open={editing !== null} onOpenChange={(openState) => { if (!openState) setEditing(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "Add remembered writing" : "Edit remembered writing"}</DialogTitle>
            <DialogDescription>Save a direct preference or a representative message you wrote.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="memory-kind">Type</Label>
              <NativeSelect id="memory-kind" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
                <NativeSelectOption value="preference">Writing preference</NativeSelectOption>
                <NativeSelectOption value="writing_sample">Writing sample</NativeSelectOption>
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="memory-content">Text</Label>
              <Textarea id="memory-content" value={content} maxLength={2000} onChange={(event) => setContent(event.target.value)} placeholder={kind === "preference" ? "Keep replies short and never sign off with Regards." : "Paste a message that sounds like you."} />
              <p className="text-right text-xs text-muted-foreground">{content.length}/2000</p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="button" disabled={!content.trim() || pending} onClick={save}>Save memory</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(removing)} onOpenChange={(openState) => { if (!openState) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget this memory?</AlertDialogTitle>
            <AlertDialogDescription>Podex will stop using it in future drafts. This does not change messages already sent.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep memory</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={remove}>Forget</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
