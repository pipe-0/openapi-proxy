import { projectName, projectSlug, variantsOf } from "@editor/lib/project";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  FileTextIcon,
  LayoutListIcon,
  LogOutIcon,
  MoonIcon,
  PlusIcon,
  Settings2Icon,
  SunIcon,
  UsersIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { signOut } from "@/components/user-menu";
import { type Project, queries } from "@/lib/api";
import { setTheme, useTheme } from "@/lib/theme";

/**
 * ⌘K: jump to any variant or project, or run an action, without reaching for
 * the mouse. Everything here is also reachable through the sidebar.
 */
export function CommandMenu({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | undefined;
}) {
  const navigate = useNavigate();
  const projects = useQuery(queries.projects);
  const { resolved } = useTheme();
  const variants = (projects.data ?? []).flatMap((owner) =>
    variantsOf(owner).map((variant) => ({ owner, variant })),
  );

  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Jump to a variant or project, or run an action."
      className="sm:max-w-lg"
    >
      <CommandInput placeholder="Search variants, projects and actions" />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>

        {variants.length > 0 && (
          <CommandGroup heading="Variants">
            {variants.map(({ owner, variant }) => {
              const path = new URL(variant.state.url).pathname;
              return (
                <CommandItem
                  key={path}
                  value={`${variant.name} ${path} ${projectName(owner)}`}
                  onSelect={run(() =>
                    navigate({
                      to: "/p/$project/v/$variant",
                      params: { project: projectSlug(owner), variant: variant.slug },
                    }),
                  )}
                >
                  <FileTextIcon />
                  <span className="truncate">{variant.name}</span>
                  <span className="ml-auto truncate text-[12px] text-muted-foreground">{path}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}

        <CommandGroup heading="Actions">
          {project?.state.can.edit && (
            <CommandItem
              onSelect={run(() =>
                navigate({ to: "/p/$project/new", params: { project: projectSlug(project) } }),
              )}
            >
              <PlusIcon /> New variant in {projectName(project)}
            </CommandItem>
          )}
          {project && (
            <CommandItem
              onSelect={run(() =>
                navigate({ to: "/p/$project/settings", params: { project: projectSlug(project) } }),
              )}
            >
              <Settings2Icon /> Settings of {projectName(project)}
            </CommandItem>
          )}
          <CommandItem onSelect={run(() => navigate({ to: "/connect" }))}>
            <PlusIcon /> New project
          </CommandItem>
          <CommandItem
            value="Workspace people members invite plan"
            onSelect={run(() => navigate({ to: "/workspace" }))}
          >
            <UsersIcon /> Workspace
          </CommandItem>
          <CommandItem onSelect={run(() => setTheme(resolved === "dark" ? "light" : "dark"))}>
            {resolved === "dark" ? <SunIcon /> : <MoonIcon />}
            Switch to {resolved === "dark" ? "light" : "dark"} mode
          </CommandItem>
          <CommandItem onSelect={run(() => void signOut())}>
            <LogOutIcon /> Sign out
          </CommandItem>
        </CommandGroup>

        {(projects.data?.length ?? 0) > 1 && (
          <CommandGroup heading="Projects">
            {projects.data?.map((candidate) => (
              <CommandItem
                key={projectSlug(candidate)}
                value={`project ${projectName(candidate)} ${projectSlug(candidate)}`}
                onSelect={run(() =>
                  navigate({ to: "/p/$project", params: { project: projectSlug(candidate) } }),
                )}
              >
                <LayoutListIcon /> {projectName(candidate)}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
