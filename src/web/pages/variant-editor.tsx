import {
  type DocumentOverrides,
  isValidSlug,
  type Selection,
  type SpecFormat,
  slugify,
  type TargetVersion,
} from "@openapi-proxy/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { NewKeyDialog } from "@/components/api-keys";
import { CopyButton } from "@/components/copy-button";
import { DocsLink } from "@/components/docs-link";
import { ManagedByFile } from "@/components/managed-by-file";
import { MethodChip } from "@/components/method-chip";
import { OperationPath } from "@/components/operation-path";
import { OperationPicker, type PickerView } from "@/components/operation-picker";
import { OverridesSheet, overrideCount } from "@/components/overrides-sheet";
import { Field, Missing, Notice, useTitle } from "@/components/page";
import { ResultPane } from "@/components/result-pane";
import { Segmented } from "@/components/segmented";
import { SLUG_HELP, SlugInput, type SlugStatus } from "@/components/slug-input";
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
import { VariantIconPicker } from "@/components/variant-icon";
import { VisibilityMenu } from "@/components/visibility";
import {
  bareUrl,
  errorMessage,
  type Project,
  representation,
  type VariantIconName,
  type Visibility,
} from "@/lib/api";
import { type CreatedKey, keysApi, keysQuery } from "@/lib/api-keys";
import { useProject } from "@/lib/hooks";
import {
  mainSourceName,
  projectSlug,
  useApply,
  type VariantView,
  variantEntry,
  variantsOf,
  withVariant,
} from "@/lib/project";
import { useProjectDoc } from "@/lib/use-project-doc";
import { cn, MOD_KEY } from "@/lib/utils";

/** A new variant: nothing served yet, and what the API adds later stays hidden. */
const EMPTY: Selection = { include: {} };
const sameSelection = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

export function VariantNewPage() {
  const { project: slug } = useParams({ from: "/_client/_app/p/$project/new" });
  const { from } = useSearch({ from: "/_client/_app/p/$project/new" });
  const { project, isPending } = useProject(slug);
  useTitle("New variant");
  if (isPending) return <EditorSkeleton />;
  if (!project) return <Missing what="Project" />;
  // A copy starts from another variant: the same operations for another audience or environment.
  const template = variantsOf(project).find((candidate) => candidate.slug === from);
  return <Editor key={`new:${slug}:${from ?? ""}`} project={project} template={template} />;
}

