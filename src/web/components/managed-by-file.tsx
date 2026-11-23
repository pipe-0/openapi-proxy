import { Notice } from "@editor/components/page";
import { formatRelativeTime } from "@editor/lib/utils";
import { Button } from "@editor/ui/button";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage, type Project } from "@/lib/api";
import { useApply } from "@/lib/use-apply";

/** Where a deploy ran, in a few words: the commit, and the branch or tag it was on. */
function originOf(project: Project): string | undefined {
  const origin = project.state.applied?.origin;
  if (!origin?.commit) return undefined;
  const ref = origin.ref?.replace(/^refs\/(heads|tags)\//, "");
  return `commit ${origin.commit.slice(0, 7)}${ref ? ` on ${ref}` : ""}`;
}

/**
 * Shown on a project that is deployed from a definition file: what defines
 * it, when it was last deployed and by what, why nothing here can be changed,
 * and the one way to change that.
 */
export function ManagedByFile({ project }: { project: Project }) {
  const apply = useApply(project);
  const takeBack = useMutation({
    mutationFn: () =>
      apply.mutateAsync({ change: (definition) => definition, more: { editInApp: true } }),
    onSuccess: () => toast.success("This project is edited in the app now"),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const { applied } = project.state;
  const origin = originOf(project);
  const runUrl = applied?.origin?.runUrl;

  return (
    <Notice
      tone="neutral"
      action={
        <Button variant="outline" onClick={() => takeBack.mutate()} loading={takeBack.isPending}>
          Edit in the app instead
        </Button>
      }
    >
      <p>
        <span className="font-medium">This project is deployed from a file.</span> To change it,
        change its openapi-proxy.yaml and deploy. Nothing is edited here, so the file and the
        project cannot drift apart.
      </p>
      {applied && (
        <p className="mt-1 text-muted-foreground">
          Last deployed {formatRelativeTime(applied.at)}
          {applied.by.kind === "key" ? ` with the deploy API key ${applied.by.name}` : ""}
          {origin ? `, from ${origin}` : ""}.
          {runUrl && /^https:\/\//.test(runUrl) && (
            <>
              {" "}
              <a
                href={runUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                See the run
              </a>
            </>
          )}
        </p>
      )}
    </Notice>
  );
}
