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
  const variants = useQuery(queries.variants);
  const { resolved } = useTheme();

  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "";

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

        {(variants.data?.length ?? 0) > 0 && (
          <CommandGroup heading="Variants">
            {variants.data?.map((variant) => (
              <CommandItem
                key={variant.id}
                value={`${variant.name} ${variant.path} ${projectName(variant.projectId)}`}
                onSelect={run(() =>
                  navigate({
                    to: "/p/$projectId/v/$variantId",
                    params: { projectId: variant.projectId, variantId: variant.id },
                  }),
                )}
              >
                <FileTextIcon />
                <span className="truncate">{variant.name}</span>
                <span className="ml-auto truncate text-[12px] text-muted-foreground">
                  {variant.path}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Actions">
          {project && (
            <>
              <CommandItem
                onSelect={run(() =>
                  navigate({ to: "/p/$projectId/new", params: { projectId: project.id } }),
                )}
              >
                <PlusIcon /> New variant in {project.name}
              </CommandItem>
              <CommandItem
                onSelect={run(() =>
                  navigate({ to: "/p/$projectId/settings", params: { projectId: project.id } }),
                )}
              >
                <Settings2Icon /> Settings of {project.name}
              </CommandItem>
            </>
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
                key={candidate.id}
                value={`project ${candidate.name} ${candidate.slug}`}
                onSelect={run(() =>
                  navigate({ to: "/p/$projectId", params: { projectId: candidate.id } }),
                )}
              >
                <LayoutListIcon /> {candidate.name}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
