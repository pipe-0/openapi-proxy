import { MethodChip } from "@editor/components/method-chip";
import { OperationPath } from "@editor/components/operation-path";
import { Missing, Page, PageHeader, Section, useTitle } from "@editor/components/page";
import { UrlBar } from "@editor/components/url-bar";
import type { InheritedVisibility } from "@editor/components/visibility";
import {
  originalOf,
  projectName,
  projectSlug,
  type VariantView,
  variantsOf,
  withVariant,
} from "@editor/lib/project";
import { plural } from "@editor/lib/utils";
import { Button } from "@editor/ui/button";
import { Skeleton } from "@editor/ui/skeleton";
import {
  type OperationEntry,
  ORIGINAL_VARIANT,
  resolveSelection,
  type SpecFormat,
  type Visibility,
} from "@openapi-proxy/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { NewKeyDialog } from "@/components/api-keys";
import { Documents } from "@/components/documents";
import { ManagedByFile } from "@/components/managed-by-file";
import { errorMessage, type Project } from "@/lib/api";
import { type CreatedKey, keysApi, keysQuery } from "@/lib/api-keys";
import { useProject } from "@/lib/hooks";
import { useApply } from "@/lib/use-apply";

/**
 * What a project opens on: its documents as they are, which it serves at
 * `/v/<project>/original`, where they come from, and every operation in them
 * with the variants that serve it.
 */
export function ProjectOriginalPage() {
  const { project: slug } = useParams({ from: "/_client/_app/p/$project/" });
  const { project, isPending } = useProject(slug);
  useTitle(project ? projectName(project) : undefined);

  if (isPending) {
    return (
      <Page className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64" />
      </Page>
    );
  }
  if (!project) return <Missing what="Project" />;
  return <Original project={project} />;
}

function Original({ project }: { project: Project }) {
  const original = originalOf(project);
  const { can } = project.state;
  return (
    <Page>
      <PageHeader
        title="Original"
        description={`${projectName(project)} as its documents are: every operation, and nothing at the top replaced.`}
        actions={
          can.edit && (
            <Button
              nativeButton={false}
              render={<Link to="/p/$project/new" params={{ project: projectSlug(project) }} />}
            >
              <PlusIcon /> New variant
            </Button>
          )
        }
      />
      <div className="flex flex-col gap-14">
        {!can.edit && <ManagedByFile project={project} />}
        {original && <Address project={project} original={original} />}
        <Documents project={project} />
        <Operations project={project} />
      </div>
    </Page>
  );
}

