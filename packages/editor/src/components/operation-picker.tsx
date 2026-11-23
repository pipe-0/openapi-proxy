import {
  followTag,
  laterAdditions,
  type OperationEntry,
  pinTag,
  resolveSelection,
  type Selection,
  setOperationsServed,
  setTagServed,
  tagRule,
  withLaterAdditions,
} from "@openapi-proxy/core";
import { ChevronRightIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn, isTyping, plural } from "../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Kbd } from "../ui/kbd";
import { MethodChip } from "./method-chip";
import { OperationPath } from "./operation-path";
import { Segmented } from "./segmented";

export type PickerView = "all" | "served" | "hidden";
type Grouping = "tag" | "path";

interface Group {
  id: string;
  label: string;
  /** Set when the group is a tag, which is what makes rules possible. */
  tag?: string;
  entries: OperationEntry[];
}

const UNTAGGED = "\u0000untagged";
const WEBHOOKS = "\u0000webhooks";

function groupByTag(entries: OperationEntry[]): Group[] {
  const byTag = new Map<string, OperationEntry[]>();
  for (const entry of entries) {
    for (const tag of entry.tags.length > 0 ? new Set(entry.tags) : [UNTAGGED]) {
      const list = byTag.get(tag);
      if (list) list.push(entry);
      else byTag.set(tag, [entry]);
    }
  }
  const untagged = byTag.get(UNTAGGED);
  byTag.delete(UNTAGGED);
  const groups: Group[] = [...byTag].map(([tag, list]) => ({
    id: tag,
    label: tag,
    tag,
    entries: list,
  }));
  if (untagged) groups.push({ id: UNTAGGED, label: "No tag", entries: untagged });
  return groups;
}

/**
 * Group by the first meaningful path segment: what remains after dropping the
 * prefix every path shares (`/v1`) and any `{parameter}` segments.
 */
function groupByPath(entries: OperationEntry[]): Group[] {
  const segmentsOf = (path: string) => path.split("/").filter(Boolean);
  const paths = entries.filter((entry) => !entry.webhook).map((entry) => segmentsOf(entry.path));

  let shared = 0;
  for (; paths.length > 1; shared++) {
    const segment = paths[0]?.[shared];
    if (segment === undefined || segment.startsWith("{")) break;
    if (!paths.every((path) => path[shared] === segment && path.length > shared + 1)) break;
  }

  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const rest = segmentsOf(entry.path).slice(shared);
    const id = entry.webhook ? WEBHOOKS : (rest.find((segment) => !segment.startsWith("{")) ?? "/");
    const group = groups.get(id);
    if (group) group.entries.push(entry);
    else groups.set(id, { id, label: id === WEBHOOKS ? "Webhooks" : id, entries: [entry] });
  }
  return [...groups.values()];
}

interface OperationPickerProps {
  entries: OperationEntry[];
  selection: Selection;
  onChange: (selection: Selection) => void;
  view: PickerView;
  onViewChange: (view: PickerView) => void;
  /**
   * In a project merged from several documents, the name of the main one.
   * Operations that came from another are marked with where they came from.
   */
  mainSource?: string | undefined;
  /** Show what is served without letting it be changed: the selection is edited somewhere else. */
  readOnly?: boolean;
  className?: string;
}

/**
 * Every operation of the document, with one meaning for the checkbox: checked
 * is served. Checking a whole tag also covers the operations that are added
 * to that tag later, which a second checkbox on the tag shows and undoes
 * ("Serve operations added later"); the switch at the foot decides what
 * happens to everything else that shows up, and names the tags that are the
 * exception.
 *
 * (In the stored selection such a tag is a "rule". Nobody has to know the
 * word: the interface only says what happens.)
 */
/** Tags by name, as a sentence has them: "Search", "Search and Pipes", "Search, Pipes and 2 other tags". */
function tagList(tags: string[]): string {
  const [first, second, ...others] = tags;
  if (second === undefined) return String(first);
  if (others.length === 0) return `${first} and ${second}`;
  return `${first}, ${second} and ${plural(others.length, "other tag")}`;
}

