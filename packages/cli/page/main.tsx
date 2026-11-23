import type { ProjectDefinition, ProjectView } from "@openapi-proxy/core";
import { FilePenLineIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { StrictMode, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { DocsLink, DocsSite } from "../../editor/src/components/docs-link";
import { Notice } from "../../editor/src/components/page";
import { VariantIcon } from "../../editor/src/components/variant-icon";
import { type ProjectDoc, readProjectDoc } from "../../editor/src/lib/document";
import { projectName, variantsOf } from "../../editor/src/lib/project";
import { cn, plural } from "../../editor/src/lib/utils";
import { Button } from "../../editor/src/ui/button";
import { EditorSkeleton, VariantEditor } from "../../editor/src/variant-editor";
import "./page.css";

/** Where the docs are: this page is served from a laptop, the docs are not. */
const DOCS = "https://openapi-proxy.app";

/** Why the server did not do what was asked, in words to show. */
class Refused extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Refused(
      "The local server is not answering. Is openapi-proxy dev still running?",
      "unreachable",
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new Refused(
      body.error ?? `The request failed (${response.status}).`,
      body.code ?? "unknown",
    );
  }
  return (path.endsWith("/document") ? response.text() : response.json()) as Promise<T>;
}

/** Which variant is open, kept in the address so that a reload stays where it was. */
type Place =
  | { at: "home" }
  | { at: "new"; from?: string }
  | { at: "variant"; slug: string; created: boolean };

function placeOf(hash: string): Place {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(query);
  if (path === "new") {
    const from = params.get("from");
    return from ? { at: "new", from } : { at: "new" };
  }
  if (path.startsWith("v/")) {
    return {
      at: "variant",
      slug: decodeURIComponent(path.slice(2)),
      created: params.has("created"),
    };
  }
  return { at: "home" };
}

/** An address the page itself is on its way to: it has asked, or nothing is lost by going. */
let expected: string | undefined;
const go = (hash: string) => {
  expected = hash;
  window.location.hash = hash;
};

/**
 * Where the page is, from its address. Going somewhere else by the browser's
 * own means (Back, a typed address) asks first while something is not saved,
 * and stays if the answer is no.
 *
 * `replace` puts another address in place of the current one, for a move that
 * is not a step of its own: Back then skips what was replaced.
 */
function usePlace(mayLeave: () => boolean): { place: Place; replace: (hash: string) => void } {
  const [hash, setHash] = useState(window.location.hash);
  const settled = useRef(window.location.hash);
  const ask = useEffectEvent(mayLeave);
  useEffect(() => {
    const onChange = () => {
      const next = window.location.hash;
      if (next === settled.current) return;
      if (next !== expected && !ask()) {
        // Put the address back. That is one more change of it, which finds nothing to do.
        window.location.hash = settled.current;
        return;
      }
      expected = undefined;
      settled.current = next;
      setHash(next);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const replace = useCallback((next: string) => {
    window.history.replaceState(null, "", next);
    settled.current = next;
    setHash(next);
  }, []);
  return { place: placeOf(hash), replace };
}

const navItem =
  "group/nav flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-foreground/75 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
const navItemActive =
  "is-active material-solid font-medium text-primary-foreground hover:text-primary-foreground";

/**
 * The editor for a definition file, served by `openapi-proxy dev`. It is the
 * screen the app has for a variant, with a file where the app has a service:
 * what is saved here is written into the file, and the variants it serves
 * are the ones on this machine.
 */
function App() {
  const [project, setProject] = useState<ProjectView>();
  const [document, setDocument] = useState<{ hash: string; doc: ProjectDoc }>();
  const [problem, setProblem] = useState<string>();
  const [loading, setLoading] = useState(false);
  /** The file changed on disk while something here was not saved: what is on screen is kept. */
  const [fileChanged, setFileChanged] = useState(false);
  const dirty = useRef(false);
  /** Whether going somewhere else is fine: nothing is unsaved, or the person says to drop it. */
  const mayLeave = () =>
    !dirty.current || window.confirm("Leave without saving? What you changed is discarded.");
  const { place, replace } = usePlace(mayLeave);
  /** Counted up to start the editor again from what the file says, when someone asks for that. */
  const [generation, setGeneration] = useState(0);
  const shown = useRef<string | undefined>(undefined);
  /** Which reading of the file is the newest: an older one that answers late is not shown. */
  const reading = useRef(0);
  /** The file as it was read last, for a save that starts after another has finished. */
  const latest = useRef<ProjectView | undefined>(undefined);
  const underWay = useRef<Promise<unknown>>(Promise.resolve());

  const load = useCallback(
    async (options: { keepDraft?: boolean } = {}): Promise<ProjectView | undefined> => {
      setLoading(true);
      reading.current += 1;
      const turn = reading.current;
      try {
        const [view] = await ask<ProjectView[]>("/api/projects");
        if (!view) throw new Refused("The server has no project.", "not-found");
        if (turn !== reading.current) return latest.current;
        // Unsaved work is not swapped for what the file says now. It is said, and the person decides.
        if (
          options.keepDraft &&
          dirty.current &&
          latest.current &&
          latest.current.state.revision !== view.state.revision
        ) {
          setFileChanged(true);
          setProblem(undefined);
          return latest.current;
        }
        setFileChanged(false);
        // The documents are read again only when they are different ones.
        if (shown.current !== view.state.documentHash) {
          const text = await ask<string>(`/api/projects/${view.definition.project}/document`);
          if (turn !== reading.current) return latest.current;
          shown.current = view.state.documentHash;
          setDocument({ hash: view.state.documentHash, doc: readProjectDoc(text) });
        }
        latest.current = view;
        setProject(view);
        setProblem(undefined);
        return view;
      } catch (error) {
        if (turn === reading.current) {
          setProblem(error instanceof Error ? error.message : "Something went wrong.");
        }
        return undefined;
      } finally {
        if (turn === reading.current) setLoading(false);
      }
    },
    [],
  );

  // The file belongs to whoever edits it, here or in their editor: coming
  // back to this page shows what it says now, unless that would take unsaved
  // work off the screen.
  useEffect(() => {
    void load();
    const onFocus = () => void load({ keepDraft: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  // One save at a time, each made from the file as it is when its turn comes:
  // two quick changes are two saves, and never one that undoes the other.
  const apply = (change: (definition: ProjectDefinition) => ProjectDefinition) => {
    const save = async () => {
      const current = latest.current;
      if (!current) throw new Refused("The file has not been read yet.", "not-ready");
      try {
        await ask(`/api/projects/${current.definition.project}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            definition: change(current.definition),
            ifRevision: current.state.revision,
          }),
        });
      } catch (error) {
        // The file was changed somewhere else in the meantime. What is typed here stays.
        if (error instanceof Refused && error.code === "conflict") setFileChanged(true);
        throw error;
      }
      // The editor says whether something is still unsaved: an icon that was
      // saved leaves a selection that was not.
      await load();
    };
    const turn = underWay.current.catch(() => undefined).then(save);
    underWay.current = turn;
    return turn;
  };

  const variants = project ? variantsOf(project) : [];
  const open =
    place.at === "variant" ? variants.find((each) => each.slug === place.slug) : undefined;
  const title = project ? projectName(project) : "openapi-proxy";
  useEffect(() => {
    window.document.title = open ? `${open.name} · ${title}` : title;
  }, [open, title]);

  // With nowhere in particular to be: the first variant, or making one.
  // It takes the place of the bare address, so that Back leaves the page.
  useEffect(() => {
    if (!project || place.at !== "home") return;
    const [first] = variants;
    replace(first ? `#/v/${encodeURIComponent(first.slug)}` : "#/new");
  });

  /** Follow a link of the navigation, unless that would throw away what was not saved. */
  const leave = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // Into another tab or window: nothing here is left.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.currentTarget.hash === window.location.hash) return event.preventDefault();
    if (mayLeave()) expected = event.currentTarget.hash;
    else event.preventDefault();
  };

  // "Just created" is for the first look, not for a reload: the editor has
  // seen it by now, and the address goes without it.
  const created = place.at === "variant" && place.created;
  useEffect(() => {
    if (created) replace(window.location.hash.replace(/\?created$/, ""));
  }, [created, replace]);

  /** What the page has to say above the editor: the file could not be read, or it changed under unsaved work. */
  const banner = problem ? (
    <Notice
      tone="bad"
      action={
        <Button variant="outline" onClick={() => void load({ keepDraft: true })} loading={loading}>
          {!loading && <RefreshCwIcon />} Try again
        </Button>
      }
    >
      <span className="font-medium">The project could not be read again.</span> {problem} What is on
      screen is from before.
    </Notice>
  ) : fileChanged ? (
    <Notice
      tone="warn"
      action={
        <Button
          variant="outline"
          loading={loading}
          onClick={() =>
            // A decision: the editor starts again from what the file says now.
            void load().then((view) => {
              if (view) setGeneration((count) => count + 1);
            })
          }
        >
          Read the file again
        </Button>
      }
    >
      <span className="font-medium">The file was changed somewhere else.</span> What you changed
      here is not saved, and cannot be saved over it. Reading the file again discards what you
      changed here.
    </Notice>
  ) : undefined;

  return (
    <DocsSite value={DOCS}>
      <div className="flex h-svh overflow-hidden">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
          <div className="flex h-14 shrink-0 items-center gap-2 px-4">
            <span className="text-[15px] font-semibold tracking-tight">openapi-proxy</span>
            <span className="rounded-full bg-foreground/8 px-1.5 text-[11.5px] leading-[18px] text-muted-foreground">
              local
            </span>
          </div>
          {project && (
            <>
              <div className="px-4">
                <p className="truncate text-[13px] font-medium" title={title}>
                  {title}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                  <FilePenLineIcon className="size-3.5 shrink-0" />
                  <span className="truncate">Saves go to your definition file</span>
                </p>
              </div>
              <div className="mt-5 flex h-6 items-center justify-between pr-2 pl-4">
                <h2 className="text-[11.5px] font-medium text-muted-foreground">Variants</h2>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="New variant"
                  onClick={() => {
                    if (mayLeave()) go("#/new");
                  }}
                >
                  <PlusIcon />
                </Button>
              </div>
              <nav
                aria-label="Variants"
                className="scroll-quiet mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
              >
                {variants.map((variant) => (
                  <a
                    key={variant.slug}
                    href={`#/v/${encodeURIComponent(variant.slug)}`}
                    onClick={leave}
                    className={cn(navItem, variant === open && navItemActive)}
                  >
                    <VariantIcon
                      name={variant.definition.icon ?? null}
                      className={cn(
                        "text-muted-foreground group-hover/nav:text-foreground",
                        "group-[.is-active]/nav:text-primary-foreground",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{variant.name}</span>
                  </a>
                ))}
                {variants.length === 0 && (
                  <p className="px-2 py-1 text-[12.5px] leading-5 text-muted-foreground">
                    None yet. Each variant is a selection of the document with its own URL.
                  </p>
                )}
              </nav>
              <div className="flex shrink-0 flex-col gap-1.5 border-t border-sidebar-border px-4 py-3 text-[12.5px] leading-[18px] text-muted-foreground">
                <p>
                  {plural(project.state.operations.length, "operation")} in{" "}
                  {plural(project.state.sources.length, "document")}, read each time a variant is
                  asked for.
                </p>
                <p>
                  To put it online: <span className="text-foreground">openapi-proxy deploy</span>.{" "}
                  <DocsLink slug="in-your-repository">How</DocsLink>
                </p>
              </div>
            </>
          )}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Without the sidebar, on a narrow window: the variants as one menu. */}
          {project && (
            <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
              <span className="text-[13px] font-medium">Variant</span>
              <select
                aria-label="Variant"
                className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-[13px]"
                value={open?.slug ?? ""}
                onChange={(event) => {
                  if (!mayLeave()) return;
                  go(
                    event.target.value === ""
                      ? "#/new"
                      : `#/v/${encodeURIComponent(event.target.value)}`,
                  );
                }}
              >
                <option value="">New variant</option>
                {variants.map((variant) => (
                  <option key={variant.slug} value={variant.slug}>
                    {variant.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="min-h-0 flex-1">
            {!project && problem ? (
              <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-3 px-6">
                <Notice
                  tone="bad"
                  action={
                    <Button variant="outline" onClick={() => void load()} loading={loading}>
                      {!loading && <RefreshCwIcon />} Try again
                    </Button>
                  }
                >
                  <span className="font-medium">The project could not be read.</span> {problem}
                </Notice>
                <p className="text-[13px] leading-5 text-muted-foreground">
                  The definition file and its documents are read each time. Fix what it says, and
                  try again.
                </p>
              </div>
            ) : !project || place.at === "home" ? (
              <EditorSkeleton />
            ) : place.at === "variant" && !open ? (
              <div className="flex h-full flex-col">
                {/* Said here too: the variant may be missing because the file could not be read again. */}
                {banner && <div className="shrink-0 border-b bg-subtle px-5 py-3">{banner}</div>}
                <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
                  <p className="type-heading">The file has no variant {place.slug}</p>
                  <p className="text-[13px] text-muted-foreground">
                    It may have been renamed or taken out of the file.
                  </p>
                </div>
              </div>
            ) : (
              <VariantEditor
                // One editor for as long as a variant is open. It follows what the
                // file says by itself, and keeps what is typed across its own saves.
                key={`${generation}:${open ? `v:${open.slug}` : `new:${place.at === "new" ? (place.from ?? "") : ""}`}`}
                project={project}
                variant={open}
                template={
                  place.at === "new" ? variants.find((each) => each.slug === place.from) : undefined
                }
                justCreated={created}
                banner={banner}
                document={document?.doc}
                apply={apply}
                describeError={(error) =>
                  error instanceof Error ? error.message : "Something went wrong."
                }
                onDirtyChange={(value) => {
                  dirty.current = value;
                }}
                onCreated={(slug) => go(`#/v/${encodeURIComponent(slug)}?created`)}
                // The address that was is gone: the new one takes its place.
                onRenamed={(slug) => replace(`#/v/${encodeURIComponent(slug)}`)}
                onDeleted={() => {
                  dirty.current = false;
                  replace("#/");
                }}
                onDuplicate={(slug) => {
                  if (mayLeave()) go(`#/new?from=${encodeURIComponent(slug)}`);
                }}
                words={{
                  save: "Save to file",
                  saved: "Saved to the file",
                  unsaved: "Unsaved changes",
                }}
              />
            )}
          </div>
        </main>
      </div>
      <Toaster position="bottom-right" theme="system" />
    </DocsSite>
  );
}

// The page follows the system's light or dark, as the app does by default.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const follow = () => window.document.documentElement.classList.toggle("dark", dark.matches);
follow();
dark.addEventListener("change", follow);

createRoot(window.document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
