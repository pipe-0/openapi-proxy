import { Field, Notice, Section } from "@editor/components/page";
import { Segmented } from "@editor/components/segmented";
import { projectName, projectSlug } from "@editor/lib/project";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage, type NotificationScope, type Project, queries } from "@/lib/api";

const SCOPES: ReadonlyArray<{ value: NotificationScope; label: string }> = [
  { value: "off", label: "Nothing" },
  { value: "served", label: "What my variants serve" },
  { value: "all", label: "Everything" },
];

const SCOPE_HINTS: Record<NotificationScope, string> = {
  off: "You are not emailed when this project's documents change.",
  served:
    "You are emailed about new operations, and about changes and removals that touch something a variant serves.",
  all: "You are emailed about every operation that is added, changed or removed, served or not.",
};

/**
 * Which changes to this project's documents the person looking is emailed
 * about. A setting per project, and theirs alone: whether an API's changes
 * matter to someone depends on the API.
 */
export function ProjectNotifications({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const me = useQuery(queries.me);
  const slug = projectSlug(project);
  const key = ["project-notifications", slug];
  const own = useQuery({ queryKey: key, queryFn: () => api.projectNotifications(slug) });
  const save = useMutation({
    mutationFn: (scope: NotificationScope) => api.setProjectNotifications(slug, scope),
    onMutate: (scope) => queryClient.setQueryData(key, { scope }),
    onError: (error) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const scope = own.data?.scope ?? "served";

  return (
    <Section
      title="Email about changes"
      description={`When ${projectName(project)} adds, changes or removes operations, we can tell you. This setting is yours alone, and for this project.`}
    >
      {me.data?.emailConfigured === false ? (
        <Notice tone="neutral">
          This instance is not set up to send email, so nothing is sent. Changes still show up on
          each variant.
        </Notice>
      ) : (
        <Field hint={SCOPE_HINTS[scope]}>
          <Segmented
            aria-label="Email about changes"
            value={scope}
            onValueChange={(next) => save.mutate(next)}
            options={SCOPES}
          />
        </Field>
      )}
    </Section>
  );
}
