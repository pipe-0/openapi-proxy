import {
  type DocumentOverrides,
  isValidSlug,
  type ProjectDefinition,
  type Selection,
  type SpecFormat,
  slugify,
  type TargetVersion,
  type VariantIconName,
  type Visibility,
} from "@openapi-proxy/core";
import { ExternalLinkIcon, MoreHorizontalIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "./components/copy-button";
import { DocsLink } from "./components/docs-link";
import { MethodChip } from "./components/method-chip";
import { OperationPath } from "./components/operation-path";
import { OperationPicker, type PickerView } from "./components/operation-picker";
import { OverridesSheet, overrideCount } from "./components/overrides-sheet";
import { Field, Notice } from "./components/page";
import { ResultPane } from "./components/result-pane";
import { Segmented } from "./components/segmented";
import { SLUG_HELP, SlugInput, type SlugStatus } from "./components/slug-input";
import { StatusChip } from "./components/status-chip";
import { VariantIconPicker } from "./components/variant-icon";
import { type InheritedVisibility, VisibilityMenu } from "./components/visibility";
import { type ProjectDoc, representation } from "./lib/document";
import {
  mainSourceName,
  type Project,
  projectSlug,
  type VariantView,
  variantEntry,
  withVariant,
} from "./lib/project";
import { bareUrl, cn, MOD_KEY } from "./lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Kbd } from "./ui/kbd";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** A new variant: nothing served yet, and what the API adds later stays hidden. */
const EMPTY: Selection = { include: {} };
const sameSelection = (a: Selection, b: Selection) => JSON.stringify(a) === JSON.stringify(b);

/** What the editor looks like while its project is on the way. */
export function EditorSkeleton() {
  return (
    <div className="flex h-full flex-col gap-4 p-5">
      <Skeleton className="h-9 w-72" />
      <Skeleton className="h-8 w-full max-w-xl" />
      <Skeleton className="min-h-0 flex-1" />
    </div>
  );
}

/** What the editor needs from wherever it is shown. */
export interface VariantEditorProps {
  project: Project;
  /** The variant that is open. Left out: a new one. */
  variant?: VariantView | undefined;
  /** For a new variant: the one it starts as a copy of. */
  template?: VariantView | undefined;
  /** The variant was made a moment ago: its URL is what to look at. */
  justCreated?: boolean;
  /** The project's documents assembled into one, once that is here. */
  document: ProjectDoc | undefined;
  /**
   * Apply the project's definition with a change made to it, and resolve when
   * the project that is shown is the one that came of it. Everything the
   * editor saves goes through here.
   */
  apply: (change: (definition: ProjectDefinition) => ProjectDefinition) => Promise<unknown>;
  /** What to say when `apply` fails. */
  describeError: (error: unknown) => string;
  onCreated: (slug: string) => void;
  onRenamed: (slug: string) => void;
  onDeleted: () => void;
  onDuplicate: (slug: string) => void;
  /** Told whenever there are, or no longer are, changes that were not saved. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Shown under the header: what the host has to say about this project. */
  banner?: React.ReactNode;
  /** Shown next to "readers send an API key", for a private variant: where a key is made. */
  privateAction?: (view: { version: TargetVersion | null; format: SpecFormat }) => React.ReactNode;
  /** What saving is called here. In the app a save is live at once; on a laptop it is a file. */
  words?: { save: string; saved: string; unsaved: string };
}

const PUBLISH = { save: "Publish changes", saved: "Published", unsaved: "Unpublished changes" };

/** One thing the editor asks of its host at a time, and whether it is under way. */
function useAction<T = void>(
  run: (input: T) => Promise<unknown>,
  after: { done?: (input: T) => void; failed: (error: unknown) => void },
) {
  const [pending, setPending] = useState(false);
  const [input, setInput] = useState<T>();
  const start = (value: T) => {
    setPending(true);
    setInput(value);
    run(value).then(
      () => {
        setPending(false);
        after.done?.(value);
      },
      (error: unknown) => {
        setPending(false);
        setInput(undefined);
        after.failed(error);
      },
    );
  };
  return { start, pending, input };
}

/**
 * Creating and editing a variant are the same screen: a name, the URL it is
 * served at, the operations on the left and the document they produce on the
 * right. Nothing is saved until you say so.
 */
export function VariantEditor({
  project,
  variant,
  template,
  justCreated = false,
  document: source,
  apply,
  describeError,
  onCreated,
  onRenamed,
  onDeleted,
  onDuplicate,
  onDirtyChange,
  banner,
  privateAction,
  words = PUBLISH,
}: VariantEditorProps) {
  const failed = (error: unknown) => toast.error(describeError(error));
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
  const stated = variant ? variant.definition.visibility : newVisibility;
  const inherited: InheritedVisibility =
    project.definition.visibility !== undefined
      ? { value: project.definition.visibility, from: "project" }
      : { value: project.state.defaultVisibility, from: "workspace" };
  /** Who may read it, as far as that is known here. */
  const visibility = stated ?? inherited.value;
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

  // A variant's slug is its own within the project, which is all on screen already.
  const slugStatus: SlugStatus = variant ? "idle" : slugStatusIn(project, slug);

  const sameOverrides = (other: DocumentOverrides | null) =>
    JSON.stringify(overrides) === JSON.stringify(other);
  const dirty = variant
    ? name.trim() !== published.name ||
      !sameSelection(selection, published.selection) ||
      !sameOverrides(published.overrides)
    : name.trim() !== "" || !sameSelection(selection, EMPTY) || overrides !== null;

  const reportDirty = useEffectEvent((value: boolean) => onDirtyChange?.(value));
  useEffect(() => {
    reportDirty(dirty);
    return () => reportDirty(false);
  }, [dirty]);

  const create = useAction(
    () =>
      apply((definition) =>
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
    { done: () => onCreated(slug), failed },
  );

  /** The variant's entry as it is stored, with something changed. Applied at once. */
  const saveEntry = (change: (entry: NonNullable<typeof variant>["definition"]) => object) =>
    apply((definition) => {
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

  const publish = useAction(
    () =>
      saveEntry(() => ({
        name: name.trim() === "" ? undefined : name.trim(),
        include: selection.include,
        exclude: selection.exclude,
        overrides: overrides ?? undefined,
      })),
    { done: () => toast.success(words.saved), failed },
  );

  // What does not change what is served, and is saved the moment it is chosen.
  const saveIcon = useAction(
    (icon: VariantIconName | null) => saveEntry(() => ({ icon: icon ?? undefined })),
    { failed },
  );

  // Who may read it is not a draft: it holds from the moment it is chosen, and
  // the screen only says so once it is saved.
  const changeVisibility = useAction(
    (next: Visibility | undefined) => saveEntry(() => ({ visibility: next })),
    {
      done: (next) => {
        const now = next ?? inherited.value;
        toast.success(
          now === "private"
            ? "Private: readers need an API key"
            : now === "public"
              ? "Public: anyone with the URL can read it"
              : "It is what the workspace says now",
        );
      },
      failed,
    },
  );
  const pickVisibility = (next: Visibility | undefined) => {
    if (!variant) return setNewVisibility(next);
    if (next === stated) return;
    // Opening it to everyone is said twice. Anything else is not.
    const opens = (next ?? inherited.value) === "public" && visibility !== "public";
    const sure =
      !opens ||
      window.confirm("Make this variant public? Anyone with its URL will be able to read it.");
    if (sure) changeVisibility.start(next);
  };

  const nothingServed =
    selection.include !== undefined &&
    !selection.include.operations?.length &&
    !selection.include.tags?.length;
  const canCreate = name.trim() !== "" && slugStatus === "available";
  const busy = create.pending || publish.pending;

  const submit = () => {
    if (busy || !canEdit) return;
    if (variant) {
      if (dirty) publish.start();
      return;
    }
    if (!canCreate) {
      if (name.trim() === "") window.document.getElementById("variant-name")?.focus();
      return;
    }
    if (nothingServed) setConfirmEmpty(true);
    else create.start();
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
    window.document.addEventListener("keydown", onKeyDown);
    return () => window.document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Selected operations the document does not have, while they are still selected.
  const missing = variant
    ? variant.state.notFound.include.operations.filter((key) =>
        selection.include?.operations?.includes(key),
      )
    : [];
  // What the document is told at the top: the variant's own, over what its project says.
  const atTheTop = { ...project.definition.overrides, ...overrides };
  const servedOverrides = Object.keys(atTheTop).length > 0 ? atTheTop : null;
  const icon = variant ? (saveIcon.input ?? variant.definition.icon ?? null) : newIcon;

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
              onChange={(next) => (variant ? saveIcon.start(next) : setNewIcon(next))}
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
          {canEdit && variant && dirty && <StatusChip tone="warn">{words.unsaved}</StatusChip>}
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
              {variant ? words.save : "Create variant"}
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
              <DropdownMenuContent align="end" className="w-56">
                {/* A variant under another URL is another variant: what is not saved would not come along. */}
                <DropdownMenuItem disabled={dirty} onClick={() => setChangingUrl(true)}>
                  <span className="flex flex-col">
                    <span>Change URL</span>
                    {dirty && (
                      <span className="text-[12.5px] leading-[18px] text-muted-foreground">
                        Save or discard your changes first
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDuplicate(variant.slug)}>
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
              stated={stated}
              inherited={inherited}
              onVisibilityChange={pickVisibility}
              busy={changeVisibility.pending || !canEdit}
              privateAction={privateAction?.({ version, format })}
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
              <VisibilityMenu stated={stated} inherited={inherited} onChange={pickVisibility} />
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

      {banner && <div className="shrink-0 border-b bg-subtle px-5 py-3">{banner}</div>}

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
          source={source}
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

      {presenting && (
        <OverridesSheet
          doc={source?.doc}
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
                create.start();
              }}
            >
              Create it empty
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
            apply={apply}
            failed={failed}
            onChanged={onRenamed}
          />
          <DeleteDialog
            open={deleting}
            onOpenChange={setDeleting}
            variant={variant}
            apply={apply}
            failed={failed}
            onDeleted={() => {
              toast.success(`Deleted ${variant.name}`);
              onDeleted();
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
  stated,
  inherited,
  onVisibilityChange,
  busy,
  privateAction,
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
  /** Where a key for this variant is made, where there are keys. */
  privateAction: React.ReactNode;
}) {
  const address = `${url}${suffix}`;
  const { origin, pathname } = new URL(url);
  const isPrivate = (stated ?? inherited.value) === "private";

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
        <VisibilityMenu
          stated={stated}
          inherited={inherited}
          onChange={onVisibilityChange}
          disabled={busy}
        />
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
          {privateAction}
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
  return Object.hasOwn(project.definition.variants, slug) ? "taken" : "available";
}

function ChangeUrlDialog({
  open,
  onOpenChange,
  project,
  variant,
  apply,
  failed,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  variant: VariantView;
  apply: VariantEditorProps["apply"];
  failed: (error: unknown) => void;
  onChanged: (slug: string) => void;
}) {
  const [slug, setSlug] = useState(variant.slug);
  const status = slugStatusIn(project, slug, variant.slug);
  const change = useAction(
    () =>
      apply((definition) =>
        withVariant(definition, slug, definition.variants[variant.slug], variant.slug),
      ),
    {
      done: () => {
        onOpenChange(false);
        toast.success("URL changed");
        onChanged(slug);
      },
      failed,
    },
  );

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
            if (status === "available" && slug !== variant.slug) change.start();
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
              loading={change.pending}
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
  apply,
  failed,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant: VariantView;
  apply: VariantEditorProps["apply"];
  failed: (error: unknown) => void;
  onDeleted: () => void;
}) {
  const remove = useAction(
    () => apply((definition) => withVariant(definition, variant.slug, undefined)),
    { done: onDeleted, failed },
  );
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
            onClick={() => remove.start()}
            loading={remove.pending}
          >
            Delete variant
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
