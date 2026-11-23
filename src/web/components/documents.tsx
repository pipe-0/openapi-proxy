import { CopyButton } from "@editor/components/copy-button";
import { DocsLink } from "@editor/components/docs-link";
import { Field, Notice, Section } from "@editor/components/page";
import { StatusChip } from "@editor/components/status-chip";
import {
  mainSourceName,
  projectName,
  projectSlug,
  type SourceView,
  sourcesOf,
} from "@editor/lib/project";
import {
  bareUrl,
  formatBytes,
  formatInterval,
  formatRelativeTime,
  looksLikeUrl,
  plural,
} from "@editor/lib/utils";
import { Button } from "@editor/ui/button";
import { Input } from "@editor/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@editor/ui/sheet";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  type HeaderDraft,
  HeaderEditor,
  headersComplete,
  newHeader,
  toHeaderInput,
} from "@/components/header-editor";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  api,
  errorMessage,
  type Project,
  type ProjectNote,
  queries,
  RequestError,
} from "@/lib/api";
import { checkStatus, useCheckProject } from "@/lib/hooks";
import { useApply } from "@/lib/use-apply";

const sheet = "w-full gap-0 data-[side=right]:sm:max-w-lg";

/** How the service comes by this document, in a word or two. */
function keptBy(source: SourceView): string {
  if (!source.definition.follow) return "Uploaded";
  if (source.state.validator === "etag") return "ETag";
  if (source.state.validator === "last-modified") return "Last-Modified";
  return "Full download";
}

/** Where a document comes from, as people read it. */
const whereOf = (source: SourceView): string =>
  source.definition.url ? bareUrl(source.definition.url) : (source.definition.file ?? "");

/**
 * A name for a document from its address: "https://billing.example.com/openapi.json"
 * is "billing". An address that names no one (an IP address, localhost) gives nothing.
 */
