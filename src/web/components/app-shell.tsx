import { StatusChip } from "@editor/components/status-chip";
import { VariantIcon } from "@editor/components/variant-icon";
import { projectName, projectSlug, variantsOf } from "@editor/lib/project";
import { cn, isTyping, MOD_KEY } from "@editor/lib/utils";
import { Button } from "@editor/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@editor/ui/dropdown-menu";
import { Kbd } from "@editor/ui/kbd";
import { Sheet, SheetContent, SheetTitle } from "@editor/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@editor/ui/tooltip";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  MenuIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Mark, Wordmark } from "@/components/brand";
import { CommandMenu } from "@/components/command-menu";
import { UserMenu } from "@/components/user-menu";
import { type Project, queries } from "@/lib/api";
import { checkStatus, lastProject, notFoundCount, rememberProject } from "@/lib/hooks";

const navItem =
  "group/nav flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] text-foreground/75 outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";
// Where you are: solid, in the primary color. What sits inside it (an icon, a
// status, the plan) reads `is-active` and turns to the color of its text.
const navItemActive =
  "is-active material-solid font-medium text-primary-foreground hover:text-primary-foreground";
const onActive = "group-[.is-active]/nav:text-primary-foreground";
const chipOnActive =
  "group-[.is-active]/nav:bg-white/20 group-[.is-active]/nav:text-primary-foreground group-[.is-active]/nav:ring-white/25";

/**
 * The frame around every signed-in screen: a sidebar that always shows where
 * you are (which project, which variant) and a main area that is all content.
 */
export function AppShell() {
  const { project: slug } = useParams({ strict: false });
  const projects = useQuery(queries.projects);
  const [commandOpen, setCommandOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();

  // On a page that is about no project in particular (the workspace), the
  // sidebar stays on the one you were in, so its variants are still one click away.
  const project =
    projects.data?.find((candidate) => projectSlug(candidate) === slug) ??
    (slug
      ? undefined
      : (projects.data?.find((candidate) => projectSlug(candidate) === lastProject()) ??
        projects.data?.[0]));
  const current = project ? projectSlug(project) : undefined;
  const editable = project?.state.can.edit === true;
  useEffect(() => {
    if (current) rememberProject(current);
  }, [current]);

  // ⌘K opens the command menu from anywhere; "n" starts a variant when not typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      } else if (
        event.key === "n" &&
        current &&
        editable &&
        !isTyping(event.target) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        event.preventDefault();
        void navigate({ to: "/p/$project/new", params: { project: current } });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate, current, editable]);

  const sidebar = (
    <SidebarBody
      projects={projects.data ?? []}
      project={project}
      onSearch={() => setCommandOpen(true)}
      onNavigate={() => setDrawerOpen(false)}
    />
  );

  return (
    <div className="flex h-svh overflow-hidden">
      <aside className="hidden w-60 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon />
          </Button>
          <Mark className="size-5" />
          <Wordmark />
        </div>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>

      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-64 gap-0 bg-sidebar p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} project={project} />
    </div>
  );
}

