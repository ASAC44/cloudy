"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Cable, Plus, Trash2 } from "lucide-react";

import { claimCodexBridge, createCodexSession, revokeCodexBridge, selectCodexTarget } from "@/app/(dashboard)/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CodexOverview } from "@/types/api";

export function CodexManager({ initial, initialError }: { initial: CodexOverview; initialError?: string }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [error, setError] = useState(initialError || "");
  const [pending, startTransition] = useTransition();
  const [pairState, pairAction, pairing] = useActionState(claimCodexBridge, {});

  const choose = (workspaceId: string, threadId: string | null) => startTransition(async () => {
    const result = await selectCodexTarget({ workspaceId, threadId, revision: data.target?.revision ?? null });
    if (result.error) return setError(result.error);
    if (result.target) setData((current) => ({ ...current, target: result.target! }));
  });

  const create = (workspaceId: string) => startTransition(async () => {
    const result = await createCodexSession(workspaceId);
    setError(result.error || "New session queued. It will appear after the bridge syncs.");
    if (!result.error) window.setTimeout(() => router.refresh(), 2500);
  });

  const remove = (id: string) => startTransition(async () => {
    const result = await revokeCodexBridge(id);
    if (result.error) return setError(result.error);
    setData((current) => ({ ...current, bridges: current.bridges.filter((bridge) => bridge.id !== id), workspaces: current.workspaces.filter((workspace) => workspace.bridge_id !== id) }));
  });

  return (
    <div className="divide-y divide-border">
      {(error || pairState.error || pairState.success) ? <p className="py-4 text-sm text-muted-foreground" role="status">{error || pairState.error || pairState.success}</p> : null}
      <section className="grid gap-8 py-10 md:grid-cols-[minmax(0,0.7fr)_minmax(22rem,1.3fr)] md:gap-16">
        <div><h2 className="text-lg font-medium">Local bridges</h2><p className="mt-2 leading-6 text-muted-foreground">The bridge keeps Codex login and repository access on your computer.</p></div>
        <div className="space-y-4">
          {data.bridges.map((bridge) => <div key={bridge.id} className="flex items-center gap-4 border-y border-border py-4"><span className={`size-2 rounded-full ${bridge.online ? "bg-clay" : "bg-muted-foreground"}`} /><span className="min-w-0 flex-1"><span className="block font-medium">{bridge.name}</span><span className="block truncate text-sm text-muted-foreground">{bridge.version || "Waiting for first sync"}{bridge.last_error ? ` · ${bridge.last_error}` : ""}</span></span><Badge variant="outline">{bridge.online ? "Online" : "Offline"}</Badge><Button size="icon-sm" variant="ghost" onClick={() => remove(bridge.id)} disabled={pending} aria-label={`Revoke ${bridge.name}`}><Trash2 /></Button></div>)}
          {!data.bridges.length ? <p className="border-y border-border py-5 text-sm text-muted-foreground">No bridge paired yet.</p> : null}
          <Dialog><DialogTrigger render={<Button variant="outline" />}><Cable />Pair bridge</DialogTrigger><DialogContent className="sm:max-w-md"><form action={pairAction}><DialogHeader><DialogTitle>Pair a Codex bridge</DialogTitle><DialogDescription>Run <code>cloudy-bridge pair</code>, then enter its eight-character code.</DialogDescription></DialogHeader><div className="grid gap-5 py-6"><div className="grid gap-2"><Label htmlFor="bridge-name">Bridge name</Label><Input id="bridge-name" name="name" required maxLength={80} defaultValue="My computer" /></div><div className="grid gap-2"><Label htmlFor="bridge-code">Pairing code</Label><Input id="bridge-code" name="code" required minLength={8} maxLength={8} className="font-mono uppercase" /></div></div><DialogFooter><Button type="submit" disabled={pairing}>{pairing ? "Pairing…" : "Pair bridge"}</Button></DialogFooter></form></DialogContent></Dialog>
        </div>
      </section>
      <section className="py-10"><div className="mb-6 flex items-end justify-between gap-4"><div><h2 className="text-lg font-medium">Workspaces and sessions</h2><p className="mt-2 text-sm text-muted-foreground">Select one destination for Pod voice prompts.</p></div>{!data.voice_ready ? <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/settings" />}>Set up OpenAI voice</Button> : <Badge>Voice ready</Badge>}</div>
        <Table><TableHeader><TableRow><TableHead>Workspace</TableHead><TableHead>Session</TableHead><TableHead>Status</TableHead><TableHead>Latest milestone</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader><TableBody>
          {data.workspaces.flatMap((workspace) => {
            const threads = data.threads.filter((thread) => thread.workspace_id === workspace.id);
            return [...threads.map((thread) => ({ workspace, thread })), { workspace, thread: null }];
          }).map(({ workspace, thread }) => { const active = data.target?.workspace_id === workspace.id && data.target?.thread_id === (thread?.id ?? null); return <TableRow key={`${workspace.id}:${thread?.id || "new"}`} data-state={active ? "selected" : undefined}><TableCell className="font-medium">{workspace.label}</TableCell><TableCell>{thread?.title || "Next new session"}</TableCell><TableCell>{thread ? <Badge variant="outline">{thread.status}</Badge> : "—"}</TableCell><TableCell className="max-w-sm truncate text-muted-foreground">{thread?.last_error || (thread?.status === "completed" ? thread.final_summary : thread?.milestone) || "Starts with the next voice prompt"}</TableCell><TableCell className="text-right">{thread ? <Button size="sm" variant={active ? "secondary" : "outline"} onClick={() => choose(workspace.id, thread.id)} disabled={pending}>{active ? "Active" : "Use session"}</Button> : <Button size="sm" variant="ghost" onClick={() => create(workspace.id)} disabled={pending}><Plus />Create</Button>}</TableCell></TableRow>; })}
          {!data.workspaces.length ? <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Add a workspace with <code>cloudy-bridge add-workspace /path/to/repo</code>.</TableCell></TableRow> : null}
        </TableBody></Table>
      </section>
    </div>
  );
}
