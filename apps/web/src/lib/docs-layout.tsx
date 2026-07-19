import Image from "next/image";

import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const docsLayoutOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="flex items-center gap-2 font-serif text-lg">
        <Image src="/podex-mascot.png" alt="" width={32} height={32} />
        Podex docs
      </span>
    ),
    url: "/docs",
  },
  githubUrl: "https://github.com/ASAC44/podex",
  links: [
    { text: "Podex", url: "/" },
    { text: "Dashboard", url: "/home" },
  ],
};