export function nameFromUrl(url: string): string {
  try {
    const { hostname } = new URL(url.trim());
    if (hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return "";
    return hostname.replace(/^(api|www)\./, "").split(".")[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * The documents a project is built from, as the list they are: one row each,
 * a sheet with a document's settings behind every row, and a button to add
 * another. With one document it is a list of one, and looks the same. This is
 * the head of the project's page, and what a project opens on.
 */
export function Documents({ project }: { project: Project }) {
  const refresh = useCheckProject(project);
  const [opened, setOpened] = useState<string>();
  const [adding, setAdding] = useState(false);
  const sources = sourcesOf(project);
  const several = sources.length > 1;
  const { check, can } = project.state;
  const status = check ? checkStatus(check) : undefined;
  const followed = sources.filter((source) => source.definition.follow);
  const quick = followed.every((source) => source.state.validator !== null);
  const current = sources.find((source) => source.label === opened);
  const name = projectName(project);

  return (
    <>
      <Section
        title="Documents"
        description={
          several ? (
            <>
              {name} is these documents merged into one. The main one gives it its title,
              description and servers, and wins where two define the same operation.{" "}
              <DocsLink slug="merging">How merging works</DocsLink>
            </>
          ) : (
            `The OpenAPI document ${name} is built from.`
          )
        }
        action={
          <>
            {can.check && (
              <Button
                variant="outline"
                onClick={() => refresh.mutate()}
                loading={refresh.isPending}
              >
                {!refresh.isPending && <RefreshCwIcon />}
                {followed.length > 1
                  ? "Check all documents for updates now"
                  : "Check for updates now"}
              </Button>
            )}
            {can.edit && (
              <Button onClick={() => setAdding(true)}>
                <PlusIcon /> Add document
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead className="hidden md:table-cell">From</TableHead>
                <TableHead className="text-right">Operations</TableHead>
                <TableHead className="hidden sm:table-cell">Kept current by</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => (
                <TableRow
                  key={source.label}
                  className="cursor-pointer"
                  onClick={() => setOpened(source.label)}
                >
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <button
                        type="button"
                        className="rounded-sm text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {source.definition.name ?? source.state.title ?? "Document"}
                      </button>
                      {several && source.main && <StatusChip tone="neutral">Main</StatusChip>}
                      {source.definition.pathPrefix && (
                        <span className="text-[13px] text-muted-foreground">
                          {source.definition.pathPrefix}
                        </span>
                      )}
                      {source.state.lastStatus === "error" && (
                        <StatusChip tone="bad">Check failed</StatusChip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="hidden max-w-64 truncate text-muted-foreground md:table-cell">
                    {whereOf(source)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {source.state.operations}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {keptBy(source)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <ChevronRightIcon className="size-4" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {check && status ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-muted-foreground">
              <StatusChip tone={status.tone} title={status.detail}>
                {status.label}
              </StatusChip>
              <span>
                We check {followed.length > 1 ? "the documents we follow" : "this document"} for
                updates every {formatInterval(check.intervalSeconds)}.{" "}
                {check.checkedAt === null
                  ? "It has not been checked yet."
                  : `The last check was ${formatRelativeTime(check.checkedAt)}.`}{" "}
                {check.watchUntil !== null && check.watchUntil > Date.now()
                  ? "It was just deployed, so we look every few minutes for a while. "
                  : ""}
                {quick ? (
                  <DocsLink slug="following-a-url">How checks work</DocsLink>
                ) : (
                  <>
                    For checks every 5 minutes, send an ETag with it.{" "}
                    <DocsLink slug="following-a-url#sending-an-etag">How</DocsLink>
                  </>
                )}
              </span>
            </p>
          ) : (
            <p className="text-[13px] leading-5 text-muted-foreground">
              {several ? "These documents were" : "This document was"} uploaded
              {project.state.applied ? ` ${formatRelativeTime(project.state.applied.at)}` : ""}, and{" "}
              {several ? "stay as they are" : "stays as it is"} until the next deploy. Nothing is
              checked in between.
            </p>
          )}
        </div>

        <div className="empty:hidden">
          <MergeNotes project={project} />
        </div>
      </Section>

      {current && (
        <DocumentSheet
          // A new form for each document, and for each state the server holds of it.
          key={JSON.stringify([current.definition, current.state])}
          project={project}
          source={current}
          onClose={() => setOpened(undefined)}
        />
      )}
      {adding && <AddDocumentSheet project={project} onClose={() => setAdding(false)} />}
    </>
  );
}

/** One document's settings: where it comes from, and how it is merged in. */
function DocumentSheet({
  project,
  source,
  onClose,
}: {
  project: Project;
  source: SourceView;
  onClose: () => void;
}) {
  const sources = sourcesOf(project);
  const several = sources.length > 1;
  const apply = useApply(project);
  const queryClient = useQueryClient();
  const { can } = project.state;
  const { definition, state } = source;
  const followed = definition.follow === true;
  const shown = definition.name ?? state.title ?? "Document";

  const [name, setName] = useState(definition.name ?? "");
  const [pathPrefix, setPathPrefix] = useState(definition.pathPrefix ?? "");
  const [headers, setHeaders] = useState<HeaderDraft[]>(() =>
    state.headerNames.map((headerName) => newHeader(headerName, true)),
  );

  const headerInput = toHeaderInput(headers);
  const headersChanged =
    headerInput.length !== state.headerNames.length ||
    headerInput.some(
      (header, index) => header.value !== undefined || header.name !== state.headerNames[index],
    );
  const entryChanged =
    name.trim() !== (definition.name ?? "") || pathPrefix.trim() !== (definition.pathPrefix ?? "");
  const dirty = entryChanged || headersChanged;
  const valid = (!several || name.trim() !== "") && headersComplete(headers);

  /** The definition with this source's entry replaced, or taken out. */
  const withSource = (next: typeof definition | undefined) => (current: Project["definition"]) => ({
    ...current,
    sources: current.sources.flatMap((entry, index) =>
      index === source.index ? (next ? [next] : []) : [entry],
    ),
  });
  const entry = (): typeof definition => {
    const { name: _name, pathPrefix: _prefix, ...rest } = definition;
    return {
      ...(name.trim() !== "" ? { name: name.trim() } : {}),
      ...rest,
      ...(pathPrefix.trim() !== "" ? { pathPrefix: pathPrefix.trim() } : {}),
    };
  };

  const save = useMutation({
    mutationFn: async () => {
      // Credentials are not part of the definition. Changed alone, they are
      // saved on their own, which works for a project that is deployed from a file too.
      if (!entryChanged) {
        await api.setCredentials(projectSlug(project), source.label, headerInput);
        await queryClient.invalidateQueries({ queryKey: queries.projects.queryKey });
        return;
      }
      const next = entry();
      await apply.mutateAsync({
        change: withSource(next),
        more: headersChanged ? { credentials: { [next.name ?? source.label]: headerInput } } : {},
      });
    },
    onSuccess: () => {
      toast.success(`${name.trim() || shown} saved`);
      onClose();
    },
  });
  const act = useMutation({
    mutationFn: (action: "main" | "remove") =>
      apply.mutateAsync(
        action === "remove"
          ? (current) => {
              const next = withSource(undefined)(current);
              // One document needs no main, and when the main one goes the first takes over.
              const [only] = next.sources;
              if (next.sources.length === 1 && only) {
                const { main: _, ...rest } = only;
                return { ...next, sources: [rest] };
              }
              return next.sources.some((entry) => entry.main)
                ? next
                : {
                    ...next,
                    sources: next.sources.map((entry, index) =>
                      index === 0 ? { ...entry, main: true } : entry,
                    ),
                  };
            }
          : (current) => ({
              ...current,
              sources: current.sources.map((entry, index) => {
                const { main: _, ...rest } = entry;
                return index === source.index ? { ...rest, main: true } : rest;
              }),
            }),
      ),
    onSuccess: (_, action) => {
      if (action === "remove") toast.success(`${shown} was taken out`);
      if (action === "main") toast.success(`${shown} is the main document now`);
      onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const saveError = save.error instanceof RequestError ? save.error : undefined;
  const id = (field: string) => `source-${source.index}-${field}`;
  const where = definition.url ?? definition.file ?? "";

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className={sheet}>
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{shown}</SheetTitle>
          <SheetDescription render={<div />} className="text-[13px]">
            <span className="flex items-center gap-1">
              <span className="truncate">{where}</span>
              {definition.url && (
                <CopyButton value={where} what="URL copied" variant="ghost" size="icon-xs" />
              )}
            </span>
            <span>
              {plural(state.operations, "operation")}, {formatBytes(state.bodyBytes)}, OpenAPI{" "}
              {state.specVersion}
              {several && source.main && ". The main document"}
            </span>
          </SheetDescription>
        </SheetHeader>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty && valid && !save.isPending) save.mutate();
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            {state.lastStatus === "error" && state.lastError && (
              <Notice tone="bad">
                <span className="font-medium">The last check failed.</span> {state.lastError} Its
                last good copy is still served.
              </Notice>
            )}

            {several && (
              <Field
                label="Name"
                htmlFor={id("name")}
                hint="Shown next to its operations, and used to rename what clashes in the merge."
              >
                <Input
                  id={id("name")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                  readOnly={!can.edit}
                />
              </Field>
            )}
            {(several || definition.pathPrefix) && (
              <Field
                label="Path prefix"
                htmlFor={id("prefix")}
                hint="Optional. Put in front of every path of this document."
              >
                <Input
                  id={id("prefix")}
                  value={pathPrefix}
                  onChange={(event) => setPathPrefix(event.target.value)}
                  placeholder="/billing"
                  spellCheck={false}
                  readOnly={!can.edit}
                />
              </Field>
            )}

            {followed && can.credentials && (
              <Field
                label="Credentials"
                hint="Request headers sent when fetching this document. Stored encrypted, never shown again, and not part of a definition file."
              >
                <HeaderEditor value={headers} onChange={setHeaders} />
              </Field>
            )}

            <p className="text-[13px] leading-5 text-muted-foreground">
              {!followed ? (
                <>
                  This copy was {definition.url ? "read from its address and " : ""}uploaded{" "}
                  {formatRelativeTime(state.readAt)}. It stays as it is until the next deploy brings
                  another.
                </>
              ) : state.validator ? (
                <>
                  We keep reading this address. A check is quick: it uses the{" "}
                  {keptBy(source).toLowerCase()}.
                </>
              ) : (
                <>
                  We keep reading this address. Each check downloads the whole document. An ETag
                  makes it quick.{" "}
                  <DocsLink slug="following-a-url#sending-an-etag">How to send one</DocsLink>
                </>
              )}
            </p>

            {(saveError || save.isError) && (
              <Notice tone="bad">
                <span className="font-medium">
                  {saveError?.message ?? errorMessage(save.error)}
                </span>
                {saveError?.detail && <span> {saveError.detail}</span>}
              </Notice>
            )}
          </div>

          <SheetFooter className="flex-row flex-wrap items-center border-t">
            <Button type="submit" disabled={!dirty || !valid} loading={save.isPending}>
              Save
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <span className="flex-1" />
            {can.edit && several && !source.main && (
              <Button
                variant="ghost"
                loading={act.isPending && act.variables === "main"}
                onClick={() => act.mutate("main")}
              >
                Make main
              </Button>
            )}
            {can.edit && several && (
              <Button
                variant="destructive-ghost"
                loading={act.isPending && act.variables === "remove"}
                onClick={() => {
                  const question = `Take ${shown} out of ${projectName(project)}? Its ${plural(state.operations, "operation")} disappear from every variant that serves them.`;
                  if (window.confirm(question)) act.mutate("remove");
                }}
              >
                Remove
              </Button>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Add one more document to a project. Its operations are merged into the project's. */
function AddDocumentSheet({ project, onClose }: { project: Project; onClose: () => void }) {
  const apply = useApply(project);
  const existing = sourcesOf(project);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const [pathPrefix, setPathPrefix] = useState("");
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  const taken = (candidate: string) =>
    existing.some((source) => source.label.toLowerCase() === candidate.trim().toLowerCase());

  const add = useMutation({
    mutationFn: () =>
      apply.mutateAsync({
        change: (definition) => {
          // With several, every document has a name and one of them leads.
          const others = definition.sources.map((source, index) => {
            const state = existing[index]?.state;
            const base =
              source.name !== undefined
                ? source
                : { name: firstFree(state?.title ?? "main", [name]), ...source };
            return definition.sources.some((entry) => entry.main) || index > 0
              ? base
              : { ...base, main: true };
          });
          return {
            ...definition,
            sources: [
              ...others,
              {
                name: name.trim(),
                url: url.trim(),
                follow: true,
                ...(pathPrefix.trim() !== "" ? { pathPrefix: pathPrefix.trim() } : {}),
              },
            ],
          };
        },
        more: headers.length > 0 ? { credentials: { [name.trim()]: toHeaderInput(headers) } } : {},
      }),
    onSuccess: () => {
      toast.success(`${name.trim()} was merged in`);
      onClose();
    },
    onError: (error) => {
      // Turned away: the source most likely wants credentials. Offer the field.
      if (error instanceof RequestError && error.detail?.includes("request header")) {
        setHeaders((current) => (current.length > 0 ? current : [newHeader("Authorization")]));
      }
    },
  });
  const error = add.error instanceof RequestError ? add.error : undefined;
  const nameProblem =
    name.trim() !== "" && taken(name) ? "Another document has this name." : undefined;
  const ready = looksLikeUrl(url) && name.trim() !== "" && !nameProblem && headersComplete(headers);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className={sheet}>
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Add document</SheetTitle>
          <SheetDescription className="text-[13px]">
            Its operations are merged into {projectName(project)}, and we keep reading its address
            for updates. <DocsLink slug="merging">How merging works</DocsLink>
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !add.isPending) add.mutate();
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            <Field label="Document URL" htmlFor="add-source-url">
              <Input
                id="add-source-url"
                autoFocus
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (!named)
                    setName(
                      firstFree(
                        nameFromUrl(event.target.value),
                        existing.map((source) => source.label),
                      ),
                    );
                  add.reset();
                }}
                placeholder="https://billing.example.com/openapi.json"
                className="text-[13px] md:text-[13px]"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Name"
              htmlFor="add-source-name"
              error={nameProblem}
              hint="Shown next to its operations, and used to rename what clashes in the merge."
            >
              <Input
                id="add-source-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNamed(true);
                }}
                placeholder="billing"
                maxLength={100}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            <Field
              label="Path prefix"
              htmlFor="add-source-prefix"
              hint="Optional. Put in front of every path of this document."
            >
              <Input
                id="add-source-prefix"
                value={pathPrefix}
                onChange={(event) => setPathPrefix(event.target.value)}
                placeholder="/billing"
                spellCheck={false}
              />
            </Field>
            {headers.length > 0 ? (
              <Field
                label="Credentials"
                hint="Request headers sent when fetching it. Stored encrypted."
              >
                <HeaderEditor value={headers} onChange={setHeaders} autoFocus={Boolean(error)} />
              </Field>
            ) : (
              <div>
                <Button variant="ghost" onClick={() => setHeaders([newHeader("Authorization")])}>
                  <KeyRoundIcon /> It needs credentials
                </Button>
              </div>
            )}
            {(error || add.isError) && (
              <Notice tone="bad">
                <span className="font-medium">{error?.message ?? errorMessage(add.error)}</span>
                {error?.detail && <span className="opacity-90"> {error.detail}</span>}
              </Notice>
            )}
          </div>
          <SheetFooter className="flex-row items-center border-t">
            <Button type="submit" disabled={!ready} loading={add.isPending}>
              {add.isPending ? "Fetching" : "Merge it in"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** A name that none of `taken` has, ignoring case: the one wanted, or that with a number. */
export function firstFree(wanted: string, taken: string[]): string {
  const used = new Set(taken.map((entry) => entry.trim().toLowerCase()));
  const base = wanted.trim();
  if (base === "") return "";
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    if (!used.has(`${base}-${n}`.toLowerCase())) return `${base}-${n}`;
  }
}

/** One merge note as a sentence. */
function sentenceFor(note: ProjectNote, main: string): string {
  switch (note.kind) {
    case "operation-left-out":
      return note.pathDiffers
        ? `${note.operation} of ${note.source} is left out: ${note.keptFrom} describes that path differently, so the two cannot share it.`
        : `${note.operation} of ${note.source} is left out, because ${note.keptFrom} defines it too.`;
    case "component-renamed":
      return `${note.from} of ${note.source} is served as ${note.to}: another document uses the name ${note.from} for something else.`;
    case "operation-id-renamed":
      return `The operation id ${note.from} of ${note.source} is served as ${note.to}, since ids have to be unique.`;
    case "servers-differ":
      return `${note.source} lists servers of its own. The merged document uses those of ${main}.`;
    case "source-converted":
      return `${note.source} was converted from OpenAPI ${note.from} to ${note.to}, so that it can be merged with the others.`;
  }
}

/** What putting the documents together did, for the owner to check once. */
function MergeNotes({ project }: { project: Project }) {
  const [all, setAll] = useState(false);
  if (project.state.notes.length === 0) return null;
  const { notes } = project.state;
  const main = mainSourceName(project) ?? "the main document";
  const shown = all ? notes : notes.slice(0, 4);
  return (
    <div>
      <p className="text-[13px] leading-5 font-medium">What merging changed</p>
      <ul className="mt-1.5 flex max-w-prose flex-col gap-1 text-[13px] leading-5 text-muted-foreground">
        {shown.map((note) => (
          <li key={JSON.stringify(note)}>{sentenceFor(note, main)}</li>
        ))}
      </ul>
      {notes.length > shown.length && (
        <Button variant="ghost" size="sm" className="mt-1 -ml-2.5" onClick={() => setAll(true)}>
          Show all {notes.length}
        </Button>
      )}
    </div>
  );
}
