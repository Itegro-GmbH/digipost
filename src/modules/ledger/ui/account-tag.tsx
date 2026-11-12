import { cn } from "@/shared/ui-primitives";

/** The two names of an account (decisions/0080 "Two names, always"): the plain German name
 * first, the SKR 04 number after it in a muted mono tag. */
export function AccountTag({ name, number, className }: { name: string; number: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-baseline gap-1.5", className)}>
      <span className="truncate">{name}</span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">{number}</span>
    </span>
  );
}