export function OperationPicker({
  entries,
  selection,
  onChange: change,
  view,
  onViewChange,
  mainSource,
  readOnly = false,
  className,
}: OperationPickerProps) {
  // Read-only is said once, here: a row, its text and its box all change the selection through this.
  const onChange = readOnly ? () => {} : change;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const taggedShare =
    entries.filter((entry) => entry.tags.length > 0).length / (entries.length || 1);
  // By tag where the document has tags, by path where it does not. Not a
  // setting: with tags, "everything under /v1/admin" is one filter away.
  const grouping: Grouping = taggedShare >= 0.5 ? "tag" : "path";
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // "/" focuses the filter from anywhere on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !isTyping(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const served = useMemo(
    () => resolveSelection({ entries, tags: [], totalOperations: entries.length }, selection),
    [entries, selection],
  );
  const groups = useMemo(
    () => (grouping === "tag" ? groupByTag(entries) : groupByPath(entries)),
    [entries, grouping],
  );

  const needle = query.trim().toLowerCase();
  const visible = (entry: OperationEntry): boolean => {
    if (view === "served" && !served.has(entry.key)) return false;
    if (view === "hidden" && served.has(entry.key)) return false;
    if (needle === "") return true;
    return (
      entry.path.toLowerCase().includes(needle) ||
      entry.method.toLowerCase() === needle ||
      (entry.summary?.toLowerCase().includes(needle) ?? false) ||
      (entry.operationId?.toLowerCase().includes(needle) ?? false) ||
      (entry.source?.toLowerCase().includes(needle) ?? false) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  };
  const visibleGroups = groups
    .map((group) => ({ group, shown: group.entries.filter(visible) }))
    .filter(({ shown }) => shown.length > 0);
  const matching = new Set(visibleGroups.flatMap(({ shown }) => shown.map((entry) => entry.key)));

  // Whether what the API adds later is hidden, so that serving it takes a rule, or the other way round.
  const later = laterAdditions(selection);
  const including = later === "hidden";
  /** The tags whose rule is the exception to that. */
  const exceptions = including
    ? (selection.include?.tags ?? []).filter((tag) => tagRule(selection, tag) === "served")
    : (selection.exclude?.tags ?? []);
  const servedCount = entries.filter((entry) => served.has(entry.key)).length;

  /** Whether a tag also covers the operations that are added to it later. What is served now stays. */
  const follow = (tag: string, on: boolean) =>
    onChange(on ? followTag(entries, selection, tag) : pinTag(entries, selection, tag));
  const toggleGroup = (group: Group) => {
    const allServed = group.entries.every((entry) => served.has(entry.key));
    onChange(
      group.tag
        ? setTagServed(entries, selection, group.tag, !allServed)
        : setOperationsServed(
            entries,
            selection,
            group.entries.map((entry) => entry.key),
            !allServed,
          ),
    );
  };
  // Serve or hide everything, tag by tag, so the result is rules where rules are possible.
  const toggleAll = () => {
    const next = servedCount < entries.length;
    let draft = selection;
    for (const group of groupByTag(entries)) {
      draft = group.tag
        ? setTagServed(entries, draft, group.tag, next)
        : setOperationsServed(
            entries,
            draft,
            group.entries.map((entry) => entry.key),
            next,
          );
    }
    onChange(draft);
  };
  const toggleEntry = (entry: OperationEntry) =>
    onChange(setOperationsServed(entries, selection, [entry.key], !served.has(entry.key)));

  // Arrow keys walk the checkboxes, so the list can be worked without a mouse.
  const onListKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const boxes = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[data-slot="checkbox"]') ?? []),
    ];
    const index = boxes.indexOf(document.activeElement as HTMLElement);
    const next = boxes[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <div className="flex shrink-0 flex-col gap-2.5 border-b px-5 py-3">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  event.currentTarget.blur();
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  listRef.current?.querySelector<HTMLElement>('[data-slot="checkbox"]')?.focus();
                }
              }}
              placeholder="Filter operations"
              aria-label="Filter operations"
              className="h-8 w-full rounded-lg border border-input bg-transparent pr-8 pl-8 text-sm outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
            {query === "" ? (
              <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded text-faint hover:text-foreground"
                aria-label="Clear filter"
              >
                <XIcon className="size-4" />
              </button>
            )}
          </div>
          <Segmented
            aria-label="Show"
            value={view}
            onValueChange={onViewChange}
            options={[
              { value: "all", label: "All" },
              { value: "served", label: "Served" },
              { value: "hidden", label: "Hidden" },
            ]}
          />
        </div>

        {needle !== "" && matching.size > 0 && readOnly && (
          <span className="text-[13px] text-muted-foreground" aria-live="polite">
            {plural(matching.size, "match", "matches")}
          </span>
        )}
        {needle !== "" && matching.size > 0 && !readOnly && (
          <div className="flex items-center gap-1.5">
            <span className="flex-1 text-[13px] text-muted-foreground" aria-live="polite">
              {plural(matching.size, "match", "matches")}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange(setOperationsServed(entries, selection, matching, true))}
            >
              Serve all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onChange(setOperationsServed(entries, selection, matching, false))}
            >
              Hide all
            </Button>
          </div>
        )}
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the checkboxes inside */}
      <div
        ref={listRef}
        onKeyDown={onListKeyDown}
        className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3"
      >
        {entries.length > 0 && needle === "" && view === "all" && (
          <div className="flex h-10 items-center gap-2.5 border-b px-2">
            <Checkbox
              readOnly={readOnly}
              checked={servedCount === entries.length}
              indeterminate={servedCount > 0 && servedCount < entries.length}
              onCheckedChange={toggleAll}
              aria-label="Serve all operations"
            />
            <span className="text-[13px] text-muted-foreground">
              All operations
              <span className="ml-1.5 text-[12px] tabular-nums text-faint">
                {servedCount} of {entries.length}
              </span>
            </span>
          </div>
        )}
        {visibleGroups.length === 0 && (
          <p className="px-2 py-12 text-center text-[13px] text-muted-foreground">
            {entries.length === 0
              ? "This document defines no operations."
              : needle !== ""
                ? "No operation matches the filter."
                : "Nothing to show here."}
          </p>
        )}
        {visibleGroups.map(({ group, shown }) => {
          const servedHere = group.entries.filter((entry) => served.has(entry.key)).length;
          const all = servedHere === group.entries.length;
          // A tag can cover the operations that are added to it later ("a rule").
          const isRule =
            group.tag !== undefined &&
            tagRule(selection, group.tag) === (including ? "served" : "hidden");
          // It can start to once some of it is served. When the rest is served, a tag
          // can only hide what is added later if all of it is hidden: an exclusion wins.
          const canFollow = including ? servedHere > 0 : servedHere === 0;
          const isCollapsed = collapsed.has(group.id) && needle === "" && view === "all";
          return (
            <section key={group.id}>
              <div className="group/header sticky top-0 z-10 flex h-10 items-center gap-2.5 bg-background px-2">
                <Checkbox
                  readOnly={readOnly}
                  checked={all}
                  indeterminate={!all && servedHere > 0}
                  onCheckedChange={() => toggleGroup(group)}
                  aria-label={`${group.label}: serve all operations`}
                />
                <button
                  type="button"
                  onClick={() => {
                    const next = new Set(collapsed);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    setCollapsed(next);
                  }}
                  aria-expanded={!isCollapsed}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="truncate text-[13px] font-semibold">{group.label}</span>
                  <span className="text-[12px] tabular-nums text-faint">
                    {servedHere} of {group.entries.length}
                  </span>
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 text-faint transition-transform",
                      !isCollapsed && "rotate-90",
                    )}
                  />
                </button>
                {group.tag && (isRule || canFollow) && (
                  // One wording, and a checkbox that says whether it holds: a
                  // control that looks like one, with no second text for its other state.
                  <span
                    className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground"
                    title={`When the source adds an operation to ${group.label}, ${including ? "serve" : "hide"} it as well.`}
                  >
                    <Checkbox
                      readOnly={readOnly}
                      checked={isRule}
                      onCheckedChange={() => follow(group.tag as string, !isRule)}
                      aria-label={`${group.label}: ${including ? "serve" : "hide"} operations added later`}
                    />
                    {/* The text toggles it too, as a label would. Hidden from assistive technology: the checkbox carries the name. */}
                    <span
                      aria-hidden="true"
                      className="cursor-default"
                      onClick={() => follow(group.tag as string, !isRule)}
                    >
                      {including ? "Serve" : "Hide"} operations added later
                    </span>
                  </span>
                )}
              </div>

              {!isCollapsed && (
                <ul>
                  {shown.map((entry) => {
                    const isServed = served.has(entry.key);
                    return (
                      <li key={entry.key}>
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: the whole row is a click target; the checkbox inside carries the accessible interaction */}
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users operate the focusable checkbox */}
                        <div
                          onClick={() => toggleEntry(entry)}
                          // The description is one hover away instead of on every line.
                          title={[entry.deprecated ? "Deprecated." : "", entry.summary ?? ""]
                            .filter(Boolean)
                            .join(" ")}
                          className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 hover:bg-muted/60"
                        >
                          <Checkbox
                            readOnly={readOnly}
                            checked={isServed}
                            onCheckedChange={() => toggleEntry(entry)}
                            onClick={(event) => event.stopPropagation()}
                            aria-label={entry.key}
                          />
                          <MethodChip
                            method={entry.method}
                            className={cn(!isServed && "opacity-55")}
                          />
                          <OperationPath
                            path={entry.path}
                            webhook={entry.webhook}
                            className={cn(
                              "flex-1 text-[13.5px]",
                              !isServed && "text-muted-foreground",
                              entry.deprecated && "line-through decoration-faint",
                            )}
                          />
                          {entry.webhook && (
                            <span className="text-[12px] text-muted-foreground">webhook</span>
                          )}
                          {entry.source && entry.source !== mainSource && (
                            <span className="shrink-0 text-[12px] text-faint">{entry.source}</span>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-t px-5 py-2.5">
        <div className="flex items-center gap-3">
          <span className="flex h-8 items-center text-[13px] text-muted-foreground">
            Operations your API adds later are{readOnly ? ` ${later}.` : ""}
          </span>
          {!readOnly && (
            <Segmented
              aria-label="Operations your API adds later are"
              value={later}
              onValueChange={(next) => onChange(withLaterAdditions(entries, selection, next))}
              options={[
                { value: "hidden", label: "Hidden" },
                { value: "served", label: "Served" },
              ]}
            />
          )}
        </div>
        {/* Always a line of its own, said or not: the foot keeps its height. */}
        <p className="text-[12.5px] leading-[18px] text-faint">
          {exceptions.length > 0
            ? `Except in ${tagList(exceptions)}, where they are ${including ? "served" : "hidden"}.`
            : "In every tag."}
        </p>
      </div>
    </div>
  );
}
