import { type Selection, type SpecFormat, slugify } from "@openapi-proxy/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { MethodChip } from "@/components/method-chip";
import { OperationPath } from "@/components/operation-path";
import { OperationPicker, type PickerView } from "@/components/operation-picker";
import { Field, Missing, Notice, useTitle } from "@/components/page";
import { ResultPane } from "@/components/result-pane";
import { Segmented } from "@/components/segmented";
import { SLUG_HELP, SlugInput, useSlugStatus } from "@/components/slug-input";
import { StatusChip } from "@/components/status-chip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, bareUrl, errorMessage, type Project, queries, type Variant } from "@/lib/api";
import { useProject, useProjectVariants } from "@/lib/hooks";
import { useProjectDoc } from "@/lib/use-project-doc";
import { cn, MOD_KEY, plural } from "@/lib/utils";

const EMPTY: Selection = { mode: "include", operations: [], tags: [] };
const sameSelection = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

export function VariantNewPage() {
  const { projectId } = useParams({ from: "/_client/_app/p/$projectId/new" });
  const { project, isPending } = useProject(projectId);
  useTitle("New variant");
  if (isPending) return <EditorSkeleton />;
  if (!project) return <Missing what="Project" />;
  return <Editor key={`new:${project.id}`} project={project} />;
}

export function VariantEditorPage() {
  const { projectId, variantId } = useParams({ from: "/_client/_app/p/$projectId/v/$variantId" });
  const { created } = useSearch({ from: "/_client/_app/p/$projectId/v/$variantId" });
  const { project, isPending } = useProject(projectId);
  const { variants, isPending: variantsPending } = useProjectVariants(projectId);
  const variant = variants.find((candidate) => candidate.id === variantId);
  useTitle(variant?.name);

  if (isPending || variantsPending) return <EditorSkeleton />;
  if (!project) return <Missing what="Project" />;
  if (!variant) return <Missing what="Variant" />;
  return (
    // Remount when the published state changes, so the editor starts from it.
    <Editor
      key={`${variant.id}:${variant.selectionVersion}:${variant.name}`}
      project={project}
      variant={variant}
      justCreated={created === true}
    />
  );
}

function EditorSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 p-5">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-8 w-full max-w-xl" />
      <Skeleton className="min-h-0 flex-1" />
    </div>
  );
}

/**
 * Creating and editing a variant are the same screen: a name, the URL it is
 * served at, the operations on the left and the document they produce on the
 * right. Nothing is published until you say so.
 */
