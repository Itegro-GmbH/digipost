import Link from "next/link";

import { cn } from "@/shared/ui-primitives";

export type LedgerTabItem = { href: string; label: string; active: boolean };

/**
 * A row of plain links that behaves like tabs (decisions/0080 UI: sub-pages and view modes live
 * in the URL, so every state is a link). `variant="tabs"` is a page's tab bar, `"toggle"` a small
 * segmented switch such as "Einfach | Soll/Haben". The active link carries `aria-current`.
 */
export function LedgerTabs({ items, label, variant = "tabs" }: { items: readonly LedgerTabItem[]; label: string; variant?: "tabs" | "toggle" }) {
  if (variant === "toggle") {
    return (
      <nav aria-label={label} className="inline-flex w-fit rounded-lg border border-border p-0.5 text-sm">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            scroll={false}
            aria-current={item.active ? "true" : undefined}
            className={cn("rounded-md px-2.5 py-1", item.active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    );
  }
  return (
    <nav aria-label={label} className="flex flex-wrap gap-1 border-b border-border text-sm">
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2",
            item.active ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
