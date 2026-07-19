import { Check, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { DashboardRefresh } from "@/components/dashboard/dashboard-refresh";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch, type ApprovalRequest } from "@/lib/api";

export default async function LogsPage() {
  let decisions: ApprovalRequest[] = [];
  let error = "";
  try {
    const response = await apiFetch<{ requests: ApprovalRequest[] }>("/v1/requests");
    decisions = response.requests.filter((request) => request.status === "approved" || request.status === "rejected");
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Decision history unavailable";
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 pt-16 pb-8 md:px-8 md:py-8">
      <DashboardRefresh />
      <header className="mb-8 border-b border-chalk pb-8">
        <h1 className="font-heading text-heading">Decision logs</h1>
        <p className="mt-2 max-w-xl text-muted-foreground">Approved and rejected test Pings from your Pod.</p>
      </header>

      {error ? <p className="border-y border-destructive/30 py-4 text-sm text-destructive">{error}</p> : null}

      <section aria-labelledby="decision-history-title">
        <div className="mb-4">
          <h2 id="decision-history-title" className="text-heading-sm">Recent decisions</h2>
          <p className="mt-1 text-muted-foreground">Test outcomes are recorded; no external action was executed.</p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/75 shadow-sm shadow-foreground/5">
          <Table>
            <TableHeader className="bg-secondary/45">
              <TableRow>
                <TableHead>Decision</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Decided</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {decisions.map((decision) => (
                <TableRow key={decision.id}>
                  <TableCell className="min-w-64 py-4 font-medium text-foreground">{decision.title}</TableCell>
                  <TableCell className="text-muted-foreground">{decision.source}</TableCell>
                  <TableCell>
                    <Badge variant={decision.status === "approved" ? "secondary" : "outline"}>
                      {decision.status === "approved" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
                      {decision.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {decision.decided_at ? new Date(decision.decided_at).toLocaleString() : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {!decisions.length && !error ? (
                <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No decisions yet.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
