import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The one thing to do on the landing page: say where your document is. A plain
 * form, so it works before any script has loaded. `/connect` belongs to the
 * app, which asks the visitor to sign in and then carries on with the URL.
 */
export function UrlForm({ id, className }: { id: string; className?: string }) {
  return (
    <form
      action="/connect"
      method="get"
      className={cn("flex flex-col gap-2 sm:flex-row", className)}
    >
      <label htmlFor={id} className="sr-only">
        URL of your OpenAPI document
      </label>
      <input
        id={id}
        name="url"
        type="url"
        required
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        placeholder="https://api.example.com/openapi.json"
        className="h-11 w-full min-w-0 shrink-0 rounded-lg sm:w-auto sm:flex-1 sm:shrink border border-input bg-background px-3.5 text-[15px] outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40"
      />
      <Button type="submit" size="lg" className="h-11 px-5 text-[15px]">
        Continue
        <ArrowRightIcon />
      </Button>
    </form>
  );
}
