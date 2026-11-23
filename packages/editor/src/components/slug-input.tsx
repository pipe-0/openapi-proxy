import { CheckIcon, DicesIcon, LoaderIcon } from "lucide-react";
import { cn } from "../lib/utils";

export function randomSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let slug = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    slug += alphabet[byte % alphabet.length];
  }
  return slug;
}

export type SlugStatus = "idle" | "checking" | "available" | "taken" | "invalid";

export const SLUG_HELP: Partial<Record<SlugStatus, string>> = {
  taken: "Already in use.",
  invalid: "2 to 64 characters: a-z, 0-9 and hyphens, not at the ends.",
};

/**
 * A slug edited in place inside the URL it produces: the fixed part of the
 * address is shown in front, dimmed, and the result of the availability check
 * behind it.
 */
export function SlugInput({
  prefix,
  value,
  onChange,
  status,
  label,
  allowRandom = false,
  className,
  id,
}: {
  prefix: string;
  value: string;
  onChange: (slug: string) => void;
  status: SlugStatus;
  label: string;
  allowRandom?: boolean;
  className?: string;
  id?: string;
}) {
  const wrong = status === "taken" || status === "invalid";
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center rounded-lg border border-input text-[13px] transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        wrong &&
          "border-destructive focus-within:border-destructive focus-within:ring-destructive/20",
        className,
      )}
    >
      <span className="max-w-[60%] shrink truncate pl-2.5 text-faint" dir="rtl" title={prefix}>
        <bdi>{prefix}</bdi>
      </span>
      <input
        id={id}
        value={value}
        onChange={(event) =>
          onChange(
            event.target.value
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, "-")
              .slice(0, 64),
          )
        }
        placeholder="docs"
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        aria-invalid={wrong}
        className="h-full min-w-16 flex-1 bg-transparent pr-1 outline-none placeholder:text-faint"
      />
      <span className="flex w-6 shrink-0 justify-center" aria-hidden="true">
        {status === "available" && <CheckIcon className="size-3.5 text-ok-foreground" />}
        {status === "checking" && <LoaderIcon className="size-3.5 animate-spin text-faint" />}
      </span>
      {allowRandom && (
        <button
          type="button"
          onClick={() => onChange(randomSlug())}
          title="Use a random, unguessable slug"
          aria-label="Use a random, unguessable slug"
          className="flex h-full shrink-0 items-center border-l px-2 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
        >
          <DicesIcon className="size-4" />
        </button>
      )}
    </div>
  );
}
