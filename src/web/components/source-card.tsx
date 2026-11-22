import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import {
  type HeaderDraft,
  HeaderEditor,
  headersComplete,
  newHeader,
  toHeaderInput,
} from "@/components/header-editor";
import { Field, Notice } from "@/components/page";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  api,
  errorMessage,
  type Project,
  type ProjectNote,
  queries,
  RequestError,
  type Source,
} from "@/lib/api";
import { cn, formatBytes, looksLikeUrl, plural } from "@/lib/utils";

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

/** A link into the docs, opened beside the form so nothing typed here is lost. */
export function DocsLink({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <a
      href={`/docs/${slug}`}
      target="_blank"
      rel="noreferrer"
      className="font-medium whitespace-nowrap text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
    >
      {children}
    </a>
  );
}

const example = "font-sans font-medium whitespace-nowrap text-foreground";

/**
 * One of the documents a project is assembled from: where it is, how it is
 * doing, and (opened) how it is fetched and merged in. Each document is saved
 * on its own.
 */
export function SourceCard({
  project,
  source,
  intervalLabel,
}: {
  project: Project;
  source: Source;
  /** How often a check can happen, in words: "at most once every 5 minutes". */
  intervalLabel: string;
}) {
  const several = project.sources.length > 1;
  const main = project.sources[0]?.id === source.id;
  const update = useProjectUpdate();
  // With one document its settings are the page; with several, each opens on demand.
  const [open, setOpen] = useState(!several);

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
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const saveError = save.error instanceof RequestError ? save.error : undefined;
  const id = (field: string) => `${source.id}-${field}`;

  return (
    <div className="border-b pb-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            <span>{source.name}</span>
            {several && main && (
              <span className="text-[13px] font-normal text-muted-foreground">Main document</span>
            )}
            {source.pathPrefix && (
              <span className="text-[13px] font-normal text-muted-foreground">
                under {source.pathPrefix}
              </span>
            )}
            {source.lastStatus === "error" && <StatusChip tone="bad">Check failed</StatusChip>}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[13px] text-muted-foreground">
            <span className="truncate">{source.url}</span>
            <CopyButton value={source.url} what="URL copied" variant="ghost" size="icon-xs" />
          </p>
          <p className="text-[13px] text-muted-foreground">
            {plural(source.operations, "operation")}, {formatBytes(source.bodyBytes)}, OpenAPI{" "}
            {source.specVersion}
          </p>
        </div>
        {several && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            onClick={() => setOpen((current) => !current)}
          >
            Settings
            <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
          </Button>
        )}
      </div>

      {source.lastStatus === "error" && source.lastError && (
        <Notice tone="bad" className="mt-3">
          <span className="font-medium">The last check failed.</span> {source.lastError} Its last
          good copy is still served.
        </Notice>
      )}

      {open && (
        <div className="mt-5 flex flex-col gap-6">
          {several && (
            <div className="grid gap-6 sm:grid-cols-2">
              <Field
                label="Name"
                htmlFor={id("name")}
                hint="Shown next to its operations. If one of its schemas has to be renamed in the merge, it is named after this."
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
                hint="Optional. Put in front of every path of this document, for a service that is mounted under the main API."
              >
                <Input
                  id={id("prefix")}
                  value={pathPrefix}
                  onChange={(event) => setPathPrefix(event.target.value)}
                  placeholder="/billing"
                  spellCheck={false}
                />
              </Field>
            </div>
          )}

          <Field label="Checks">
            <p className="max-w-xl text-[13px] leading-5 text-muted-foreground">
              {source.versionUrl && !source.versionMismatchAt ? (
                <>
                  <span className="font-medium text-foreground">Cheap.</span> A check asks the
                  version endpoint and downloads the document only when the version has moved.
                </>
              ) : source.validator ? (
                <>
                  <span className="font-medium text-foreground">Cheap.</span> Your API sends{" "}
                  {source.validator === "etag" ? "an ETag" : "a Last-Modified date"}, so a check
                  that finds nothing new is a quick 304 without a body.
                </>
              ) : (
                <>
                  <span className="font-medium text-foreground">
                    Each check downloads the whole document ({formatBytes(source.bodyBytes)}).
                  </span>{" "}
                  The request that starts a check waits for that download, which happens{" "}
                  {intervalLabel}. Nobody gets an error or an outdated document. An ETag turns these
                  checks into a quick 304. <DocsLink slug="etag">How to send one</DocsLink>
                </>
              )}
            </p>
          </Field>

          <Field
            label="Version endpoint"
            htmlFor={id("version")}
            hint={
              <>
                Optional. A URL that answers with the build that is live, as a header such as{" "}
                <code className={example}>X-API-Version: 4f2a9c1</code> or a body such as{" "}
                <code className={example}>{'{"version": "4f2a9c1"}'}</code>. It has to change with
                every deploy. <DocsLink slug="version-endpoint">What it can return</DocsLink>
                {source.versionUrl && !source.versionMismatchAt && source.lastKnownVersion && (
                  <>
                    {" "}
                    Currently reporting <code className={example}>{source.lastKnownVersion}</code>.
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
                  This endpoint reported the same version for two different documents, so it is no
                  longer used: every check looks at the document itself. Once it changes with every
                  deploy, use it again.
                </Notice>
              )}
            </div>
          </Field>

          <Field
            label="Credentials"
            hint="Request headers sent when fetching this document, if it is not public. Stored encrypted, never shown again, and only ever sent to the document's own origin."
          >
            <HeaderEditor value={headers} onChange={setHeaders} />
          </Field>

          {(saveError || save.isError) && (
            <Notice tone="bad">
              <span className="font-medium">{saveError?.message ?? errorMessage(save.error)}</span>
              {saveError?.detail && <span> {saveError.detail}</span>}
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={!dirty || !valid}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              Save {several ? "this document" : "document settings"}
            </Button>
            {dirty && (
              <Button
                variant="ghost"
                onClick={() => {
                  setName(source.name);
                  setPathPrefix(source.pathPrefix ?? "");
                  setVersionUrl(source.versionUrl ?? "");
                  setHeaders(source.headerNames.map((headerName) => newHeader(headerName, true)));
                  save.reset();
                }}
              >
                Discard
              </Button>
            )}
            <span className="flex-1" />
            {several && !main && (
              <Button
                variant="ghost"
                loading={act.isPending && act.variables === "main"}
                onClick={() => act.mutate("main")}
              >
                Make it the main document
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
          </div>
        </div>
      )}
    </div>
  );
}

/** Add one more document to a project. Its operations are merged into the project's. */
export function AddSource({ project }: { project: Project }) {
  const update = useProjectUpdate();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);

  const reset = () => {
    setOpen(false);
    setUrl("");
    setPathPrefix("");
    setHeaders([]);
  };
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
      reset();
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

  if (!open) {
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          Add a document
        </Button>
        <p className="mt-2 max-w-prose text-[12.5px] leading-[18px] text-muted-foreground">
          Merge another OpenAPI document into this project, for a service that belongs to the same
          API. <DocsLink slug="merging">How merging works</DocsLink>
        </p>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !add.isPending) add.mutate();
      }}
    >
      <Field label="Another document" htmlFor="add-source-url">
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
        hint="Optional. Put in front of every path of this document, for a service that is mounted under the main API."
      >
        <Input
          id="add-source-prefix"
          value={pathPrefix}
          onChange={(event) => setPathPrefix(event.target.value)}
          placeholder="/billing"
          className="max-w-xs"
          spellCheck={false}
        />
      </Field>
      {headers.length > 0 && (
        <Field label="Credentials" hint="Request headers sent when fetching it. Stored encrypted.">
          <HeaderEditor value={headers} onChange={setHeaders} autoFocus={Boolean(error)} />
        </Field>
      )}
      {error && (
        <Notice tone="bad">
          <span className="font-medium">{error.message}</span>
          {error.detail && <span className="opacity-90"> {error.detail}</span>}
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="outline" disabled={!ready} loading={add.isPending}>
          {add.isPending ? "Fetching" : "Merge it in"}
        </Button>
        <Button variant="ghost" onClick={reset}>
          Cancel
        </Button>
        {headers.length === 0 && (
          <Button variant="ghost" onClick={() => setHeaders([newHeader("Authorization")])}>
            <KeyRoundIcon /> It needs credentials
          </Button>
        )}
      </div>
    </form>
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
export function MergeNotes({ project }: { project: Project }) {
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