function Editor({
  project,
  variant,
  justCreated = false,
}: {
  project: Project;
  variant?: Variant;
  justCreated?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const source = useProjectDoc(project);

  const [name, setName] = useState(variant?.name ?? "");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [selection, setSelection] = useState<Selection>(variant?.selection ?? EMPTY);
  const [outputVersion, setOutputVersion] = useState(variant?.outputVersion ?? null);
  const [view, setView] = useState<PickerView>("all");
  const [format, setFormat] = useState<SpecFormat>("json");
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [changingUrl, setChangingUrl] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const leaving = useRef(false);

  const checkSlug = useCallback(
    (candidate: string) => api.checkVariantSlug(project.id, candidate),
    [project.id],
  );
  const slugStatus = useSlugStatus(variant ? "" : slug, checkSlug, project.id);

  const dirty = variant
    ? name.trim() !== variant.name ||
      !sameSelection(selection, variant.selection) ||
      outputVersion !== variant.outputVersion
    : name.trim() !== "" || !sameSelection(selection, EMPTY) || outputVersion !== null;

  const replaceVariant = (updated: Variant) =>
    queryClient.setQueryData<Variant[]>(queries.variants.queryKey, (current) =>
      current?.some((existing) => existing.id === updated.id)
        ? current.map((existing) => (existing.id === updated.id ? updated : existing))
        : [...(current ?? []), updated],
    );

  const create = useMutation({
    mutationFn: () =>
      api.createVariant({
        projectId: project.id,
        name: name.trim(),
        slug,
        selection,
        ...(outputVersion ? { outputVersion } : {}),
      }),
    onSuccess: (created) => {
      replaceVariant(created);
      leaving.current = true;
      void navigate({
        to: "/p/$projectId/v/$variantId",
        params: { projectId: project.id, variantId: created.id },
        search: { created: true },
      });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const publish = useMutation({
    mutationFn: () =>
      api.updateVariant((variant as Variant).id, {
        ...(name.trim() !== variant?.name ? { name: name.trim() } : {}),
        ...(variant && !sameSelection(selection, variant.selection) ? { selection } : {}),
        ...(outputVersion !== variant?.outputVersion ? { outputVersion } : {}),
      }),
    onSuccess: (updated) => {
      replaceVariant(updated);
      toast.success("Published");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // Bookkeeping about the source that does not change what is served.
  const acknowledge = useMutation({
    mutationFn: (changes: Parameters<typeof api.updateVariant>[1]) =>
      api.updateVariant((variant as Variant).id, changes),
    onSuccess: replaceVariant,
    onError: (error) => toast.error(errorMessage(error)),
  });

  const nothingServed =
    selection.mode === "include" && selection.operations.length + selection.tags.length === 0;
  const canCreate = name.trim() !== "" && slugStatus === "available";
  const busy = create.isPending || publish.isPending;

  const submit = () => {
    if (busy) return;
    if (variant) {
      if (dirty && name.trim() !== "") publish.mutate();
      return;
    }
    if (!canCreate) {
      if (name.trim() === "") document.getElementById("variant-name")?.focus();
      return;
    }
    if (nothingServed) setConfirmEmpty(true);
    else create.mutate();
  };

  // ⌘↵ and ⌘S both mean "make it so", from anywhere on the page.
  const onShortcut = useEffectEvent(submit);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && (event.key === "Enter" || event.key.toLowerCase() === "s")) {
        event.preventDefault();
        onShortcut();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !leaving.current,
    enableBeforeUnload: () => dirty && !leaving.current,
    withResolver: true,
  });

  const newKeys = useMemo(
    () => (variant ? new Set(variant.drift.newOperations) : undefined),
    [variant],
  );
  const missing = variant
    ? variant.drift.missingSelectedOperations.filter(
        (key) => !variant.drift.acknowledged.includes(key) && selection.operations.includes(key),
      )
    : [];

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b px-5 pt-4 pb-3.5">
        <div className="flex items-center gap-2.5">
          <input
            id="variant-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!variant && !slugEdited) setSlug(slugify(event.target.value));
            }}
            placeholder="Name this variant"
            aria-label="Variant name"
            maxLength={100}
            // biome-ignore lint/a11y/noAutofocus: a new variant starts with its name
            autoFocus={!variant}
            autoComplete="off"
            className="type-title -ml-1.5 min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 outline-none placeholder:text-faint hover:bg-muted/60 focus-visible:bg-muted/60"
          />
          {variant && dirty && <StatusChip tone="warn">Unpublished changes</StatusChip>}
          {variant && dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setName(variant.name);
                setSelection(variant.selection);
                setOutputVersion(variant.outputVersion);
              }}
            >
              Discard
            </Button>
          )}
          <Button
            onClick={submit}
            loading={busy}
            disabled={variant ? !dirty || name.trim() === "" : !canCreate}
          >
            {variant ? "Publish changes" : "Create variant"}
            <Kbd className="hidden bg-primary-foreground/15 text-primary-foreground/90 sm:inline-flex">
              {MOD_KEY}↵
            </Kbd>
          </Button>
          {variant && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon" aria-label="More actions" />}
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setChangingUrl(true)}>Change URL</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                  Delete variant
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="mt-2.5">
          {variant ? (
            <UrlBar
              url={variant.url}
              format={format}
              onFormatChange={setFormat}
              celebrate={justCreated}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <SlugInput
                label="URL slug"
                prefix={`${bareUrl(project.urlPrefix)}${project.slug}/`}
                value={slug}
                onChange={(next) => {
                  setSlug(next);
                  setSlugEdited(true);
                }}
                status={slugStatus}
                allowRandom
                className="w-full max-w-xl"
              />
              <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
                {slugStatus === "taken" || slugStatus === "invalid"
                  ? SLUG_HELP[slugStatus]
                  : "Where this variant will be served, as JSON and YAML."}
              </span>
            </div>
          )}
        </div>
      </header>

      {variant && (missing.length > 0 || variant.drift.newOperations.length > 0) && (
        <div className="flex shrink-0 flex-col gap-2 border-b bg-subtle px-5 py-3">
          {missing.length > 0 && (
            // No decision to make here: a selected operation that disappears
            // stays selected, so a rollback or a fixed deploy brings it back
            // without anyone having to notice. This only says what happened.
            <Notice
              tone="warn"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={acknowledge.isPending}
                  onClick={() =>
                    acknowledge.mutate({
                      acknowledgedMissingOps: [...variant.drift.acknowledged, ...missing],
                    })
                  }
                >
                  Dismiss
                </Button>
              }
            >
              <p>
                <span className="font-medium">
                  {missing.length === 1
                    ? "A selected operation is no longer in the source"
                    : `${missing.length} selected operations are no longer in the source`}
                </span>
                , so {missing.length === 1 ? "it is" : "they are"} left out. If the source brings{" "}
                {missing.length === 1 ? "it" : "them"} back,{" "}
                {missing.length === 1 ? "it is" : "they are"} served again.
              </p>
              <ul className="mt-1.5 flex flex-col gap-1">
                {missing.map((key) => {
                  const [method = "", ...rest] = key.split(" ");
                  return (
                    <li key={key} className="flex items-center gap-2">
                      <MethodChip method={method} />
                      <OperationPath
                        path={rest.join(" ")}
                        webhook={rest[0]?.startsWith("webhook:")}
                        className="text-[13px] line-through"
                      />
                    </li>
                  );
                })}
              </ul>
            </Notice>
          )}
          {variant.drift.newOperations.length > 0 && (
            <Notice
              tone="accent"
              action={
                <>
                  <Button variant="outline" size="sm" onClick={() => setView("new")}>
                    Show them
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={acknowledge.isPending}
                    onClick={() => {
                      setView("all");
                      acknowledge.mutate({ reviewNewOps: true });
                    }}
                  >
                    Mark as reviewed
                  </Button>
                </>
              }
            >
              <span className="font-medium">
                {plural(variant.drift.newOperations.length, "new operation")} in the source
              </span>{" "}
              since this variant was last reviewed.
            </Notice>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,40%)]">
        <OperationPicker
          className="lg:border-r"
          entries={project.opIndex}
          selection={selection}
          onChange={setSelection}
          view={view}
          onViewChange={setView}
          newKeys={newKeys}
          mainSource={project.sources[0]?.name}
        />
        <ResultPane
          className="hidden lg:flex"
          source={source.data}
          sourceVersion={project.specVersion}
          selection={selection}
          version={outputVersion}
          onVersionChange={setOutputVersion}
          format={format}
          onFormatChange={setFormat}
          filename={variant?.slug ?? (slug || "openapi")}
        />
      </div>

      <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create a variant with nothing in it?</AlertDialogTitle>
            <AlertDialogDescription>
              No operations are served, so this URL will answer with a valid document that has no
              paths. You can change the selection whenever you like.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back to selecting</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmEmpty(false);
                create.mutate();
              }}
            >
              Create it empty
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Leave without {variant ? "publishing" : "creating"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {variant
                ? "Your changes to this variant have not been published. Leaving discards them."
                : "This variant has not been created yet. Leaving discards it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => blocker.proceed?.()}>
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {variant && (
        <>
          <ChangeUrlDialog
            open={changingUrl}
            onOpenChange={setChangingUrl}
            project={project}
            variant={variant}
            onChanged={replaceVariant}
          />
          <DeleteDialog
            open={deleting}
            onOpenChange={setDeleting}
            variant={variant}
            onDeleted={() => {
              leaving.current = true;
              queryClient.setQueryData<Variant[]>(queries.variants.queryKey, (current) =>
                current?.filter((existing) => existing.id !== variant.id),
              );
              toast.success(`Deleted ${variant.name}`);
              void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
            }}
          />
        </>
      )}
    </div>
  );
}

