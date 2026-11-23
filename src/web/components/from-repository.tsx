import { CopyButton } from "@editor/components/copy-button";
import { DocsLink } from "@editor/components/docs-link";
import { Button } from "@editor/ui/button";
import { CLI_PACKAGE, DEPLOY_KEY_VARIABLE, HOSTED_URL } from "@openapi-proxy/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage, queries } from "@/lib/api";
import { type CreatedKey, keysApi, keysQuery } from "@/lib/api-keys";
import workflow from "../../../examples/in-your-repository/.github/workflows/openapi-proxy.yml?raw";

/** A command to run, with a button that copies it. */
function Command({ children, label }: { children: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-lg border bg-subtle px-2.5 py-2 font-mono text-[12.5px] whitespace-nowrap">
        {children}
      </code>
      <CopyButton value={children} what="Command copied" aria-label={label} />
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-[11.5px] font-medium tabular-nums"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm leading-5 font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** What to hand a coding agent so that it sets the repository up, with where to read more. */
function agentPrompt(instance: string | undefined): string {
  return [
    "Set up openapi-proxy in this repository.",
    "",
    "1. Find the OpenAPI document this project produces, where a pipeline can read it: a file its build writes, or an address that is reachable from CI. A dev server's address is for local work only (`dev --source`).",
    `2. Run \`npx ${CLI_PACKAGE} init <that file or URL>\`. It writes openapi-proxy.yaml.`,
    ...(instance
      ? [
          `   Add the line \`instance: ${instance}\` to the file: it is deployed to a self-hosted instance.`,
        ]
      : []),
    `3. Edit the file: one variant per audience, each with include and exclude. \`npx ${CLI_PACKAGE} operations\` lists the tags and operations to name, and \`npx ${CLI_PACKAGE} validate\` checks the file. Every key is described in ${HOSTED_URL}/docs/configuration.md`,
    `4. Add a CI job that runs \`npx ${CLI_PACKAGE} validate\` on pull requests and \`npx ${CLI_PACKAGE} deploy\` on the default branch, with the secret ${DEPLOY_KEY_VARIABLE} in its environment. I create that key myself and add it to the CI.`,
    "",
    `The whole guide: ${HOSTED_URL}/docs/in-your-repository.md`,
  ].join("\n");
}

/**
 * The other way to make a project: a definition file in a repository, served
 * on localhost while developing and deployed from CI. Nothing is made here.
 * The screen says what to run where, and makes the one thing only this app
 * can make: the key the pipeline deploys with.
 */
export function FromRepository() {
  const queryClient = useQueryClient();
  const me = useQuery(queries.me);
  const owner = me.data?.role === "owner";
  const here = me.data ? new URL(me.data.urlPrefix).origin : HOSTED_URL;
  const instance = here === HOSTED_URL ? undefined : here;
  const [key, setKey] = useState<CreatedKey>();
  const [showWorkflow, setShowWorkflow] = useState(false);
  const create = useMutation({
    mutationFn: () => keysApi.create({ name: "Deploy from CI", access: "deploy" }),
    onSuccess: (created) => {
      setKey(created);
      void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="flex flex-col gap-6">
      <ol className="flex flex-col gap-6">
        <Step number={1} title="In your repository, write a definition file for your document">
          <Command label="Copy the init command">{`npx ${CLI_PACKAGE} init ./openapi.json`}</Command>
          <p className="text-[13px] leading-5 text-muted-foreground">
            A file, or the URL your dev server serves it at. It writes{" "}
            <span className="text-foreground">openapi-proxy.yaml</span>
            {instance ? (
              <>
                . Add the line <span className="text-foreground">instance: {instance}</span> to it,
                so that it is deployed here.
              </>
            ) : (
              "."
            )}
          </p>
        </Step>
        <Step number={2} title="Serve your variants on localhost, and pick what each one serves">
          <Command label="Copy the dev command">{`npx ${CLI_PACKAGE} dev`}</Command>
          <p className="text-[13px] leading-5 text-muted-foreground">
            It prints an address. Open it to pick operations in the same editor as here: saving
            writes to the file. Your variants are served there too, at the same paths as on the
            service.
          </p>
        </Step>
        <Step number={3} title="Deploy it, from your machine or from CI">
          <Command label="Copy the deploy command">
            {`${DEPLOY_KEY_VARIABLE}=${key?.key ?? "oap_..."} npx ${CLI_PACKAGE} deploy`}
          </Command>
          {key ? (
            <p className="text-[13px] leading-5 text-muted-foreground" data-testid="new-deploy-key">
              <span className="font-medium text-foreground">
                This is the only time the key is shown.
              </span>{" "}
              Store it in your pipeline as a secret named {DEPLOY_KEY_VARIABLE}. It is listed under
              Workspace, where it can be revoked.
            </p>
          ) : owner ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button variant="outline" onClick={() => create.mutate()} loading={create.isPending}>
                Create a deploy API key
              </Button>
              <span className="text-[13px] leading-5 text-muted-foreground">
                It deploys to this workspace, and does nothing else.
              </span>
            </div>
          ) : (
            <p className="text-[13px] leading-5 text-muted-foreground">
              A deploy needs a deploy API key. The owner of this workspace creates one under
              Workspace.
            </p>
          )}
          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowWorkflow((shown) => !shown)}>
              {showWorkflow ? "Hide the workflow" : "A workflow for GitHub Actions"}
            </Button>
          </div>
          {showWorkflow && (
            <div className="relative rounded-lg border bg-subtle">
              <CopyButton
                value={workflow}
                what="Workflow copied"
                aria-label="Copy the workflow"
                variant="outline"
                size="icon-sm"
                className="absolute top-2 right-2"
              />
              <pre className="scroll-quiet max-h-72 overflow-auto p-3 pr-12 font-mono text-[12.5px] leading-[19px]">
                {workflow}
              </pre>
            </div>
          )}
        </Step>
      </ol>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-4">
        <CopyButton
          value={agentPrompt(instance)}
          what="Prompt copied"
          label="Copy a prompt for your coding agent"
        />
        <span className="text-[13px] leading-5 text-muted-foreground">
          It does steps 1 and 2 and writes the CI job.{" "}
          <DocsLink slug="in-your-repository">The guide</DocsLink>
        </span>
      </div>
    </div>
  );
}
