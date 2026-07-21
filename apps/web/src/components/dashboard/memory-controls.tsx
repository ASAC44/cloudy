"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Database, RefreshCw, Trash2 } from "lucide-react";

import {
  estimateMessageHistory, forgetAllMemory, forgetConnectionMemory, forgetMemoryPerson,
  setLearnedActions, startMessageHistoryImport, telegramHistoryDialogs,
} from "@/app/(dashboard)/actions";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import type { Connection, MemoryImport, MemoryPerson, TelegramHistoryDialog } from "@/types/api";

type ImportConnection = Connection & { provider: "gmail" | "telegram" };

export function MemoryControls({
  connections, imports, people, learnedActionsEnabled, configured,
}: {
  connections: ImportConnection[];
  imports: MemoryImport[];
  people: MemoryPerson[];
  learnedActionsEnabled: boolean;
  configured: boolean;
}) {
  const [learned, setLearned] = useState(learnedActionsEnabled);
  const [selected, setSelected] = useState<ImportConnection | null>(null);
  const [after, setAfter] = useState(() => new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [limit, setLimit] = useState(100);
  const [dialogs, setDialogs] = useState<TelegramHistoryDialog[]>([]);
  const [selectedDialogs, setSelectedDialogs] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [consented, setConsented] = useState(false);
  const [error, setError] = useState("");
  const [forget, setForget] = useState<{ kind: "person" | "connection" | "everything"; id?: string; label: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const currentImport = useMemo(() => new Map(imports.map((item) => [item.connection_id, item])), [imports]);

  function scope() {
    if (!selected) return null;
    return selected.provider === "gmail"
      ? { provider: "gmail", after, max_messages: limit }
      : { provider: "telegram", dialog_ids: selectedDialogs, max_messages_per_dialog: Math.min(limit, 100) };
  }

  function open(connection: ImportConnection) {
    setSelected(connection);
    setEstimate(null);
    setConsented(false);
    setError("");
    setDialogs([]);
    setSelectedDialogs([]);
    if (connection.provider === "telegram") startTransition(async () => {
      const result = await telegramHistoryDialogs(connection.id);
      if (result.error) setError(result.error);
      else setDialogs(result.dialogs ?? []);
    });
  }

  function checkEstimate() {
    const value = scope();
    if (!selected || !value || (selected.provider === "telegram" && !selectedDialogs.length)) return;
    setError("");
    startTransition(async () => {
      const result = await estimateMessageHistory(selected.id, value);
      if (result.error) setError(result.error);
      else setEstimate(result.estimated_count ?? 0);
    });
  }

  function beginImport() {
    const value = scope();
    if (!selected || !value || !consented || estimate === null) return;
    startTransition(async () => {
      const result = await startMessageHistoryImport(selected.id, value);
      if (result.error) return setError(result.error);
      setSelected(null);
      router.refresh();
    });
  }

  function toggleLearned(next: boolean) {
    const previous = learned;
    setLearned(next);
    startTransition(async () => {
      const result = await setLearnedActions(next);
      if (result.error) { setLearned(previous); setError(result.error); }
    });
  }

  function confirmForget() {
    if (!forget) return;
    startTransition(async () => {
      const result = forget.kind === "person" ? await forgetMemoryPerson(forget.id!)
        : forget.kind === "connection" ? await forgetConnectionMemory(forget.id!)
          : await forgetAllMemory();
      if (result.error) return setError(result.error);
      setForget(null);
      router.refresh();
    });
  }

  return (
    <div className="divide-y divide-border border-y border-border">
      <div className="flex items-center justify-between gap-6 py-5">
        <div>
          <Label htmlFor="learned-actions">Suggest learned communication actions</Label>
          <p className="mt-2 text-sm leading-5 text-muted-foreground">Let graph memory choose only among verified communication options. Every send still needs Pod approval.</p>
        </div>
        <Switch id="learned-actions" checked={learned} disabled={!configured || pending} onCheckedChange={toggleLearned} />
      </div>

      <div className="py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium">Sent-message history</p>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">Import only the connections and conversations you select. Imported messages teach writing style, not action permission.</p>
          </div>
          <Database className="mt-1 size-4 text-muted-foreground" />
        </div>
        <div className="mt-4 divide-y divide-border border-y border-border">
          {connections.length ? connections.map((connection) => {
            const item = currentImport.get(connection.id);
            const denominator = Math.max(item?.estimated_count ?? 0, item?.imported_count ?? 0, 1);
            return <div key={connection.id} className="py-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{connection.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{connection.provider === "gmail" ? "Gmail sent mail" : "Selected Telegram chats"}{item ? ` · ${item.status.replaceAll("_", " ")} · ${item.imported_count} imported` : " · not enabled"}</p>
                </div>
                <div className="flex gap-1">
                  <Button type="button" size="sm" variant="outline" disabled={pending || connection.status !== "connected"} onClick={() => open(connection)}>{item ? <RefreshCw /> : null}{item ? "Change scope" : "Choose scope"}</Button>
                  {item ? <Button type="button" size="icon-sm" variant="ghost" aria-label={`Forget ${connection.name} memory`} onClick={() => setForget({ kind: "connection", id: connection.id, label: connection.name })}><Trash2 /></Button> : null}
                </div>
              </div>
              {item ? <Progress className="mt-3 h-1.5" value={Math.min(100, item.imported_count / denominator * 100)} /> : null}
              {item?.last_error ? <p className="mt-2 text-xs text-destructive">{item.last_error}</p> : null}
            </div>;
          }) : <p className="py-5 text-sm text-muted-foreground">Connect Gmail or a Telegram personal account to import sent history.</p>}
        </div>
      </div>

      <div className="py-5">
        <p className="font-medium">People and verified identities</p>
        <p className="mt-1 text-sm text-muted-foreground">Review who Cloudy can connect across approved communication history.</p>
        <div className="mt-4 divide-y divide-border border-y border-border">
          {people.length ? people.map((person) => <div key={person.id} className="flex items-start justify-between gap-4 py-4">
            <div><p className="text-sm font-medium">{person.name}</p><p className="mt-1 text-xs text-muted-foreground">{person.identities.map((identity) => `${identity.channel}: ${identity.label}`).join(" · ") || "No active verified identity"}</p></div>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Forget ${person.name}`} onClick={() => setForget({ kind: "person", id: person.id, label: person.name })}><Trash2 /></Button>
          </div>) : <p className="py-5 text-sm text-muted-foreground">No verified people have been added yet.</p>}
        </div>
      </div>

      <div className="flex items-center justify-between gap-6 py-5">
        <div><p className="font-medium">Forget all memory</p><p className="mt-1 text-sm text-muted-foreground">Remove canonical memory and rebuild the graph without it. Approval records outside memory remain intact.</p></div>
        <Button type="button" variant="destructive" disabled={pending} onClick={() => setForget({ kind: "everything", label: "all Cloudy memory" })}>Forget everything</Button>
      </div>

      {error ? <p className="py-4 text-sm text-destructive">{error}</p> : null}

      <Dialog open={Boolean(selected)} onOpenChange={(openState) => { if (!openState) setSelected(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Choose history scope</DialogTitle><DialogDescription>Cloudy estimates the selected scope before asking for import consent.</DialogDescription></DialogHeader>
          {selected?.provider === "gmail" ? <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2"><Label htmlFor="history-after">Messages after</Label><Input id="history-after" type="date" value={after} onChange={(event) => { setAfter(event.target.value); setEstimate(null); }} /></div>
            <div className="grid gap-2"><Label htmlFor="history-limit">Maximum messages</Label><Input id="history-limit" type="number" min={1} max={500} value={limit} onChange={(event) => { setLimit(Math.max(1, Math.min(500, Number(event.target.value) || 1))); setEstimate(null); }} /></div>
          </div> : <div className="max-h-64 divide-y divide-border overflow-y-auto border-y border-border">
            {dialogs.map((dialog) => <label key={dialog.id} className="flex cursor-pointer items-center gap-3 py-3 text-sm"><Checkbox checked={selectedDialogs.includes(dialog.id)} onCheckedChange={(checked) => { setSelectedDialogs((current) => checked ? [...current, dialog.id] : current.filter((id) => id !== dialog.id)); setEstimate(null); }} /><span>{dialog.title}</span><span className="ml-auto text-xs text-muted-foreground">{dialog.kind}</span></label>)}
            {!dialogs.length ? <p className="py-4 text-sm text-muted-foreground">{pending ? "Loading chats…" : "No available chats."}</p> : null}
          </div>}
          {estimate !== null ? <div className="border-y border-border py-4"><p className="text-sm font-medium">Up to {estimate} sent messages</p><label className="mt-3 flex items-start gap-3 text-sm"><Checkbox checked={consented} onCheckedChange={(checked) => setConsented(checked === true)} /><span>I consent to importing this exact scope for voice personalization.</span></label></div> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setSelected(null)}>Cancel</Button>{estimate === null ? <Button type="button" disabled={pending || (selected?.provider === "telegram" && !selectedDialogs.length)} onClick={checkEstimate}>Check import size</Button> : <Button type="button" disabled={pending || !consented} onClick={beginImport}>Start import</Button>}</DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(forget)} onOpenChange={(openState) => { if (!openState) setForget(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Forget {forget?.label}?</AlertDialogTitle><AlertDialogDescription>This removes the selected canonical memory and schedules a graph rebuild. It cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep memory</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={pending} onClick={confirmForget}>Forget</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
