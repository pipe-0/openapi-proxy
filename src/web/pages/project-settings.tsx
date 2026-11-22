import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { RefreshCwIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Field, Missing, Notice, Page, PageHeader, Section, useTitle } from "@/components/page";
import { Segmented } from "@/components/segmented";
import { SLUG_HELP, SlugInput, useSlugStatus } from "@/components/slug-input";
import { AddSource, DocsLink, MergeNotes, SourceCard } from "@/components/source-card";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, bareUrl, errorMessage, type Project, queries, RequestError } from "@/lib/api";
import { sourceStatus, useProject, useProjectVariants } from "@/lib/hooks";
import { formatBytes, formatRelativeTime, plural } from "@/lib/utils";
import { useRefreshProject } from "@/pages/project-overview";

export function ProjectSettingsPage() {
  const { projectId } = useParams({ from: "/_client/_app/p/$projectId/settings" });
  const { project, isPending } = useProject(projectId);
  useTitle(project ? `Sources · ${project.name}` : undefined);

  if (isPending) {
    return (
      <Page className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64" />
      </Page>
    );
  }
  if (!project) return <Missing what="Project" />;

  return (
    // Remount after a save, so the form starts from what the server now holds.
    <Settings
      key={JSON.stringify([project.name, project.slug, project.ttlSeconds])}
      project={project}
    />
  );
}

