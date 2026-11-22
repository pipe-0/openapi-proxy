import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Documents } from "@/components/documents";
import { Field, Missing, Notice, Page, PageHeader, Section, useTitle } from "@/components/page";
import { ProjectNotifications } from "@/components/project-notifications";
import { SLUG_HELP, SlugInput, useSlugStatus } from "@/components/slug-input";
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
import { useProject, useProjectVariants } from "@/lib/hooks";
import { plural } from "@/lib/utils";

export function ProjectSettingsPage() {
  const { projectId } = useParams({ from: "/_client/_app/p/$projectId/settings" });
  const { project, isPending } = useProject(projectId);
  useTitle(project ? `Project settings · ${project.name}` : undefined);

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
    <Settings key={JSON.stringify([project.name, project.slug])} project={project} />
  );
}

function Settings({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { variants } = useProjectVariants(project.id);

  const [name, setName] = useState(project.name);
  const [slug, setSlug] = useState(project.slug);

  const checkSlug = useCallback(
    (candidate: string) => api.checkProjectSlug(candidate, project.id),
    [project.id],
  );
  const slugStatus = useSlugStatus(slug, checkSlug, "projects", project.slug);

  const changes: Parameters<typeof api.updateProject>[1] = {
    ...(name.trim() !== project.name ? { name: name.trim() } : {}),
    ...(slug !== project.slug ? { slug } : {}),
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

  const saveError = save.error instanceof RequestError ? save.error : undefined;

  return (
    <Page>
      <PageHeader title="Project settings" />
      <div>
        <div className="flex flex-col gap-14">
          <Documents project={project} />

          <ProjectNotifications project={project} />

          <Section
            title="Name and URL"
            description="How this project is named here and in public URLs."
            action={
              <div className="flex items-center gap-2">
                {dirty && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setName(project.name);
                      setSlug(project.slug);
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
              </div>
            }
          >
            {(saveError || save.isError) && (
              <Notice tone="bad">
                <span className="font-medium">
                  {saveError?.message ?? errorMessage(save.error)}
                </span>
                {saveError?.detail && <span> {saveError.detail}</span>}
              </Notice>
            )}
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
