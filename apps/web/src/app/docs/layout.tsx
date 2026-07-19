import type { ReactNode } from "react";

import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { docsLayoutOptions } from "@/lib/docs-layout";
import { docsSource } from "@/lib/docs-source";

export default function DocsRootLayout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      {...docsLayoutOptions}
      tree={docsSource.getPageTree()}
      sidebar={{ prefetch: false }}
    >
      {children}
    </DocsLayout>
  );
}
