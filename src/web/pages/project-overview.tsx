import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Missing, Notice, Page, PageHeader, useTitle } from "@/components/page";
import { StatusChip } from "@/components/status-chip";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, errorMessage, type Project, queries, type Variant } from "@/lib/api";
import { driftOf, sourceStatus, useProject, useProjectVariants } from "@/lib/hooks";
import { formatBytes, formatRelativeTime, plural } from "@/lib/utils";

export function useRefreshProject(project: Project | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshProject((project as Project).id),
    onSuccess: (result) => {
      queryClient.setQueryData<Project[]>(queries.projects.queryKey, (current) =>
        current?.map((existing) => (existing.id === result.project.id ? result.project : existing)),
      );
      void queryClient.invalidateQueries({ queryKey: queries.variants.queryKey });
      if (result.project.lastStatus === "error") {
        toast.error(result.project.lastError ?? "The source could not be checked.");
      } else if (result.changed) {
        toast.success(
          `Source updated: ${result.addedOps.length} added, ${result.removedOps.length} removed`,
        );
      } else {
        toast.success("Already up to date");
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
}

/** A project at a glance: is the source fine, and what is being served from it. */
export function ProjectOverviewPage() {
  const { projectId } = useParams({ from: "/_client/_app/p/$projectId/" });
  const { project, isPending } = useProject(projectId);
  const { variants, isPending: variantsPending } = useProjectVariants(projectId);
  const refresh = useRefreshProject(project);
  useTitle(project?.name);

  if (isPending) {
    return (
      <Page className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40" />
      </Page>
    );
  }
  if (!project) return <Missing what="Project" />;
  const status = sourceStatus(project);

  return (
    <Page>
      <PageHeader
        title={project.name}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusChip tone={status.tone} title={status.detail}>
              {status.label}
            </StatusChip>
            <span>
              {plural(project.opIndex.length, "operation")}, {formatBytes(project.bodyBytes)},
              checked {formatRelativeTime(project.fetchedAt)}
            </span>
          </span>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => refresh.mutate()} loading={refresh.isPending}>
              {!refresh.isPending && <RefreshCwIcon />} Check source
            </Button>
            <Button
              nativeButton={false}
              render={<Link to="/p/$projectId/new" params={{ projectId: project.id }} />}
            >
              <PlusIcon /> New variant
            </Button>
          </>
        }
      />

      {project.lastStatus === "error" && (
        <Notice
          tone="bad"
          className="mb-6"
          action={
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link to="/p/$projectId/settings" params={{ projectId: project.id }} />}
            >
              Open sources
            </Button>
          }
        >
          <span className="font-medium">The last check of the source failed.</span>{" "}
          {project.lastError} Variants keep serving the last good copy.
        </Notice>
      )}

      {variantsPending ? (
        <Skeleton className="h-40" />
      ) : variants.length === 0 ? (
        <Empty className="rounded-xl border border-dashed py-16">
          <EmptyHeader>
            <EmptyTitle>No variants yet</EmptyTitle>
            <EmptyDescription>
              A variant is a selection of this document's operations, served at its own URL. Make
              one for each audience: public docs, an SDK, a partner.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              nativeButton={false}
              render={<Link to="/p/$projectId/new" params={{ projectId: project.id }} />}
            >
              <PlusIcon /> New variant
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <VariantTable project={project} variants={variants} />
      )}
    </Page>
  );
}

function VariantTable({ project, variants }: { project: Project; variants: Variant[] }) {
  const navigate = useNavigate();
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[26%]">Name</TableHead>
          <TableHead>URL</TableHead>
          <TableHead className="w-40">Operations</TableHead>
          <TableHead className="w-24 text-right">Changed</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {variants.map((variant) => {
          const drift = driftOf(variant);
          return (
            <TableRow
              key={variant.id}
              className="group cursor-default"
              onClick={() =>
                navigate({
                  to: "/p/$projectId/v/$variantId",
                  params: { projectId: project.id, variantId: variant.id },
                })
              }
            >
              <TableCell className="h-12">
                <span className="flex items-center gap-2">
                  <Link
                    to="/p/$projectId/v/$variantId"
                    params={{ projectId: project.id, variantId: variant.id }}
                    className="truncate rounded font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {variant.name}
                  </Link>
                  {drift.missing > 0 && <StatusChip tone="warn">{drift.missing} gone</StatusChip>}
                  {drift.added > 0 && <StatusChip tone="accent">{drift.added} new</StatusChip>}
                </span>
              </TableCell>
              <TableCell>
                <span className="flex items-center gap-1">
                  <code className="truncate font-sans text-[13px] text-muted-foreground">
                    {variant.path}
                  </code>
                  <CopyButton
                    value={variant.url}
                    what="URL copied"
                    variant="ghost"
                    size="icon-xs"
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(event) => event.stopPropagation()}
                  />
                </span>
              </TableCell>
              <TableCell>
                <span className="text-[13px] tabular-nums">
                  {variant.keptOperations}
                  <span className="text-faint"> of {variant.totalOperations}</span>
                </span>
              </TableCell>
              <TableCell className="text-right text-[13px] text-muted-foreground">
                {formatRelativeTime(variant.updatedAt)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