export function VariantEditorPage() {
  const params = useParams({ from: "/_client/_app/p/$project/v/$variant" });
  const { created } = useSearch({ from: "/_client/_app/p/$project/v/$variant" });
  const { project, isPending } = useProject(params.project);
  const variant = project
    ? variantsOf(project).find((candidate) => candidate.slug === params.variant)
    : undefined;
  useTitle(variant?.name);

  if (isPending) return <EditorSkeleton />;
  if (!project) return <Missing what="Project" />;
  if (!variant) return <Missing what="Variant" />;
  const { name, overrides } = variant.definition;
  return (
    // Remount when what is published changes, so the editor starts from it.
    <Editor
      key={JSON.stringify([variant.state.id, name, variant.selection, overrides])}
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
  template,
  justCreated = false,
}: {
  project: Project;
  variant?: VariantView;
  /** For a new variant: the one it starts as a copy of. */
  template?: VariantView | undefined;
  justCreated?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const source = useProjectDoc(project);
  const apply = useApply(project);
  const projectParam = projectSlug(project);
  /** A project that is deployed from a file is read here, not changed. */
  const canEdit = project.state.can.edit;

  const start = variant ?? template;
  const published = {
    name: variant?.definition.name ?? "",
    selection: variant?.selection ?? EMPTY,
    overrides: variant?.definition.overrides ?? null,
  };
  const [name, setName] = useState(published.name);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [selection, setSelection] = useState<Selection>(start?.selection ?? EMPTY);
  // Which representation is on screen. Not part of the variant: every variant
  // is served in every version, and the URL above follows what is picked here.
  const [version, setVersion] = useState<TargetVersion | null>(null);
  // Only for a variant that does not exist yet. Nothing picked, it is whatever
  // its project says, and then the workspace.
  const [newVisibility, setNewVisibility] = useState<Visibility | undefined>(
    template?.definition.visibility,
  );
  const visibility: Visibility =
    variant?.state.visibility.value ??
    newVisibility ??
    project.definition.visibility ??
    project.state.defaultVisibility;
  const [newKey, setNewKey] = useState<CreatedKey>();
  const [overrides, setOverrides] = useState<DocumentOverrides | null>(
    start?.definition.overrides ?? null,
  );
  // Only for a variant that does not exist yet: an existing one's icon is saved the moment it is picked.
  const [newIcon, setNewIcon] = useState<VariantIconName | null>(start?.definition.icon ?? null);
  const [presenting, setPresenting] = useState(false);
  const [view, setView] = useState<PickerView>("all");
  const [format, setFormat] = useState<SpecFormat>("json");
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [changingUrl, setChangingUrl] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const leaving = useRef(false);

  // A variant's slug is its own within the project, which is all on screen already.
  const slugStatus: SlugStatus = variant ? "idle" : slugStatusIn(project, slug);

  const sameOverrides = (other: DocumentOverrides | null) =>
    JSON.stringify(overrides) === JSON.stringify(other);
  const dirty = variant
    ? name.trim() !== published.name ||
      !sameSelection(selection, published.selection) ||
      !sameOverrides(published.overrides)
    : name.trim() !== "" || !sameSelection(selection, EMPTY) || overrides !== null;

  const create = useMutation({
    mutationFn: () =>
      apply.mutateAsync((definition) =>
        withVariant(
          definition,
          slug,
          variantEntry({
            name: name.trim(),
            ...(newIcon ? { icon: newIcon } : {}),
            // Said only when it was picked. Otherwise the variant follows its project.
            ...(newVisibility ? { visibility: newVisibility } : {}),
            selection,
            ...(overrides ? { overrides } : {}),
          }),
        ),
      ),
    onSuccess: () => {
      leaving.current = true;
      void navigate({
        to: "/p/$project/v/$variant",
        params: { project: projectParam, variant: slug },
        search: { created: true },
      });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  /** The variant's entry as it is stored, with something changed. Applied at once. */
  const saveEntry = (change: (entry: NonNullable<typeof variant>["definition"]) => object) =>
    apply.mutateAsync((definition) => {
      const current = definition.variants[(variant as VariantView).slug] ?? {};
      const { include, exclude, ...rest } = { ...current, ...change(current) };
      return withVariant(
        definition,
        (variant as VariantView).slug,
        variantEntry({
          ...rest,
          selection: { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) },
        }),
      );
    });

  const publish = useMutation({
    mutationFn: () =>
      saveEntry(() => ({
        name: name.trim() === "" ? undefined : name.trim(),
        include: selection.include,
        exclude: selection.exclude,
        overrides: overrides ?? undefined,
      })),
    onSuccess: () => toast.success("Published"),
    onError: (error) => toast.error(errorMessage(error)),
  });

  // What does not change what is served, and is saved the moment it is chosen.
  const saveIcon = useMutation({
    mutationFn: (icon: VariantIconName | null) => saveEntry(() => ({ icon: icon ?? undefined })),
    onError: (error) => toast.error(errorMessage(error)),
  });

  // Who may read it is not a draft: it holds from the moment it is chosen, and
  // the screen only says so once the server does.
  const changeVisibility = useMutation({
    mutationFn: (next: Visibility) => saveEntry(() => ({ visibility: next })),
    onSuccess: (_, next) => {
      toast.success(
        next === "private"
          ? "Private: readers need an API key"
          : "Public: anyone with the URL can read it",
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pickVisibility = (next: Visibility) => {
    if (!variant) return setNewVisibility(next);
    if (next === variant.state.visibility.value) return;
    const sure =
      next === "private" ||
      window.confirm("Make this variant public? Anyone with its URL will be able to read it.");
    if (sure) changeVisibility.mutate(next);
  };
  // A key for the readers of this variant, and of no other.
  const createReaderKey = useMutation({
    mutationFn: () =>
      keysApi.create({
        name: `Reads ${(variant as VariantView).name}`.slice(0, 60),
        access: "read",
        variant: { project: projectParam, variant: (variant as VariantView).slug },
      }),
    onSuccess: (created) => {
      setNewKey(created);
      void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const nothingServed =
    selection.include !== undefined &&
    !selection.include.operations?.length &&
    !selection.include.tags?.length;
  const canCreate = name.trim() !== "" && slugStatus === "available";
  const busy = create.isPending || publish.isPending;

  const submit = () => {
    if (busy || !canEdit) return;
    if (variant) {
      if (dirty) publish.mutate();
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

  // Selected operations the document does not have, while they are still selected.
  const missing = variant
    ? variant.state.notFound.include.operations.filter((key) =>
        selection.include?.operations?.includes(key),
      )
    : [];
  // What the document is told at the top: the variant's own, over what its project says.
  const stated = { ...project.definition.overrides, ...overrides };
  const servedOverrides = Object.keys(stated).length > 0 ? stated : null;
  const icon = variant ? (saveIcon.variables ?? variant.definition.icon ?? null) : newIcon;

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b px-5 pt-4 pb-3.5">
        {/* On a phone the name has a line to itself, and the buttons the next one. */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex min-w-0 flex-1 basis-full items-center gap-2.5 sm:basis-0">
            {/* How it looks in the navigation. Nothing that is served depends on it, so it is saved at once. */}
            <VariantIconPicker
              value={icon}
              disabled={!canEdit}
              onChange={(next) => (variant ? saveIcon.mutate(next) : setNewIcon(next))}
            />
            <input
              id="variant-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!variant && !slugEdited) setSlug(slugify(event.target.value));
              }}
              placeholder={variant ? variant.slug : "Name this variant"}
              aria-label="Variant name"
              maxLength={100}
              readOnly={!canEdit}
              // biome-ignore lint/a11y/noAutofocus: a new variant starts with its name
              autoFocus={!variant}
              autoComplete="off"
              className="type-title -ml-1.5 min-w-0 flex-1 truncate rounded-md bg-transparent px-1.5 outline-none placeholder:text-faint hover:bg-muted/60 focus-visible:bg-muted/60"
            />
          </div>
          {!canEdit && <StatusChip tone="neutral">Deployed from a file</StatusChip>}
          {canEdit && variant && dirty && <StatusChip tone="warn">Unpublished changes</StatusChip>}
          {canEdit && variant && dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setName(published.name);
                setSelection(published.selection);
                setOverrides(published.overrides);
              }}
            >
              Discard
            </Button>
          )}
          {canEdit && (
            <Button onClick={submit} loading={busy} disabled={variant ? !dirty : !canCreate}>
              {variant ? "Publish changes" : "Create variant"}
              <Kbd className="hidden bg-primary-foreground/15 text-primary-foreground/90 sm:inline-flex">
                {MOD_KEY}↵
              </Kbd>
            </Button>
          )}
          <Button variant="outline" onClick={() => setPresenting(true)}>
            Title and servers
            {overrideCount(overrides) > 0 && (
              <span className="rounded-full bg-primary/12 px-1.5 text-[11.5px] leading-[18px] font-medium text-primary tabular-nums">
                {overrideCount(overrides)}
              </span>
            )}
          </Button>
          {variant && canEdit && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="icon" aria-label="More actions" />}
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setChangingUrl(true)}>Change URL</DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    void navigate({
                      to: "/p/$project/new",
                      params: { project: projectParam },
                      search: { from: variant.slug },
                    })
                  }
                >
                  Duplicate
                </DropdownMenuItem>
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
              url={variant.state.url}
              suffix={representation(version, format)}
              format={format}
              onFormatChange={setFormat}
              celebrate={justCreated}
              visibility={visibility}
              onVisibilityChange={pickVisibility}
              busy={changeVisibility.isPending || !canEdit}
              onCreateKey={project.state.can.keys ? () => createReaderKey.mutate() : undefined}
              creatingKey={createReaderKey.isPending}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <SlugInput
                label="URL slug"
                prefix={`${bareUrl(project.state.urlPrefix)}${projectParam}/`}
                value={slug}
                onChange={(next) => {
                  setSlug(next);
                  setSlugEdited(true);
                }}
                status={slugStatus}
                allowRandom
                className="w-full max-w-xl"
              />
              <VisibilityMenu value={visibility} onChange={pickVisibility} />
              <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
                {slugStatus === "taken" || slugStatus === "invalid"
                  ? SLUG_HELP[slugStatus]
                  : visibility === "private"
                    ? "Where this variant will be served. Readers will need an API key."
                    : "Where this variant will be served, as JSON and YAML."}
              </span>
            </div>
          )}
        </div>
      </header>

      {!canEdit && (
        <div className="shrink-0 border-b bg-subtle px-5 py-3">
          <ManagedByFile project={project} />
        </div>
      )}

      {missing.length > 0 && (
        <div className="flex shrink-0 flex-col gap-2 border-b bg-subtle px-5 py-3">
          {/*
            No decision to make here: a selected operation the document does
            not have stays selected, so the deploy that adds it, or a rollback
            that brings it back, needs nobody to notice. This only says so.
          */}
          <Notice tone="warn">
            <p>
              <span className="font-medium">
                {missing.length === 1
                  ? "A selected operation is not in the document"
                  : `${missing.length} selected operations are not in the document`}
              </span>
              , so {missing.length === 1 ? "it is" : "they are"} left out. Once the document has{" "}
              {missing.length === 1 ? "it" : "them"}, {missing.length === 1 ? "it is" : "they are"}{" "}
              served.
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
                      className="text-[13px]"
                    />
                  </li>
                );
              })}
            </ul>
          </Notice>
        </div>
      )}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(340px,40%)]">
        <OperationPicker
          className="lg:border-r"
          entries={project.state.operations}
          selection={selection}
          onChange={setSelection}
          readOnly={!canEdit}
          view={view}
          onViewChange={setView}
          mainSource={mainSourceName(project)}
        />
        <ResultPane
          className="hidden lg:flex"
          source={source.data}
          sourceVersion={project.state.specVersion}
          selection={selection}
          version={version}
          overrides={servedOverrides}
          onVersionChange={setVersion}
          path={variant ? new URL(variant.state.url).pathname : undefined}
          format={format}
          onFormatChange={setFormat}
          filename={variant?.slug ?? (slug || "openapi")}
        />
      </div>

      {variant && (
        <NewKeyDialog
          created={newKey}
          usage={{
            label: "To read the variant:",
            command: (key) =>
              `curl -H "Authorization: Bearer ${key}" ${variant.state.url}${representation(version, format)}`,
          }}
          onClose={() => setNewKey(undefined)}
        />
      )}

      {presenting && (
        <OverridesSheet
          doc={source.data?.doc}
          mainSource={mainSourceName(project) ?? "the document"}
          value={overrides}
          onChange={canEdit ? setOverrides : () => {}}
          onClose={() => setPresenting(false)}
        />
      )}

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
            onChanged={(next) => {
              leaving.current = true;
              void navigate({
                to: "/p/$project/v/$variant",
                params: { project: projectParam, variant: next },
                replace: true,
              });
            }}
          />
          <DeleteDialog
            open={deleting}
            onOpenChange={setDeleting}
            project={project}
            variant={variant}
            onDeleted={() => {
              leaving.current = true;
              toast.success(`Deleted ${variant.name}`);
              void navigate({ to: "/p/$project", params: { project: projectParam } });
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
  suffix,
  format,
  onFormatChange,
  celebrate,
  visibility,
  onVisibilityChange,
  busy,
  onCreateKey,
  creatingKey,
}: {
  url: string;
  /** What follows the URL for the representation on screen: `.json`, or `/3.0.json`. */
  suffix: string;
  format: SpecFormat;
  onFormatChange: (format: SpecFormat) => void;
  celebrate: boolean;
  visibility: Visibility;
  onVisibilityChange: (next: Visibility) => void;
  busy: boolean;
  /** Left out where there are no keys to make. */
  onCreateKey: (() => void) | undefined;
  creatingKey: boolean;
}) {
  const address = `${url}${suffix}`;
  const { origin, pathname } = new URL(url);
  const isPrivate = visibility === "private";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={cn(
            "flex h-8 max-w-xl min-w-0 flex-1 items-center rounded-lg border bg-subtle px-2.5",
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
          className="lg:hidden"
          value={format}
          onValueChange={onFormatChange}
          options={[
            { value: "json", label: "JSON" },
            { value: "yaml", label: "YAML" },
          ]}
        />
        <CopyButton value={address} label="Copy URL" what="URL copied" autoFocus={celebrate} />
        <VisibilityMenu value={visibility} onChange={onVisibilityChange} disabled={busy} />
        {/* A browser sends no key, so there is nothing to open a private one with. */}
        {!isPrivate && (
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
          <span>
            Readers send an API key as{" "}
            <span className="font-medium text-foreground">Authorization: Bearer</span>.
          </span>
          {onCreateKey && (
            <Button variant="outline" size="sm" onClick={onCreateKey} loading={creatingKey}>
              Create a key for this variant
            </Button>
          )}
          <DocsLink slug="serving">How private variants work</DocsLink>
        </p>
      )}
    </div>
  );
}

/** Whether a slug can be a new variant's in this project. Everything it takes to know is on screen. */
function slugStatusIn(project: Project, slug: string, current?: string): SlugStatus {
  if (slug === "") return "idle";
  if (!isValidSlug(slug)) return "invalid";
  if (slug === current) return "available";
  return slug in project.definition.variants ? "taken" : "available";
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
  variant: VariantView;
  onChanged: (slug: string) => void;
}) {
  const [slug, setSlug] = useState(variant.slug);
  const status = slugStatusIn(project, slug, variant.slug);
  const apply = useApply(project);
  const change = useMutation({
    mutationFn: () =>
      apply.mutateAsync((definition) =>
        withVariant(definition, slug, definition.variants[variant.slug], variant.slug),
      ),
    onSuccess: () => {
      onOpenChange(false);
      toast.success("URL changed");
      onChanged(slug);
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
              Anything still requesting the old URL will get a 404, and an API key made for this
              variant alone stops working. Update your consumers first, or right after.
            </DialogDescription>
          </DialogHeader>
          <Field error={status === "taken" || status === "invalid" ? SLUG_HELP[status] : undefined}>
            <SlugInput
              label="URL slug"
              prefix={`${bareUrl(project.state.urlPrefix)}${projectSlug(project)}/`}
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
  project,
  variant,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  variant: VariantView;
  onDeleted: () => void;
}) {
  const apply = useApply(project);
  const remove = useMutation({
    mutationFn: () =>
      apply.mutateAsync((definition) => withVariant(definition, variant.slug, undefined)),
    onSuccess: onDeleted,
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {variant.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{bareUrl(variant.state.url)}</span> stops
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
