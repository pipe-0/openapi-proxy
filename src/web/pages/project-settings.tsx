import { CopyButton } from "@editor/components/copy-button";
import {
  Field,
  Missing,
  Notice,
  Page,
  PageHeader,
  Section,
  useTitle,
} from "@editor/components/page";
import { projectName, projectSlug, variantsOf } from "@editor/lib/project";
import { bareUrl, plural } from "@editor/lib/utils";
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
} from "@editor/ui/alert-dialog";
import { Button } from "@editor/ui/button";
import { Input } from "@editor/ui/input";
import { Skeleton } from "@editor/ui/skeleton";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Documents } from "@/components/documents";
import { ManagedByFile } from "@/components/managed-by-file";
import { ProjectNotifications } from "@/components/project-notifications";
import { api, errorMessage, type Project, queries, RequestError } from "@/lib/api";
import { useProject } from "@/lib/hooks";
import { useApply } from "@/lib/use-apply";

export function ProjectSettingsPage() {
  const { project: slug } = useParams({ from: "/_client/_app/p/$project/settings" });
  const { project, isPending } = useProject(slug);
  useTitle(project ? `Project settings · ${projectName(project)}` : undefined);

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
    <Settings key={JSON.stringify([slug, project.definition.name])} project={project} />
  );
}

function Settings({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const apply = useApply(project);
  const slug = projectSlug(project);
  const variants = variantsOf(project);
  const { can } = project.state;
  const address = `${project.state.urlPrefix}${slug}/`;

  const [name, setName] = useState(project.definition.name ?? "");
  const dirty = name.trim() !== (project.definition.name ?? "");

  const save = useMutation({
    mutationFn: () =>
      apply.mutateAsync(({ name: _, ...definition }) => ({
        ...definition,
        ...(name.trim() !== "" ? { name: name.trim() } : {}),
      })),
    onSuccess: () => toast.success("Settings saved"),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteProject(slug),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queries.projects.queryKey });
      toast.success(`Deleted ${projectName(project)}`);
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
          {!can.edit && <ManagedByFile project={project} />}

          <Documents project={project} />

          <ProjectNotifications project={project} />

          <Section
            title="Name and URL"
            description="How this project is named here, and where its variants are served."
            action={
              can.edit && (
                <div className="flex items-center gap-2">
                  {dirty && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setName(project.definition.name ?? "");
                        save.reset();
                      }}
                    >
                      Discard
                    </Button>
                  )}
                  <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                    Save changes
                  </Button>
                </div>
              )
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
            <Field
              label="Name"
              htmlFor="project-name"
              hint="Shown in the app and in emails about changes. Left empty, the project goes by its slug."
            >
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={slug}
                maxLength={100}
                className="max-w-sm"
                readOnly={!can.edit}
              />
            </Field>
            <Field
              label="URL prefix"
              hint="Every variant of this project is served under it. The slug at its end is what a definition file calls the project, and stays for as long as the project does."
            >
              <span className="flex max-w-md items-center gap-2">
                <code
                  className="flex h-8 min-w-0 flex-1 items-center rounded-lg border bg-subtle px-2.5 font-sans text-[13px]"
                  data-testid="project-url-prefix"
                >
                  <span className="truncate">
                    <span className="text-faint">{bareUrl(project.state.urlPrefix)}</span>
                    {slug}/
                  </span>
                </code>
                <CopyButton value={address} label="Copy" what="URL prefix copied" />
              </span>
            </Field>
          </Section>

          <Section
            title="Delete project"
            description={
              variants.length > 0
                ? `Removes the project, its stored documents and its ${plural(variants.length, "variant")}. Their URLs stop working at once.`
                : "Removes the project and its stored documents."
            }
            action={
              <AlertDialog>
                <AlertDialogTrigger render={<Button variant="destructive-ghost" />}>
                  Delete project
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {projectName(project)}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {variants.length > 0
                        ? `This also deletes ${plural(variants.length, "variant")}. Anything still requesting their URLs will get a 404.`
                        : "The project and its stored documents are removed."}{" "}
                      {can.edit
                        ? "This cannot be undone."
                        : "The next deploy of its file would create it again."}
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
