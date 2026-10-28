"use client";

import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/factory", label: "Request bug cases", current: (path: string) => path === "/factory" },
  { href: "/", label: "Example case", current: (path: string) => path === "/" || path.startsWith("/cases/") },
  { href: "/catalog", label: "Catalog", current: (path: string) => path === "/catalog" || path.startsWith("/runs/") },
] as const;

/** The site's navigation; the link for the page being shown is marked current. */
export function SiteNav() {
  const path = usePathname() as string | null ?? "";
  return (
    <nav aria-label="Site">
      {LINKS.map((link) => (
        <a key={link.href} href={link.href} aria-current={link.current(path) ? "page" : undefined}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}
