import {
  buildVariant,
  type Selection,
  type SpecFormat,
  serialize,
  TARGET_VERSIONS,
  type TargetVersion,
} from "@openapi-proxy/core";
import { ChevronDownIcon, DownloadIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { highlightLine, type TokenKind } from "@/lib/highlight";
import type { ProjectDoc } from "@/lib/use-project-doc";
import { byteLength, cn, formatBytes } from "@/lib/utils";

const LINES_PER_PAGE = 400;

const TOKEN_CLASS: Record<TokenKind, string> = {
  key: "text-(--code-key)",
  string: "text-(--code-string)",
  number: "text-(--code-number)",
  punctuation: "text-(--code-punctuation)",
  plain: "",
};

/**
 * What the variant serves, live: the numbers that matter and the document
 * itself. It is computed in the browser with the same filter and serializer
 * the server uses, so this is the served document, not an approximation.
 */
export function ResultPane({
  source,
  sourceVersion,
  selection,
  version,
  onVersionChange,
  format,
  onFormatChange,
  filename,
  className,
}: {
  source: ProjectDoc | undefined;
  /** The OpenAPI version of the project's document: "3.0", "3.1" or "3.2". */
  sourceVersion: string;
  selection: Selection;
  /** The version this variant asks to be served in; null is the project's own. */
  version: TargetVersion | null;
  onVersionChange: (version: TargetVersion | null) => void;
  /** One format for the whole editor: the preview shows what the URL above returns. */
  format: SpecFormat;
  onFormatChange: (format: SpecFormat) => void;
  /** Used when downloading, e.g. `public-docs`. */
  filename: string;
  className?: string;
}) {
  const [lineLimit, setLineLimit] = useState(LINES_PER_PAGE);
  // The list on the left stays responsive while a large document re-renders here.
  const deferred = useDeferredValue(selection);
  const stale = deferred !== selection;

  const result = useMemo(() => {
    if (!source) return undefined;
    const built = buildVariant(source.doc, { selection: deferred, version });
    const served = serialize(built.doc, "json", { indent: source.indent });
    return { ...built, bytes: byteLength(served) };
  }, [source, deferred, version]);

  // For reading, JSON is always indented. What is served mirrors the source's formatting.
  const text = useMemo(() => {
    if (!result || !source) return "";
    return serialize(result.doc, format, { indent: source.indent === 0 ? 2 : source.indent });
  }, [result, source, format]);
  const lines = useMemo(() => text.split("\n"), [text]);

  if (!source || !result) {
    return (
      <div className={cn("flex flex-col gap-4 p-5", className)} aria-busy="true">
        <Skeleton className="h-14" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const { stats, bytes } = result;
  const schemas = {
    kept: stats.keptComponents.schemas ?? 0,
    total: stats.totalComponents.schemas ?? 0,
  };

  const download = () => {
    const blob = new Blob([text], {
      type: format === "json" ? "application/json" : "application/yaml",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filename}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <div className="flex shrink-0 flex-col gap-3 border-b px-5 py-3">
        <div className="flex items-center gap-3">
          <Segmented
            aria-label="Format"
            value={format}
            onValueChange={onFormatChange}
            options={[
              { value: "json", label: "JSON" },
              { value: "yaml", label: "YAML" },
            ]}
          />
          <p
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] text-muted-foreground transition-opacity",
              stale && "opacity-60",
            )}
            title={`${formatBytes(bytes)}. ${schemas.kept} of ${schemas.total} schemas come along: the ones the served operations use.`}
          >
            <span
              className="font-medium text-foreground tabular-nums"
              data-testid="served-operations"
            >
              {stats.keptOperations.toLocaleString("en-US")}
            </span>{" "}
            of {stats.totalOperations.toLocaleString("en-US")} operations
          </p>
          <VersionMenu sourceVersion={sourceVersion} version={version} onChange={onVersionChange} />
          <Tooltip>
            <TooltipTrigger
              render={
                <CopyButton value={text} what="Document copied" size="icon" variant="ghost" />
              }
            />
            <TooltipContent>Copy the document</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon" aria-label="Download" onClick={download} />
              }
            >
              <DownloadIcon />
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {result.losses.length > 0 && (
        <p className="shrink-0 border-b bg-subtle px-5 py-2 text-[12.5px] leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">
            OpenAPI {version} cannot say everything.
          </span>{" "}
          Left out: {result.losses.map((loss) => `${loss.what} (${loss.count})`).join(", ")}.
        </p>
      )}

      {stats.keptOperations === 0 && (
        <p className="shrink-0 border-b bg-subtle px-5 py-2 text-[12.5px] leading-5 text-muted-foreground">
          Nothing is served yet. The document is valid, and empty.
        </p>
      )}

      <div
        className={cn(
          "scroll-quiet min-h-0 flex-1 overflow-auto bg-subtle transition-opacity",
          stale && "opacity-60",
        )}
      >
        <pre
          className="min-w-max px-5 py-3 font-mono text-[12px] leading-[19px]"
          data-testid="result-document"
        >
          {lines.slice(0, lineLimit).map((line, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of one rendered text
              key={index}
            >
              {highlightLine(line, format).map(([kind, value], tokenIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one line
                <span key={tokenIndex} className={TOKEN_CLASS[kind]}>
                  {value}
                </span>
              ))}
            </div>
          ))}
        </pre>
        {lines.length > lineLimit && (
          <div className="sticky left-0 flex items-center gap-3 border-t bg-background px-5 py-2.5 text-[12.5px] text-muted-foreground">
            <span>
              {lineLimit.toLocaleString("en-US")} of {lines.length.toLocaleString("en-US")} lines
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLineLimit((limit) => limit + LINES_PER_PAGE * 5)}
            >
              Show more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Which OpenAPI version the variant is served in: the project's own, or one
 * it is converted to. A document in a version that cannot be converted just
 * says what it is.
 */
function VersionMenu({
  sourceVersion,
  version,
  onChange,
}: {
  sourceVersion: string;
  version: TargetVersion | null;
  onChange: (version: TargetVersion | null) => void;
}) {
  const others = TARGET_VERSIONS.filter((target) => target !== sourceVersion);
  const convertible = TARGET_VERSIONS.some((target) => target === sourceVersion);
  if (!convertible) {
    return <span className="text-[13px] text-muted-foreground">OpenAPI {sourceVersion}</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" aria-label="OpenAPI version served" />}
      >
        OpenAPI {version ?? sourceVersion}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuRadioGroup
          value={version ?? ""}
          onValueChange={(value) => onChange(value === "" ? null : (value as TargetVersion))}
        >
          <DropdownMenuRadioItem value="" closeOnClick>
            {sourceVersion}, as the source has it
          </DropdownMenuRadioItem>
          {others.map((target) => (
            <DropdownMenuRadioItem key={target} value={target} closeOnClick>
              {target}, converted
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
