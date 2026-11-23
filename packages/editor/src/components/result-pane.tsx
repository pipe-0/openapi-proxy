import {
  buildVariant,
  type DocumentOverrides,
  DocumentTooComplexError,
  type Selection,
  type SpecFormat,
  serialize,
  TARGET_VERSIONS,
  type TargetVersion,
} from "@openapi-proxy/core";
import { ChevronDownIcon, DownloadIcon } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import { type ProjectDoc, representation } from "../lib/document";
import { highlightLine, type TokenKind } from "../lib/highlight";
import { byteLength, cn, formatBytes } from "../lib/utils";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { CopyButton } from "./copy-button";
import { Notice } from "./page";
import { Segmented } from "./segmented";

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
  overrides,
  onVersionChange,
  path,
  format,
  onFormatChange,
  filename,
  className,
}: {
  /** The assembled document. Not here yet: undefined. Could not be loaded: null. */
  source: ProjectDoc | null | undefined;
  /** The OpenAPI version of the project's document: "3.0", "3.1" or "3.2". */
  sourceVersion: string;
  selection: Selection;
  /** The version on screen; null is the document's own. Every variant is served in each. */
  version: TargetVersion | null;
  /** The variant's public path, once it has one: each version says where it is served. */
  path?: string | undefined;
  /** The title, description and servers this variant states itself. */
  overrides: DocumentOverrides | null;
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
    try {
      const built = buildVariant(source.doc, { selection: deferred, version, overrides });
      const served = serialize(built.doc, "json", { minified: source.minified });
      return { ...built, bytes: byteLength(served) };
    } catch (error) {
      // A document can be valid and still be more than can be served once it
      // is cut down. The engine says why; the server would answer the same.
      return {
        failure:
          error instanceof DocumentTooComplexError
            ? error.message
            : "This selection could not be put together.",
      };
    }
  }, [source, deferred, version, overrides]);

  // For reading, JSON is always indented. What is served mirrors the source's formatting.
  const text = useMemo(() => {
    if (!result || "failure" in result || !source) return "";
    return serialize(result.doc, format);
  }, [result, source, format]);
  const lines = useMemo(() => text.split("\n"), [text]);

  if (source === null) {
    return (
      <div className={cn("flex flex-col justify-center p-5", className)}>
        <p className="text-center text-[13px] text-muted-foreground">
          There is no preview: the document could not be loaded.
        </p>
      </div>
    );
  }

  if (!source || !result) {
    return (
      <div className={cn("flex flex-col gap-4 p-5", className)} aria-busy="true">
        <Skeleton className="h-14" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if ("failure" in result) {
    return (
      <div className={cn("p-5", className)}>
        <Notice tone="bad">
          <span className="font-medium">This variant cannot be served as it is.</span>{" "}
          {result.failure}
        </Notice>
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
          <VersionMenu
            sourceVersion={sourceVersion}
            version={version}
            onChange={onVersionChange}
            path={path}
            format={format}
          />
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
 * Which OpenAPI version of the variant is on screen: the documents' own, or
 * one it is converted to. Every variant is served in each, and the URL in the
 * editor follows what is picked here. A document in a version that cannot be
 * converted just says what it is.
 */
function VersionMenu({
  sourceVersion,
  version,
  onChange,
  path,
  format,
}: {
  sourceVersion: string;
  version: TargetVersion | null;
  onChange: (version: TargetVersion | null) => void;
  path: string | undefined;
  format: SpecFormat;
}) {
  const others = TARGET_VERSIONS.filter((target) => target !== sourceVersion);
  const convertible = TARGET_VERSIONS.some((target) => target === sourceVersion);
  if (!convertible) {
    return <span className="text-[13px] text-muted-foreground">OpenAPI {sourceVersion}</span>;
  }
  // Where a version is served, under what it is: the URL is how a reader picks one.
  const item = (value: TargetVersion | null, label: string) => (
    <DropdownMenuRadioItem key={value ?? "own"} value={value ?? ""} closeOnClick>
      <span className="flex min-w-0 flex-col">
        <span>{label}</span>
        {path && (
          <span className="truncate text-[12.5px] leading-[18px] text-muted-foreground">
            {path}
            {representation(value, format)}
          </span>
        )}
      </span>
    </DropdownMenuRadioItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" aria-label="OpenAPI version" />}
      >
        OpenAPI {version ?? sourceVersion}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuRadioGroup
          value={version ?? ""}
          onValueChange={(value) => onChange(value === "" ? null : (value as TargetVersion))}
        >
          {item(null, `${sourceVersion}, as your API has it`)}
          {others.map((target) => item(target, `${target}, converted`))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
