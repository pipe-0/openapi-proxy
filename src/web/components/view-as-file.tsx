import { CopyButton } from "@editor/components/copy-button";
import { DocsLink } from "@editor/components/docs-link";
import { highlightLine } from "@editor/lib/highlight";
import { projectName } from "@editor/lib/project";
import { Button } from "@editor/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@editor/ui/dialog";
import { CLI_PACKAGE, definitionYaml, HOSTED_URL } from "@openapi-proxy/core";
import type { Project } from "@/lib/api";

const TOKEN_CLASS = {
  key: "text-foreground",
  string: "text-ok-foreground",
  number: "text-primary",
  punctuation: "text-faint",
  plain: "text-foreground",
} as const;

/** The text of the `openapi-proxy.yaml` that says what this project is. */
export function fileOf(project: Project): string {
  const here = new URL(project.state.urlPrefix).origin;
  const { version, project: slug, name, ...rest } = project.definition;
  return definitionYaml({
    version,
    project: slug,
    ...(name !== undefined ? { name } : {}),
    // A file that is deployed anywhere but the hosted service says where.
    ...(here === HOSTED_URL ? {} : { instance: here }),
    ...rest,
  });
}

/**
 * A project that was made in the app, shown as the file that would make it:
 * the way out of the app and into a repository, without rebuilding anything.
 * Deploying this file changes nothing about what is served; it changes where
 * the project is edited from then on.
 */
export function ViewAsFile({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const text = open ? fileOf(project) : "";
  const followed = project.definition.sources.some((source) => source.follow);
  const withCredentials = project.state.sources.some((source) => source.headerNames.length > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85svh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{projectName(project)} as a file</DialogTitle>
          <DialogDescription>
            Everything this project is, in the format of a definition file. Kept in your repository
            and deployed from there, it is the same project: the same URLs, the same variants.
          </DialogDescription>
        </DialogHeader>

        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-subtle">
          <CopyButton
            value={text}
            what="File copied"
            aria-label="Copy the file"
            variant="outline"
            size="icon-sm"
            className="absolute top-2 right-2"
          />
          <pre
            className="scroll-quiet h-full max-h-[42svh] overflow-auto p-3 pr-12 font-mono text-[12.5px] leading-[19px]"
            data-testid="definition-file"
          >
            {text.split("\n").map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place
              <div key={index}>
                {line.startsWith("#") ? (
                  <span className="text-faint">{line}</span>
                ) : (
                  highlightLine(line, "yaml").map(([kind, token], at) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: as above
                    <span key={at} className={TOKEN_CLASS[kind]}>
                      {token}
                    </span>
                  ))
                )}
                {"\n"}
              </div>
            ))}
          </pre>
        </div>

        <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[13px] leading-5 text-muted-foreground">
          <li>
            Save it as <span className="font-medium text-foreground">openapi-proxy.yaml</span> in
            your repository.
          </li>
          <li>
            <span className="font-medium text-foreground">npx {CLI_PACKAGE} deploy --dry-run</span>{" "}
            says what a deploy would change. For this file: nothing.
          </li>
          <li>
            Deploy it. From then on the project is changed by deploying the file, and is read-only
            here. <DocsLink slug="in-your-repository">The whole guide</DocsLink>
          </li>
        </ol>
        {(followed || withCredentials) && (
          <p className="text-[13px] leading-5 text-muted-foreground">
            {followed &&
              "The service keeps reading the sources that say follow: true, as it does now. "}
            {withCredentials &&
              "The request headers stored for a source are not part of a file. They stay with the project."}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