function SidebarBody({
  projects,
  project,
  onSearch,
  onNavigate,
}: {
  projects: Project[];
  project: Project | undefined;
  onSearch: () => void;
  onNavigate: () => void;
}) {
  const { variant: openVariant } = useParams({ strict: false });
  const me = useQuery(queries.me);
  const variants = project ? variantsOf(project) : [];
  const check = project?.state.check;

  return (
    <nav className="flex h-full flex-col" aria-label="Main">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <Link
          to="/app"
          className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Mark />
          <Wordmark />
        </Link>
      </div>

      <div className="px-2">
        <ProjectSwitcher projects={projects} project={project} onNavigate={onNavigate} />
        <button
          type="button"
          onClick={onSearch}
          className={cn(navItem, "mt-2 w-full text-muted-foreground")}
        >
          <SearchIcon className="size-4" />
          <span className="flex-1 text-left">Search</span>
          <Kbd>{MOD_KEY}K</Kbd>
        </button>
      </div>

      {project && (
        <>
          <div className="mt-3 flex flex-col gap-0.5 px-2">
            <Link
              to="/p/$project/settings"
              params={{ project: projectSlug(project) }}
              activeProps={{ className: navItemActive }}
              className={navItem}
              onClick={onNavigate}
            >
              <Settings2Icon
                className={cn(
                  "size-4 text-muted-foreground group-hover/nav:text-foreground",
                  onActive,
                )}
              />
              <span className="flex-1">Project settings</span>
              {check?.lastStatus === "error" && (
                <StatusChip tone="bad" className={chipOnActive}>
                  {checkStatus(check).label}
                </StatusChip>
              )}
            </Link>
          </div>

          <div className="mt-5 flex h-6 items-center justify-between pr-2 pl-4">
            <h2 className="text-[11.5px] font-medium text-muted-foreground">Variants</h2>
            {project.state.can.edit && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="New variant"
                      nativeButton={false}
                      render={
                        <Link
                          to="/p/$project/new"
                          params={{ project: projectSlug(project) }}
                          onClick={onNavigate}
                        />
                      }
                    />
                  }
                >
                  <PlusIcon />
                </TooltipTrigger>
                <TooltipContent side="right">
                  New variant <Kbd>N</Kbd>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          <div className="scroll-quiet mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
            {variants.map((variant) => {
              const missing = notFoundCount(variant.state.notFound);
              return (
                <Link
                  key={variant.slug}
                  to="/p/$project/v/$variant"
                  params={{ project: projectSlug(project), variant: variant.slug }}
                  className={cn(navItem, variant.slug === openVariant && navItemActive)}
                  onClick={onNavigate}
                >
                  <VariantIcon
                    name={variant.definition.icon ?? null}
                    className={cn(
                      "text-muted-foreground group-hover/nav:text-foreground",
                      onActive,
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{variant.name}</span>
                  {missing > 0 && (
                    <StatusChip
                      tone="warn"
                      className={chipOnActive}
                      title="Names in its selection that the document does not have"
                    >
                      {missing} not found
                    </StatusChip>
                  )}
                </Link>
              );
            })}
            {variants.length === 0 && (
              <p className="px-2 py-1 text-[12.5px] leading-5 text-muted-foreground">
                None yet. Each variant is a selection of this document with its own URL.
              </p>
            )}
          </div>
        </>
      )}
      {!project && <div className="flex-1" />}

      <div className="flex shrink-0 flex-col gap-1 border-t border-sidebar-border p-2">
        <Link
          to="/workspace"
          activeProps={{ className: navItemActive }}
          className={navItem}
          onClick={onNavigate}
        >
          <UsersIcon
            className={cn("size-4 text-muted-foreground group-hover/nav:text-foreground", onActive)}
          />
          <span className="flex-1">Workspace</span>
          {/* Where there are plans, which one this is: billing is on that page. */}
          {me.data?.plansEnabled && (
            <span className="text-[12px] text-faint group-[.is-active]/nav:text-primary-foreground/80">
              {me.data.planName}
            </span>
          )}
        </Link>
        <UserMenu />
      </div>
    </nav>
  );
}

function ProjectTile({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-foreground text-[11px] font-semibold text-background",
        className,
      )}
    >
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function ProjectSwitcher({
  projects,
  project,
  onNavigate,
}: {
  projects: Project[];
  project: Project | undefined;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const go = (slug: string) => {
    onNavigate();
    void navigate({ to: "/p/$project", params: { project: slug } });
  };

  if (projects.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="material-raised material-raised-hover flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Switch project"
      >
        {project ? (
          <>
            <ProjectTile name={projectName(project)} />
            <span className="min-w-0 flex-1 truncate">{projectName(project)}</span>
          </>
        ) : (
          <span className="flex-1 text-muted-foreground">Choose a project</span>
        )}
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="min-w-56">
        {projects.map((candidate) => (
          <DropdownMenuItem key={projectSlug(candidate)} onClick={() => go(projectSlug(candidate))}>
            <ProjectTile name={projectName(candidate)} />
            <span className="min-w-0 flex-1 truncate">{projectName(candidate)}</span>
            {candidate === project && <CheckIcon className="text-muted-foreground" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            onNavigate();
            void navigate({ to: "/connect" });
          }}
        >
          <PlusIcon /> New project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
