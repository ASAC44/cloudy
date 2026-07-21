"use client";

import clsx from "clsx";
import Link from "next/link";
import { useState } from "react";

interface NavItem {
  name: string;
}

interface MorphicNavbarProps {
  items?: Record<string, NavItem>;
  defaultPath?: string;
  className?: string;
}

const DEFAULT_NAV_ITEMS: Record<string, NavItem> = {
  "/": { name: "Home" },
  "#use-cases": { name: "Use cases" },
  "#system-map": { name: "System map" },
  "/docs": { name: "Docs" },
  "https://github.com/ASAC44/cloudy": { name: "GitHub" },
};

export function MorphicNavbar({
  items = DEFAULT_NAV_ITEMS,
  defaultPath = "/",
  className,
}: MorphicNavbarProps) {
  const [activePath, setActivePath] = useState(defaultPath);

  const isActiveLink = (path: string) => {
    if (path === "/") {
      return activePath === "/";
    }
    return activePath.startsWith(path);
  };

  return (
    <nav
      aria-label="Primary navigation"
      className={clsx(
        "mx-auto max-w-4xl overflow-x-auto px-4 py-2",
        className
      )}
    >
      <div className="flex min-w-max items-center justify-center">
        <div className="glass flex w-max items-center justify-between overflow-hidden rounded-xl">
          {Object.entries(items).map(([path, { name }], index, array) => {
            const isActive = isActiveLink(path);
            const isFirst = index === 0;
            const isLast = index === array.length - 1;
            const prevPath = index > 0 ? array[index - 1][0] : null;
            const nextPath =
              index < array.length - 1 ? array[index + 1][0] : null;

            return (
              <Link
                className={clsx(
                  "flex min-h-10 shrink-0 items-center justify-center whitespace-nowrap bg-primary px-5 py-2.5 font-sans text-[0.9375rem] text-primary-foreground transition-all duration-300 hover:bg-primary/85 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  isActive
                    ? "mx-2 rounded-xl font-semibold"
                    : clsx(
                        (isActiveLink(prevPath || "") || isFirst) &&
                          "rounded-l-xl",
                        (isActiveLink(nextPath || "") || isLast) &&
                          "rounded-r-xl"
                      )
                )}
                href={path}
                key={path}
                onClick={() => setActivePath(path)}
              >
                {name}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export default MorphicNavbar;
