import Image from "next/image";

export function MemoryArchitectureSection() {
  return (
    <section
      id="memory-map"
      aria-labelledby="memory-map-title"
      className="border-t border-border px-4 py-20 sm:px-6 sm:py-28 lg:py-32"
    >
      <div className="mx-auto max-w-[92rem]">
        <div className="grid gap-8 border-b border-border pb-10 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.58fr)] lg:items-end">
          <div>
            <p className="mb-5 font-mono text-xs tracking-[0.22em] text-clay uppercase">
              Memory architecture
            </p>
            <h2
              id="memory-map-title"
              className="max-w-5xl font-serif text-[clamp(2.75rem,6vw,5.75rem)] leading-[0.94] tracking-[-0.035em]"
            >
              Cloudy temporal memory engine.
            </h2>
          </div>
          <p className="max-w-xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8 lg:pb-1">
            Cloudy connects situations, people, channels, outcomes, and your
            writing style. It then proposes only an action you already authorized
            and returns the exact draft for review.
          </p>
        </div>

        <div className="overflow-x-auto border-y border-[#dfd7cc] bg-[#fffdf8] py-6">
          <Image
            src="/cloudy-memory-flow.svg"
            alt="Cloudy's memory learning loop from reviewed outcomes and scoped history through canonical storage, Graphiti retrieval, live context, action prediction, voice drafting, and human approval"
            width={1600}
            height={900}
            className="min-w-[64rem]"
          />
        </div>

        <div className="grid gap-6 border-b border-border py-8 text-sm leading-6 text-muted-foreground md:grid-cols-3">
          <p><span className="font-medium text-foreground">You choose what teaches it.</span> Only reviewed outcomes and explicitly scoped sent history become evidence.</p>
          <p><span className="font-medium text-foreground">Memory stays bounded.</span> Graph evidence can rank authorized choices, never invent a tool or recipient.</p>
          <p><span className="font-medium text-foreground">Fresh facts win.</span> Optional live reads such as Calendar verify the situation before the draft reaches you.</p>
        </div>
      </div>
    </section>
  );
}