/** The variant's address: the reason the screen exists, always in view. */
function UrlBar({
  url,
  format,
  onFormatChange,
  celebrate,
}: {
  url: string;
  format: SpecFormat;
  onFormatChange: (format: SpecFormat) => void;
  celebrate: boolean;
}) {
  const withFormat = `${url}.${format}`;
  const { origin, pathname } = new URL(url);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className={cn(
          "flex h-8 max-w-xl min-w-0 flex-1 items-center rounded-lg border bg-subtle px-2.5",
          celebrate && "animate-arrive",
        )}
      >
        <code
          className="truncate font-sans text-[13px]"
          title={withFormat}
          data-testid="variant-url"
        >
          <span className="text-faint">{origin}</span>
          {pathname}
          <span className="text-faint">.{format}</span>
        </code>
      </div>
      {/* On wide screens the format switch lives with the preview it controls. */}
      <Segmented
        aria-label="Format"
        className="lg:hidden"
        value={format}
        onValueChange={onFormatChange}
        options={[
          { value: "json", label: "JSON" },
          { value: "yaml", label: "YAML" },
        ]}
      />
      <CopyButton value={withFormat} label="Copy URL" what="URL copied" autoFocus={celebrate} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              aria-label="Open in a new tab"
              nativeButton={false}
              render={<a href={withFormat} target="_blank" rel="noreferrer" />}
            />
          }
        >
          <ExternalLinkIcon />
        </TooltipTrigger>
        <TooltipContent>Open in a new tab</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ChangeUrlDialog({
  open,
  onOpenChange,
  project,
  variant,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  variant: Variant;
  onChanged: (variant: Variant) => void;
}) {
  const [slug, setSlug] = useState(variant.slug);
  const checkSlug = useCallback(
    (candidate: string) => api.checkVariantSlug(project.id, candidate),
    [project.id],
  );
  const status = useSlugStatus(slug, checkSlug, project.id, variant.slug);
  const change = useMutation({
    mutationFn: () => api.updateVariant(variant.id, { slug }),
    onSuccess: (updated) => {
      onChanged(updated);
      onOpenChange(false);
      toast.success("URL changed");
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setSlug(variant.slug);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            if (status === "available" && slug !== variant.slug) change.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Change the URL</DialogTitle>
            <DialogDescription>
              Anything still requesting the old URL will get a 404. Update your consumers first, or
              right after.
            </DialogDescription>
          </DialogHeader>
          <Field error={status === "taken" || status === "invalid" ? SLUG_HELP[status] : undefined}>
            <SlugInput
              label="URL slug"
              prefix={`${bareUrl(project.urlPrefix)}${project.slug}/`}
              value={slug}
              onChange={setSlug}
              status={status}
              allowRandom
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              type="submit"
              disabled={status !== "available" || slug === variant.slug}
              loading={change.isPending}
            >
              Change URL
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  open,
  onOpenChange,
  variant,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: Variant;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => api.deleteVariant(variant.id),
    onSuccess: onDeleted,
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {variant.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{bareUrl(variant.url)}</span> stops
            working at once. Anything still requesting it will get a 404. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => remove.mutate()}
            loading={remove.isPending}
          >
            Delete variant
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
