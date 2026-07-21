import { Download, MousePointer2 } from "lucide-react";

import { ArchitectureCanvas } from "@/components/landing/architecture-canvas";
import { Button } from "@/components/ui/button";

const LAYERS = [
  ["Sources", "bg-[#a5d8ff]"],
  ["Control plane", "bg-[#d0bfff]"],
  ["Data", "bg-[#96f2d7]"],
  ["Keychain", "bg-[#b2f2bb]"],
  ["Execution", "bg-[#ffec99]"],
] as const;

export function SystemArchitectureSection() {
  return (
    <section id="system-map" aria-labelledby="system-map-title" className="border-t border-border px-4 py-20 sm:px-6 sm:py-28 lg:py-32">
      <div className="mx-auto max-w-[92rem]">
        <div className="grid gap-8 border-b border-border pb-10 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.58fr)] lg:items-end">
          <div>
            <p className="mb-5 font-mono text-xs tracking-[0.22em] text-clay uppercase">
              The whole decision loop
            </p>
            <h2 id="system-map-title" className="max-w-5xl font-serif text-[clamp(2.75rem,6vw,5.75rem)] leading-[0.94] tracking-[-0.035em]">
              From agent signal to human approval to exact action.
            </h2>
          </div>
          <div className="space-y-6 lg:pb-1">
            <p className="max-w-xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
              Follow a Ping through Cloudy&apos;s sources, authenticated control plane, canonical data, realtime keychain experience, and guarded execution path.
            </p>
            <Button
              nativeButton={false}
              variant="outline"
              size="lg"
              render={
                <a href="/cloudy-system-architecture.excalidraw?v=3" download />
              }
            >
              <Download aria-hidden="true" />
              Download editable map
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Architecture layer legend">
            {LAYERS.map(([label, color]) => (
              <span key={label} className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                <span className={`size-2.5 rounded-full ${color}`} aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>
          <p className="inline-flex items-center gap-2 font-mono text-xs tracking-[0.12em] text-muted-foreground uppercase">
            <MousePointer2 className="size-3.5" aria-hidden="true" />
            Drag to explore · wheel to zoom
          </p>
        </div>

        <div
          className="h-[38rem] overflow-hidden border-y border-[#dfd7cc] bg-[#fffdf8] sm:h-[46rem] lg:h-[52rem]"
          aria-label="Interactive Cloudy system architecture diagram"
        >
          <ArchitectureCanvas />
        </div>

        <div className="grid gap-6 border-b border-border py-8 text-sm leading-6 text-muted-foreground md:grid-cols-3">
          <p><span className="font-medium text-foreground">Realtime stays lightweight.</span> Events wake the Pod; the authenticated snapshot remains authoritative.</p>
          <p><span className="font-medium text-foreground">Offline fails safely.</span> Cached context stays readable while decisions wait for HTTP to return.</p>
          <p><span className="font-medium text-foreground">Approval binds the action.</span> Hashes, transactions, and idempotency stop stale or duplicate execution.</p>
        </div>
      </div>
    </section>
  );
}