function Settings({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { variants } = useProjectVariants(project.id);
  const refresh = useRefreshProject(project);

  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);
  const [ttl, setTtl] = useState(String(project.ttlSeconds));

  const checkSlug = useCallback(
    (candidate: string) => api.checkProjectSlug(candidate, project.id),
    [project.id],
  );
  const slugStatus = useSlugStatus(slug, checkSlug, "projects", project.slug);
  const ttlSeconds = Number(ttl);

  const changes: Parameters<typeof api.updateProject>[1] = {
    ...(name.trim() !== project.name ? { name: name.trim() } : {}),
    ...(slug !== project.slug ? { slug } : {}),
    ...(ttlSeconds !== project.ttlSeconds ? { ttlSeconds } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const valid = name.trim() !== "" && slugStatus === "available";

  const save = useMutation({
    mutationFn: () => api.updateProject(project.id, changes),
    onSuccess: (updated) => {
      queryClient.setQueryData<Project[]>(queries.projects.queryKey, (current) =>
        current?.map((existing) => (existing.id === updated.id ? updated : existing)),
      );
      void queryClient.invalidateQueries({ queryKey: queries.variants.queryKey });
      toast.success("Settings saved");
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queries.projects.queryKey });
      void queryClient.invalidateQueries({ queryKey: queries.variants.queryKey });
      toast.success(`Deleted ${project.name}`);
      void navigate({ to: "/app" });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const status = sourceStatus(project);
  const saveError = save.error instanceof RequestError ? save.error : undefined;
  const several = project.sources.length > 1;

  return (
    <Page>
      {/* Not one form: each document below saves on its own, and forms cannot nest. */}
      <div>
        <PageHeader
          title="Sources"
          description={`Where ${project.name} comes from, and how it is kept current.`}
          actions={
            <>
              {dirty && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setName(project.name);
                    setSlug(project.slug);
                    setTtl(String(project.ttlSeconds));
                    save.reset();
                  }}
                >
                  Discard
                </Button>
              )}
              <Button
                disabled={!dirty || !valid}
                loading={save.isPending}
                onClick={() => save.mutate()}
              >
                Save changes
              </Button>
            </>
          }
        />

        {(saveError || save.isError) && (
          <Notice tone="bad" className="mb-8">
            <span className="font-medium">{saveError?.message ?? errorMessage(save.error)}</span>
            {saveError?.detail && <span> {saveError.detail}</span>}
          </Notice>
        )}

        <div className="flex flex-col gap-14">
          <Section
            title={several ? "Documents" : "Document"}
            description={
              several
                ? "This project is merged from these OpenAPI documents. The first is the main one: its title and servers describe the project, and where two define the same operation, the earlier one is kept."
                : "The OpenAPI document this project is built from."
            }
            action={
              <Button
                variant="outline"
                onClick={() => refresh.mutate()}
                loading={refresh.isPending}
              >
                {!refresh.isPending && <RefreshCwIcon />} Check now
              </Button>
            }
          >
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              <Fact label="Status">
                <StatusChip tone={status.tone} title={status.detail}>
                  {status.label}
                </StatusChip>
              </Fact>
              <Fact label="Last checked">{formatRelativeTime(project.fetchedAt)}</Fact>
              <Fact label="Contents">
                {plural(project.opIndex.length, "operation")}, {formatBytes(project.bodyBytes)}
              </Fact>
              <Fact label="Format">OpenAPI {project.specVersion}</Fact>
            </dl>
            <div className="flex flex-col gap-5">
              {project.sources.map((source) => (
                <SourceCard
                  // Remount after a save, so its fields start from what the server now holds.
                  key={JSON.stringify(source)}
                  project={project}
                  source={source}
                  intervalLabel={howOften(ttlSeconds)}
                />
              ))}
            </div>
            <MergeNotes project={project} />
            <AddSource project={project} />
          </Section>

          <Section
            title="Keeping in sync"
            description={
              <>
                Variants are served from a stored copy. Once it is older than the interval, the next
                request checks {several ? "every document" : "your API"} before it is answered.{" "}
                <DocsLink slug="keeping-in-sync">How checks work</DocsLink>
              </>
            }
          >
            <Field label="Check interval" hint="How old a served document may be.">
              <Segmented
                aria-label="Check interval"
                value={ttl}
                onValueChange={setTtl}
                options={intervalOptions(project.ttlSeconds)}
              />
            </Field>
          </Section>

          <Section title="Project" description="How this project is named here and in public URLs.">
            <Field label="Name" htmlFor="project-name">
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                className="max-w-sm"
              />
            </Field>
            <Field
              label="URL prefix"
              htmlFor="project-slug"
              error={
                slugStatus === "taken" || slugStatus === "invalid"
                  ? SLUG_HELP[slugStatus]
                  : undefined
              }
              hint={
                slug !== project.slug && variants.length > 0
                  ? `Changing this moves the URL of ${plural(variants.length, "variant")}. The old URLs will return 404.`
                  : "Every variant of this project is served under it."
              }
            >
              <SlugInput
                id="project-slug"
                label="Project URL slug"
                prefix={bareUrl(project.urlPrefix)}
                value={slug}
                onChange={setSlug}
                status={slugStatus}
                className="max-w-md"
              />
            </Field>
          </Section>

          <Section
            title="Delete project"
            description={
              variants.length > 0
                ? `Removes the project, its stored copy of the document and its ${plural(variants.length, "variant")}. Their URLs stop working at once.`
                : "Removes the project and its stored copy of the document."
            }
            action={
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="destructive-ghost" />}>
                  Delete project
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {variants.length > 0
                        ? `This also deletes ${plural(variants.length, "variant")}. Anything still requesting their URLs will get a 404.`
                        : "The project and its stored copy of the document are removed."}{" "}
                      This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => remove.mutate()}
                      loading={remove.isPending}
                    >
                      Delete project
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            }
          />
        </div>
      </div>
    </Page>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11.5px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-[13px]">{children}</dd>
    </div>
  );
}

const INTERVALS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "0", label: "Every request" },
  { value: "60", label: "1 minute" },
  { value: "300", label: "5 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "1 day" },
];

/** The presets, plus the project's own value if it was set to something else through the API. */
function intervalOptions(current: number) {
  if (INTERVALS.some((option) => option.value === String(current))) return INTERVALS;
  return [...INTERVALS, { value: String(current), label: `${current} seconds` }].sort(
    (a, b) => Number(a.value) - Number(b.value),
  );
}

/** How often a check can happen, in words. */
function howOften(interval: number): string {
  if (interval <= 0) return "on every request";
  const label = INTERVALS.find((option) => Number(option.value) === interval)?.label;
  return `at most once every ${label ?? `${interval} seconds`}`;
}