/** Where the original is served, and who may read it. */
function Address({ project, original }: { project: Project; original: VariantView }) {
  const queryClient = useQueryClient();
  const apply = useApply(project);
  const [format, setFormat] = useState<SpecFormat>("json");
  const [newKey, setNewKey] = useState<CreatedKey>();
  const stated = original.definition.visibility;
  const inherited: InheritedVisibility =
    project.definition.visibility !== undefined
      ? { value: project.definition.visibility, from: "project" }
      : { value: project.state.defaultVisibility, from: "workspace" };
  const visibility = stated ?? inherited.value;
  const suffix = `.${format}`;

  const save = useMutation({
    mutationFn: (next: Visibility | undefined) =>
      apply.mutateAsync((definition) =>
        withVariant(definition, ORIGINAL_VARIANT, next ? { visibility: next } : undefined),
      ),
    onSuccess: (_, next) => {
      const now = next ?? inherited.value;
      toast.success(
        now === "private"
          ? "Private: readers need a user API key"
          : "Public: anyone with the URL can read it",
      );
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const pick = (next: Visibility | undefined) => {
    if (next === stated) return;
    // Opening it to everyone is said twice. Anything else is not.
    const opens = (next ?? inherited.value) === "public" && visibility !== "public";
    if (
      !opens ||
      window.confirm(
        "Make the original public? Anyone with its URL will be able to read every operation.",
      )
    ) {
      save.mutate(next);
    }
  };
  const createKey = useMutation({
    mutationFn: () =>
      keysApi.create({
        name: `Reads the original of ${projectName(project)}`.slice(0, 60),
        access: "read",
        variant: { project: projectSlug(project), variant: ORIGINAL_VARIANT },
      }),
    onSuccess: (created) => {
      setNewKey(created);
      void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Section
      title="URL"
      description="Every project serves its documents as they are, next to the variants made from them."
    >
      <UrlBar
        url={original.state.url}
        suffix={suffix}
        format={format}
        onFormatChange={setFormat}
        formatHere
        celebrate={false}
        stated={stated}
        inherited={inherited}
        onVisibilityChange={pick}
        busy={save.isPending || !project.state.can.edit}
        withKeys={project.state.can.keys}
        privateAction={
          project.state.can.keys && (
            <Button
              variant="outline"
              size="sm"
              loading={createKey.isPending}
              onClick={() => createKey.mutate()}
            >
              Create a key for the original
            </Button>
          )
        }
      />
      <NewKeyDialog
        created={newKey}
        usage={{
          label: "To read the original:",
          command: (key) => `curl -H "Authorization: Bearer ${key}" ${original.state.url}${suffix}`,
        }}
        onClose={() => setNewKey(undefined)}
      />
    </Section>
  );
}

const UNTAGGED = "\u0000untagged";

/** Every operation of the documents, by tag, with the variants that serve it. */
function Operations({ project }: { project: Project }) {
  const entries = project.state.operations;
  const variants = variantsOf(project);
  const servedBy = useMemo(() => {
    const index = { entries, tags: [], totalOperations: entries.length };
    const sets = variants.map((variant) => ({
      name: variant.name,
      keys: resolveSelection(index, variant.selection),
    }));
    return new Map(
      entries.map((entry) => [
        entry.key,
        sets.filter((set) => set.keys.has(entry.key)).map((set) => set.name),
      ]),
    );
  }, [entries, variants]);
  const groups = useMemo(() => byTag(entries), [entries]);
  const unserved = entries.filter((entry) => (servedBy.get(entry.key) ?? []).length === 0).length;

  return (
    <Section
      title="Operations"
      description={
        variants.length === 0
          ? `${plural(entries.length, "operation")}. A variant serves a selection of them at a URL of its own.`
          : `${plural(entries.length, "operation")}, ${unserved === 0 ? "each served by a variant" : `${unserved} not served by any variant`}.`
      }
    >
      <div className="flex flex-col gap-8">
        {groups.map((group) => (
          <div key={group.id}>
            <h3 className="flex items-baseline gap-2 text-[13px] font-medium">
              {group.label}
              <span className="font-normal text-faint tabular-nums">{group.entries.length}</span>
            </h3>
            <ul className="mt-2 flex flex-col">
              {group.entries.map((entry) => {
                const names = servedBy.get(entry.key) ?? [];
                return (
                  <li
                    key={entry.key}
                    className="flex min-h-8 items-center gap-3 border-b border-border/60 py-1 text-[13px] last:border-b-0"
                  >
                    <MethodChip method={entry.method} />
                    <OperationPath path={entry.path} webhook={entry.webhook} className="flex-1" />
                    <span
                      className={
                        names.length > 0
                          ? "max-w-[45%] shrink-0 truncate text-right text-muted-foreground"
                          : "shrink-0 text-right text-faint"
                      }
                      title={names.join(", ")}
                    >
                      {names.length > 0 ? names.join(", ") : "Not in a variant"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function byTag(
  entries: OperationEntry[],
): Array<{ id: string; label: string; entries: OperationEntry[] }> {
  const groups = new Map<string, OperationEntry[]>();
  for (const entry of entries) {
    for (const tag of entry.tags.length > 0 ? new Set(entry.tags) : [UNTAGGED]) {
      const list = groups.get(tag);
      if (list) list.push(entry);
      else groups.set(tag, [entry]);
    }
  }
  const untagged = groups.get(UNTAGGED);
  groups.delete(UNTAGGED);
  return [
    ...[...groups].map(([tag, list]) => ({ id: tag, label: tag, entries: list })),
    ...(untagged ? [{ id: UNTAGGED, label: "No tag", entries: untagged }] : []),
  ];
}
