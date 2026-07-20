"use client";

import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";

import { getEditableReply, reviseReply } from "@/app/(dashboard)/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { ApprovalRequest } from "@/types/api";
import { relativeTime } from "@/lib/relative-time";

export function PendingPingsTable({ pings }: { pings: ApprovalRequest[] }) {
  const [editing, setEditing] = useState<ApprovalRequest | null>(null);
  const [reply, setReply] = useState("");
  const [payloadHash, setPayloadHash] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function open(ping: ApprovalRequest) {
    setError("");
    startTransition(async () => {
      const result = await getEditableReply(ping.id);
      if (!result.reply || !result.payload_hash) return setError(result.error ?? "Reply is not editable.");
      setEditing(ping);
      setReply(result.reply);
      setPayloadHash(result.payload_hash);
    });
  }

  function save() {
    if (!editing || !reply.trim()) return;
    startTransition(async () => {
      const result = await reviseReply(editing.id, reply.trim(), payloadHash);
      if (!result.payload_hash) return setError(result.error ?? "Reply could not be revised.");
      setEditing(null);
      setError("");
    });
  }

  return (
    <section className="mt-10" aria-labelledby="pending-pings-title">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2 id="pending-pings-title" className="text-heading-sm">Pending Pings</h2>
          <p className="mt-1 text-muted-foreground">Waiting for a decision on your Pod.</p>
        </div>
        <Badge variant="outline">{pings.length} waiting</Badge>
      </div>
      <div className="border-y border-border">
        {error ? <p className="border-b border-destructive/30 py-3 text-sm text-destructive">{error}</p> : null}
        <Table>
          <TableHeader className="bg-secondary/45">
            <TableRow>
              <TableHead>Ping</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead className="text-right">Waiting</TableHead>
              <TableHead className="w-24 text-right">Reply</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pings.length ? pings.map((ping) => (
              <TableRow key={ping.id}>
                <TableCell className="min-w-64 py-4 font-medium text-foreground">{ping.title}</TableCell>
                <TableCell className="text-muted-foreground">{ping.source}</TableCell>
                <TableCell><Badge variant={ping.risk === "high" ? "destructive" : "secondary"}>{ping.risk} risk</Badge></TableCell>
                <TableCell className="text-right text-muted-foreground">{relativeTime(ping.created_at)}</TableCell>
                <TableCell className="text-right">
                  {ping.editable_reply ? <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => open(ping)}><Pencil />Edit</Button> : "—"}
                </TableCell>
              </TableRow>
            )) : (
              <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No Pings are waiting.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={Boolean(editing)} onOpenChange={(openState) => { if (!openState) setEditing(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit the exact reply</DialogTitle>
            <DialogDescription>Your correction is remembered only for this connected service. The Pod must approve the new exact text.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="corrected-reply">Reply</Label>
            <Textarea id="corrected-reply" value={reply} maxLength={4096} onChange={(event) => setReply(event.target.value)} />
            <p className="text-right text-xs text-muted-foreground">{reply.length}/4096</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="button" disabled={!reply.trim() || pending} onClick={save}>Save for Pod approval</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
