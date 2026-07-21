"use client";

import dynamic from "next/dynamic";

const InteractiveArchitecture = dynamic(
  () =>
    import("@/components/landing/interactive-architecture").then(
      (module) => module.InteractiveArchitecture,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-[#fffdf8] font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
        Drawing the system map…
      </div>
    ),
  },
);

export function ArchitectureCanvas() {
  return <InteractiveArchitecture />;
}
