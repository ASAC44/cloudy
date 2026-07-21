import Image from "next/image";

import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const docsLayoutOptions: BaseLayoutProps = {
  nav: {
    title: (
      <span className="flex items-center gap-2 font-serif text-lg">
        <Image src="/cloudy-mascot.png" alt="" width={32} height={32} />
        Cloudy docs
      </span>
    ),
    url: "/docs",
  },
  githubUrl: "https://github.com/ASAC44/cloudy",
  links: [
    { text: "Cloudy", url: "/" },
    { text: "Dashboard", url: "/home" },
  ],
};
