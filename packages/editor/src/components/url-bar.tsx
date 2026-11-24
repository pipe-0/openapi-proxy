import type { SpecFormat, Visibility } from "@openapi-proxy/core";
import { ExternalLinkIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { CopyButton } from "./copy-button";
import { DocsLink } from "./docs-link";
import { Segmented } from "./segmented";
import { type InheritedVisibility, VisibilityMenu } from "./visibility";

/** The variant's address: the reason the screen exists, always in view. */
export function UrlBar({
  url,
  suffix,
  format,
  onFormatChange,
  celebrate,
  stated,
  inherited,
  onVisibilityChange,
  busy,
  withKeys,
  privateAction,
  formatHere = false,
}: {
  url: string;
  /** What follows the URL for the representation on screen: `.json`, or `/3.0.json`. */
  suffix: string;
  format: SpecFormat;
  onFormatChange: (format: SpecFormat) => void;
  celebrate: boolean;
  stated: Visibility | undefined;
  inherited: InheritedVisibility;
  onVisibilityChange: (next: Visibility | undefined) => void;
  busy: boolean;
  /** Whether a private variant is read with a key here. On a laptop it is not: the machine is its owner's. */
  withKeys: boolean;
  /** Where a key for this variant is made, where there are keys. */
  privateAction: React.ReactNode;
  /** Show the format switch on every screen: there is no preview beside it to carry it. */
  formatHere?: boolean;
}) {
  const address = `${url}${suffix}`;
  const { origin, pathname } = new URL(url);
  const isPrivate = (stated ?? inherited.value) === "private";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={cn(
            "flex h-8 max-w-xl min-w-0 flex-1 items-center rounded-lg border bg-subtle px-2.5 max-sm:basis-full",
            celebrate && "animate-arrive",
          )}
        >
          <code
            className="truncate font-sans text-[13px]"
            title={address}
            data-testid="variant-url"
          >
            <span className="text-faint">{origin}</span>
            {pathname}
            <span className="text-faint">{suffix}</span>
          </code>
        </div>
        {/* On wide screens the format switch lives with the preview it controls. */}
        <Segmented
          aria-label="Format"
          className={formatHere ? undefined : "lg:hidden"}
          value={format}
          onValueChange={onFormatChange}
          options={[
            { value: "json", label: "JSON" },
            { value: "yaml", label: "YAML" },
          ]}
        />
        <CopyButton value={address} label="Copy URL" what="URL copied" autoFocus={celebrate} />
        <VisibilityMenu
          stated={stated}
          inherited={inherited}
          onChange={onVisibilityChange}
          disabled={busy}
        />
        {/* A browser sends no key, so there is nothing to open a private one with. */}
        {(!isPrivate || !withKeys) && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Open in a new tab"
                  nativeButton={false}
                  render={<a href={address} target="_blank" rel="noreferrer" />}
                />
              }
            >
              <ExternalLinkIcon />
            </TooltipTrigger>
            <TooltipContent>Open in a new tab</TooltipContent>
          </Tooltip>
        )}
      </div>
      {isPrivate && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-[18px] text-muted-foreground">
          {withKeys ? (
            <span>
              Readers send a user API key as{" "}
              <span className="font-medium text-foreground">Authorization: Bearer</span>.
            </span>
          ) : (
            <span>
              Once deployed, readers send a user API key. On this machine it is served without one.
            </span>
          )}
          {privateAction}
          <DocsLink slug="private-variants">How private variants work</DocsLink>
        </p>
      )}
    </div>
  );
}
