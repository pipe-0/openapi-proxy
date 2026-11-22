import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, KeyRoundIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { DocsLink } from "@/components/docs-link";
import {
  type HeaderDraft,
  HeaderEditor,
  headersComplete,
  newHeader,
  toHeaderInput,
} from "@/components/header-editor";
import { Field, Notice, Section } from "@/components/page";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  bareUrl,
  errorMessage,
  type Project,
  type ProjectNote,
  queries,
  RequestError,
  type Source,
} from "@/lib/api";
import { sourceStatus, useCheckProject } from "@/lib/hooks";
import { formatBytes, formatInterval, formatRelativeTime, looksLikeUrl, plural } from "@/lib/utils";

/** Put a project the server just returned into the list everything reads from. */
function useProjectUpdate() {
  const queryClient = useQueryClient();
  return (updated: Project) => {
    queryClient.setQueryData<Project[]>(queries.projects.queryKey, (current) =>
      current?.map((existing) => (existing.id === updated.id ? updated : existing)),
    );
    void queryClient.invalidateQueries({ queryKey: queries.variants.queryKey });
  };
}

const sheet = "w-full gap-0 data-[side=right]:sm:max-w-lg";

/** How a check finds out whether this document changed, in a word or two. */
function checkedBy(source: Source): string {
  if (source.versionUrl && !source.versionMismatchAt) return "Version endpoint";
  if (source.validator === "etag") return "ETag";
  if (source.validator === "last-modified") return "Last-Modified";
  return "Full download";
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
  const several = project.sources.length > 1;
  const status = sourceStatus(project);
  const quick = project.sources.every((source) => source.cheap);
  const current = project.sources.find((source) => source.id === opened);

  return (
    <>
      <Section
        title="Documents"
        description={
          several ? (
            <>
              {project.name} is these documents merged into one, in this order. The main one gives
              it its title, description and servers.{" "}
              <DocsLink slug="merging">How merging works</DocsLink>
            </>
          ) : (
            `The OpenAPI document ${project.name} is built from.`
          )
        }
        action={
          <>
            <Button variant="outline" onClick={() => refresh.mutate()} loading={refresh.isPending}>
              {!refresh.isPending && <RefreshCwIcon />}
              {several ? "Check all documents for updates now" : "Check for updates now"}
            </Button>
            <Button onClick={() => setAdding(true)}>
              <PlusIcon /> Add document
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead className="hidden md:table-cell">URL</TableHead>
                <TableHead className="text-right">Operations</TableHead>
                <TableHead className="hidden sm:table-cell">Each check</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {project.sources.map((source, index) => (
                <TableRow
                  key={source.id}
                  className="cursor-pointer"
                  onClick={() => setOpened(source.id)}
                >
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <button
                        type="button"
                        className="rounded-sm text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {source.name}
                      </button>
                      {several && index === 0 && <StatusChip tone="neutral">Main</StatusChip>}
                      {source.pathPrefix && (
                        <span className="text-[13px] text-muted-foreground">
                          {source.pathPrefix}
                        </span>
                      )}
                      {source.lastStatus === "error" && (
                        <StatusChip tone="bad">Check failed</StatusChip>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="hidden max-w-64 truncate text-muted-foreground md:table-cell">
                    {bareUrl(source.url)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{source.operations}</TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {checkedBy(source)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <ChevronRightIcon className="size-4" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-muted-foreground">
            <StatusChip tone={status.tone} title={status.detail}>
              {status.label}
            </StatusChip>
            <span>
              We check {several ? "these documents" : "this document"} for updates every{" "}
              {formatInterval(project.checkIntervalSeconds)}. The last check was{" "}
              {formatRelativeTime(project.fetchedAt)}.{" "}
              {quick ? (
                <DocsLink slug="keeping-in-sync">How checks work</DocsLink>
              ) : (
                <>
                  For checks every 5 minutes, add an ETag or a version endpoint.{" "}
                  <DocsLink slug="keeping-in-sync">How</DocsLink>
                </>
              )}
            </span>
          </p>
        </div>

        <div className="empty:hidden">
          <MergeNotes project={project} />
        </div>
      </Section>

      {current && (
        <DocumentSheet
          // A new form for each document, and for each state the server holds of it.
          key={JSON.stringify(current)}
          project={project}
          source={current}
          onClose={() => setOpened(undefined)}
        />
      )}
      {adding && <AddDocumentSheet project={project} onClose={() => setAdding(false)} />}
    </>
  );
}

/** One document's settings: how it is fetched, checked and merged in. */
function DocumentSheet({
  project,
  source,
  onClose,
}: {
  project: Project;
  source: Source;
  onClose: () => void;
}) {
  const several = project.sources.length > 1;
  const main = project.sources[0]?.id === source.id;
  const update = useProjectUpdate();

  const [name, setName] = useState(source.name);
  const [pathPrefix, setPathPrefix] = useState(source.pathPrefix ?? "");
  const [versionUrl, setVersionUrl] = useState(source.versionUrl ?? "");
  const [headers, setHeaders] = useState<HeaderDraft[]>(() =>
    source.headerNames.map((headerName) => newHeader(headerName, true)),
  );

  const headerInput = toHeaderInput(headers);
  const headersChanged =
    headerInput.length !== source.headerNames.length ||
    headerInput.some(
      (header, index) => header.value !== undefined || header.name !== source.headerNames[index],
    );
  const changes: Parameters<typeof api.updateSource>[2] = {
    ...(name.trim() !== source.name ? { name: name.trim() } : {}),
    ...(pathPrefix.trim() !== (source.pathPrefix ?? "")
      ? { pathPrefix: pathPrefix.trim() || null }
      : {}),
    ...(versionUrl.trim() !== (source.versionUrl ?? "")
      ? { versionUrl: versionUrl.trim() || null }
      : {}),
    ...(headersChanged ? { headers: headerInput } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const valid = name.trim() !== "" && headersComplete(headers);

  const save = useMutation({
    mutationFn: () => api.updateSource(project.id, source.id, changes),
    onSuccess: (updated) => {
      update(updated);
      toast.success(`${name.trim()} saved`);
      onClose();
    },
  });
  const act = useMutation({
    mutationFn: (action: "main" | "remove" | "trust") => {
      if (action === "main") return api.makeMainSource(project.id, source.id);
      if (action === "remove") return api.removeSource(project.id, source.id);
      // Saving the endpoint again, unchanged, is how it gets a second chance.
      return api.updateSource(project.id, source.id, { versionUrl: source.versionUrl });
    },
    onSuccess: (updated, action) => {
      update(updated);
      if (action === "remove") toast.success(`${source.name} was taken out`);
      if (action === "main") toast.success(`${source.name} is the main document now`);
      if (action === "trust") toast.success("Version endpoint is in use again");
      if (action !== "trust") onClose();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const saveError = save.error instanceof RequestError ? save.error : undefined;
  const id = (field: string) => `${source.id}-${field}`;
  const quick = source.cheap;

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className={sheet}>
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{source.name}</SheetTitle>
          <SheetDescription render={<div />} className="text-[13px]">
            <span className="flex items-center gap-1">
              <span className="truncate">{source.url}</span>
              <CopyButton value={source.url} what="URL copied" variant="ghost" size="icon-xs" />
            </span>
            <span>
              {plural(source.operations, "operation")}, {formatBytes(source.bodyBytes)}, OpenAPI{" "}
              {source.specVersion}
              {several && main && ". The main document"}
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
            {source.lastStatus === "error" && source.lastError && (
              <Notice tone="bad">
                <span className="font-medium">The last check failed.</span> {source.lastError} Its
                last good copy is still served.
              </Notice>
            )}

            {several && (
              <>
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
                  />
                </Field>
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
                  />
                </Field>
              </>
            )}

            <Field
              label="Version endpoint"
              htmlFor={id("version")}
              hint={
                <>
                  Optional. A URL that says which build is live, so a check does not have to
                  download the document.{" "}
                  <DocsLink slug="version-endpoint">What it can return</DocsLink>
                  {source.versionUrl && !source.versionMismatchAt && source.lastKnownVersion && (
                    <>
                      {" "}
                      Now reporting{" "}
                      <span className="font-medium text-foreground">{source.lastKnownVersion}</span>
                      .
                    </>
                  )}
                </>
              }
            >
              <div className="space-y-2">
                <Input
                  id={id("version")}
                  value={versionUrl}
                  onChange={(event) => setVersionUrl(event.target.value)}
                  placeholder="https://api.example.com/version"
                  className="text-[13px] md:text-[13px]"
                  spellCheck={false}
                />
                {source.versionUrl && source.versionMismatchAt && (
                  <Notice
                    tone="warn"
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        loading={act.isPending && act.variables === "trust"}
                        onClick={() => act.mutate("trust")}
                      >
                        Use it again
                      </Button>
                    }
                  >
                    It reported one version for two different documents, so it is not used.
                  </Notice>
                )}
              </div>
            </Field>

            <Field
              label="Credentials"
              hint="Request headers sent when fetching this document. Stored encrypted, never shown again."
            >
              <HeaderEditor value={headers} onChange={setHeaders} />
            </Field>

            <p className="text-[13px] leading-5 text-muted-foreground">
              {quick ? (
                <>A check is quick: it uses the {checkedBy(source).toLowerCase()}.</>
              ) : (
                <>
                  Each check downloads the whole document. An ETag makes it quick.{" "}
                  <DocsLink slug="etag">How to send one</DocsLink>
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
            {several && !main && (
              <Button
                variant="ghost"
                loading={act.isPending && act.variables === "main"}
                onClick={() => act.mutate("main")}
              >
                Make main
              </Button>
            )}
            {several && (
              <Button
                variant="destructive-ghost"
                loading={act.isPending && act.variables === "remove"}
                onClick={() => {
                  const question = `Take ${source.name} out of ${project.name}? Its ${plural(source.operations, "operation")} disappear from every variant that serves them.`;
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
  const update = useProjectUpdate();
  const [url, setUrl] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);

  const add = useMutation({
    mutationFn: () =>
      api.addSource(project.id, {
        url: url.trim(),
        ...(headers.length > 0 ? { headers: toHeaderInput(headers) } : {}),
        ...(pathPrefix.trim() !== "" ? { pathPrefix: pathPrefix.trim() } : {}),
      }),
    onSuccess: (updated) => {
      update(updated);
      toast.success(`${updated.sources.at(-1)?.name ?? "The document"} was merged in`);
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
  const ready = looksLikeUrl(url) && headersComplete(headers);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className={sheet}>
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Add document</SheetTitle>
          <SheetDescription className="text-[13px]">
            Its operations are merged into {project.name}.{" "}
            <DocsLink slug="merging">How merging works</DocsLink>
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
                  add.reset();
                }}
                placeholder="https://billing.example.com/openapi.json"
                className="text-[13px] md:text-[13px]"
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
            {error && (
              <Notice tone="bad">
                <span className="font-medium">{error.message}</span>
                {error.detail && <span className="opacity-90"> {error.detail}</span>}
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
  if (project.notes.length === 0) return null;
  const main = project.sources[0]?.name ?? "the main document";
  const shown = all ? project.notes : project.notes.slice(0, 4);
  return (
    <div>
      <p className="text-[13px] leading-5 font-medium">What merging changed</p>
      <ul className="mt-1.5 flex max-w-prose flex-col gap-1 text-[13px] leading-5 text-muted-foreground">
        {shown.map((note) => (
          <li key={JSON.stringify(note)}>{sentenceFor(note, main)}</li>
        ))}
      </ul>
      {project.notes.length > shown.length && (
        <Button variant="ghost" size="sm" className="mt-1 -ml-2.5" onClick={() => setAll(true)}>
          Show all {project.notes.length}
        </Button>
      )}
    </div>
  );
}
