import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ApprovalRequest } from "@/types/api";
import { relativeTime } from "@/lib/relative-time";

export function PendingPingsTable({ pings }: { pings: ApprovalRequest[] }) {
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
        <Table>
          <TableHeader className="bg-secondary/45">
            <TableRow>
              <TableHead>Ping</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead className="text-right">Waiting</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pings.length ? pings.map((ping) => (
              <TableRow key={ping.id}>
                <TableCell className="min-w-64 py-4 font-medium text-foreground">{ping.title}</TableCell>
                <TableCell className="text-muted-foreground">{ping.source}</TableCell>
                <TableCell><Badge variant={ping.risk === "high" ? "destructive" : "secondary"}>{ping.risk} risk</Badge></TableCell>
                <TableCell className="text-right text-muted-foreground">{relativeTime(ping.created_at)}</TableCell>
              </TableRow>
            )) : (
              <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">No Pings are waiting.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
