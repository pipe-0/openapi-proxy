import { cn } from "@/lib/utils";

/**
 * An operation's path, made to be scanned in a list. Ordinary UI text, not
 * monospace. The slashes step back so the words carry the path, and each
 * parameter is a small chip with its name and no braces, so `/check/{run_id}`
 * reads as "check, then a run id". The chip is tinted with the one accent
 * color, so the parts of a path that vary are found at a glance. A webhook's
 * name is shown as it is.
 */
export function OperationPath({
  path,
  webhook,
  className,
}: {
  path: string;
  webhook?: boolean | undefined;
  className?: string;
}) {
  if (webhook) return <span className={cn("min-w-0 truncate", className)}>{path}</span>;

  const parts = path.split(/(\{[^}]*\}|\/)/g).filter((part) => part !== "");
  return (
    <span className={cn("min-w-0 truncate", className)}>
      {parts.map((part, index) => {
        const key = `${index}:${part}`;
        if (part === "/") {
          return (
            <span key={key} className="px-[1.5px] text-faint">
              /
            </span>
          );
        }
        if (part.startsWith("{")) {
          return (
            <span
              key={key}
              className="mx-px rounded-[5px] bg-primary/[0.07] px-1 py-px text-[12px] font-semibold text-primary ring-1 ring-primary/20 ring-inset dark:bg-primary/[0.14]"
            >
              {part.slice(1, -1)}
            </span>
          );
        }
        return <span key={key}>{part}</span>;
      })}
    </span>
  );
}
