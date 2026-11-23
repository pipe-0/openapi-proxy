import { Missing, useTitle } from "@editor/components/page";
import { representation } from "@editor/lib/document";
import { projectSlug, type VariantView, variantsOf } from "@editor/lib/project";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@editor/ui/alert-dialog";
import { Button } from "@editor/ui/button";
import { EditorSkeleton, VariantEditor } from "@editor/variant-editor";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { NewKeyDialog } from "@/components/api-keys";
import { ManagedByFile } from "@/components/managed-by-file";
import { errorMessage, type Project } from "@/lib/api";
import { type CreatedKey, keysApi, keysQuery } from "@/lib/api-keys";
import { useProject } from "@/lib/hooks";
import { useApply } from "@/lib/use-apply";
import { useProjectDoc } from "@/lib/use-project-doc";

export function VariantNewPage() {
  const { project: slug } = useParams({ from: "/_client/_app/p/$project/new" });
  const { from } = useSearch({ from: "/_client/_app/p/$project/new" });
  const { project, isPending } = useProject(slug);
  useTitle("New variant");
  if (isPending) return <EditorSkeleton />;
  if (!project) return <Missing what="Project" />;
  // A copy starts from another variant: the same operations for another audience or environment.
  const template = variantsOf(project).find((candidate) => candidate.slug === from);
  return <Hosted key={`new:${slug}:${from ?? ""}`} project={project} template={template} />;
}

export function VariantEditorPage() {
  const params = useParams({ from: "/_client/_app/p/$project/v/$variant" });
  const { created } = useSearch({ from: "/_client/_app/p/$project/v/$variant" });
  const { project, isPending } = useProject(params.project);
  const variant = project
    ? variantsOf(project).find((candidate) => candidate.slug === params.variant)
    : undefined;
  useTitle(variant?.name);

  if (isPending) return <EditorSkeleton />;
  if (!project) return <Missing what="Project" />;
  if (!variant) return <Missing what="Variant" />;
  const { name, overrides } = variant.definition;
  return (
    // Remount when what is published changes, so the editor starts from it.
    <Hosted
      key={JSON.stringify([variant.state.id, name, variant.selection, overrides])}
      project={project}
      variant={variant}
      justCreated={created === true}
    />
  );
}

/**
 * The editor as the app shows it. The screen itself is the same one
 * `openapi-proxy dev` serves for a definition file. What the app adds is
 * where it leads (routes), how a change is saved (applied to the service),
 * and what only the service has: user API keys, and the notice on a project
 * that is deployed from a file.
 */
function Hosted({
  project,
  variant,
  template,
  justCreated = false,
}: {
  project: Project;
  variant?: VariantView;
  template?: VariantView | undefined;
  justCreated?: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const source = useProjectDoc(project);
  const apply = useApply(project);
  const slug = projectSlug(project);
  const [dirty, setDirty] = useState(false);
  // Set by what the editor itself does (create, rename, delete): nothing is lost by going there.
  const leaving = useRef(false);
  const go = (to: () => void) => {
    leaving.current = true;
    to();
  };

  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !leaving.current,
    enableBeforeUnload: () => dirty && !leaving.current,
    withResolver: true,
  });

  // A key for the readers of this variant, and of no other.
  const [newKey, setNewKey] = useState<CreatedKey>();
  const [shown, setShown] = useState("");
  const createReaderKey = useMutation({
    mutationFn: () =>
      keysApi.create({
        name: `Reads ${(variant as VariantView).name}`.slice(0, 60),
        access: "read",
        variant: { project: slug, variant: (variant as VariantView).slug },
      }),
    onSuccess: (created) => {
      setNewKey(created);
      void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <>
      <VariantEditor
        project={project}
        variant={variant}
        template={template}
        justCreated={justCreated}
        document={source.data}
        apply={(change) => apply.mutateAsync(change)}
        describeError={errorMessage}
        onDirtyChange={setDirty}
        onCreated={(created) =>
          go(() =>
            navigate({
              to: "/p/$project/v/$variant",
              params: { project: slug, variant: created },
              search: { created: true },
            }),
          )
        }
        onRenamed={(renamed) =>
          go(() =>
            navigate({
              to: "/p/$project/v/$variant",
              params: { project: slug, variant: renamed },
              replace: true,
            }),
          )
        }
        onDeleted={() => go(() => navigate({ to: "/p/$project", params: { project: slug } }))}
        onDuplicate={(from) =>
          navigate({ to: "/p/$project/new", params: { project: slug }, search: { from } })
        }
        banner={project.state.can.edit ? undefined : <ManagedByFile project={project} />}
        privateAction={
          variant && project.state.can.keys
            ? ({ version, format }) => (
                <Button
                  variant="outline"
                  size="sm"
                  loading={createReaderKey.isPending}
                  onClick={() => {
                    setShown(`${variant.state.url}${representation(version, format)}`);
                    createReaderKey.mutate();
                  }}
                >
                  Create a key for this variant
                </Button>
              )
            : undefined
        }
      />

      <NewKeyDialog
        created={newKey}
        usage={{
          label: "To read the variant:",
          command: (key) => `curl -H "Authorization: Bearer ${key}" ${shown}`,
        }}
        onClose={() => setNewKey(undefined)}
      />

      <AlertDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Leave without {variant ? "publishing" : "creating"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {variant
                ? "Your changes to this variant have not been published. Leaving discards them."
                : "This variant has not been created yet. Leaving discards it."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => blocker.proceed?.()}>
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
