import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { DocsLink } from "@/components/docs-link";
import { Section } from "@/components/page";
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
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { errorMessage, queries } from "@/lib/api";
import { type ApiKey, type CreatedKey, type KeyVariant, keysApi, keysQuery } from "@/lib/api-keys";
import { projectName, projectSlug, variantsOf } from "@/lib/project";
import { formatRelativeTime } from "@/lib/utils";

const scopeKey = (scope: KeyVariant) => `${scope.project}/${scope.variant}`;

/** Every variant of the workspace, as "Project / Variant", to say what a user API key reads. */
function useVariantNames(): Map<string, { scope: KeyVariant; label: string }> {
  const projects = useQuery(queries.projects);
  return new Map(
    (projects.data ?? []).flatMap((project) =>
      variantsOf(project).map((variant) => {
        const scope = { project: projectSlug(project), variant: variant.slug };
        return [scopeKey(scope), { scope, label: `${projectName(project)} / ${variant.name}` }];
      }),
    ),
  );
}

/**
 * The workspace's API keys, of both kinds, each with what it is for: a deploy
 * API key lets a pipeline deploy a definition file, a user API key lets
 * someone read private variants. What exists, making one (shown once), and
 * revoking one.
 */
export function ApiKeys({ owner }: { owner: boolean }) {
  const queryClient = useQueryClient();
  const keys = useQuery(keysQuery);
  const variantNames = useVariantNames();
  const [created, setCreated] = useState<CreatedKey>();
  const reload = () => queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
  const made = (apiKey: CreatedKey) => {
    setCreated(apiKey);
    void reload();
  };
  const deploy = (keys.data ?? []).filter((apiKey) => apiKey.access === "deploy");
  const read = (keys.data ?? []).filter((apiKey) => apiKey.access === "read");

  return (
    <>
      <Section
        title="Deploy API keys"
        description={
          <>
            For a pipeline that deploys a definition file with{" "}
            <span className="font-medium text-foreground">openapi-proxy deploy</span>. A deploy API
            key belongs to the workspace: it deploys to its projects, does nothing else, and keeps
            working when whoever made it leaves. The owner makes and revokes them.{" "}
            <DocsLink slug="in-your-repository">Deploying from a repository</DocsLink>
          </>
        }
      >
        <KeyList keys={deploy} mayRevoke={() => owner} onDone={reload}>
          {() => "Deploys definition files"}
        </KeyList>
        {owner ? (
          <CreateDeployKey onCreated={made} />
        ) : (
          <p className="text-[13px] leading-5 text-muted-foreground">
            Ask the owner of this workspace for one.
          </p>
        )}
      </Section>

      <Section
        title="User API keys"
        description={
          <>
            For someone, or something, that reads private variants. A user API key reads them and
            does nothing else. It acts for the person who made it, and stops working when they leave
            the workspace. It is sent as{" "}
            <span className="font-medium text-foreground">Authorization: Bearer</span> followed by
            the key. <DocsLink slug="private-variants">Private variants and keys</DocsLink>
          </>
        }
      >
        <KeyList keys={read} mayRevoke={(apiKey) => apiKey.yours || owner} onDone={reload}>
          {(apiKey) =>
            apiKey.variant === null
              ? "Reads every private variant"
              : `Reads ${variantNames.get(scopeKey(apiKey.variant))?.label ?? "one private variant"}`
          }
        </KeyList>
        <CreateUserKey variantNames={variantNames} onCreated={made} />
      </Section>

      <NewKeyDialog
        created={created}
        usage={
          created?.access === "deploy"
            ? {
                label:
                  "Store it as a secret of the pipeline named OPENAPI_PROXY_API_KEY. To try it here:",
                command: (key) =>
                  `OPENAPI_PROXY_API_KEY=${key} npx @pipe0/openapi-proxy deploy --dry-run`,
              }
            : undefined
        }
        onClose={() => setCreated(undefined)}
      />
    </>
  );
}

function KeyList({
  keys,
  mayRevoke,
  onDone,
  children,
}: {
  keys: ApiKey[];
  mayRevoke: (apiKey: ApiKey) => boolean;
  onDone: () => void;
  /** What a key does, in the words of the list. */
  children: (apiKey: ApiKey) => string;
}) {
  if (keys.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {keys.map((apiKey) => (
        <li key={apiKey.id} className="flex min-h-12 items-center gap-3 border-b py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">
              <span className="font-medium">{apiKey.name}</span>
              <span className="text-muted-foreground"> · {children(apiKey)}</span>
            </p>
            <p className="truncate text-[13px] text-muted-foreground">
              {apiKey.prefix}…, made by{" "}
              {apiKey.yours ? "you" : (apiKey.createdBy ?? "someone who has left")},{" "}
              {apiKey.lastUsedAt === null
                ? "never used"
                : `last used ${formatRelativeTime(apiKey.lastUsedAt)}`}
            </p>
          </div>
          {mayRevoke(apiKey) && <Revoke apiKey={apiKey} onDone={onDone} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * A key that was just made, shown the one time it can be: here, and where a
 * private variant makes a key for itself.
 */
export function NewKeyDialog({
  created,
  usage,
  onClose,
}: {
  created: CreatedKey | undefined;
  /** A command that uses the key, to copy as a whole, and a line that says what it is for. */
  usage?: { label: string; command: (key: string) => string } | undefined;
  onClose: () => void;
}) {
  const command = created && usage ? usage.command(created.key) : undefined;
  return (
    <Dialog open={created !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Your new API key</DialogTitle>
          <DialogDescription>
            Copy it now and keep it somewhere safe. It will not be shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          {/* The one literal on this page that is copied character for character. */}
          <code
            className="min-w-0 flex-1 rounded-lg border bg-subtle px-2.5 py-2 font-mono text-[12.5px] break-all"
            data-testid="new-key"
          >
            {created?.key}
          </code>
          <CopyButton value={created?.key ?? ""} what="Key copied" aria-label="Copy the key" />
        </div>
        {command && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[13px] leading-5 text-muted-foreground">{usage?.label}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 rounded-lg border bg-subtle px-2.5 py-2 font-mono text-[12.5px] break-all">
                {command}
              </code>
              <CopyButton value={command} what="Command copied" aria-label="Copy the command" />
            </div>
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A name and a button: the form both kinds of key are made with. */
function CreateForm({
  id,
  label,
  placeholder,
  button,
  create,
  children,
}: {
  id: string;
  label: string;
  placeholder: string;
  button: string;
  create: (name: string) => Promise<unknown>;
  /** What else there is to choose, under the name. */
  children?: React.ReactNode;
}) {
  const [name, setName] = useState("");
  const submit = useMutation({
    mutationFn: () => create(name.trim()),
    onSuccess: () => setName(""),
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "" && !submit.isPending) submit.mutate();
      }}
    >
      <label htmlFor={id} className="text-[13px] leading-5 font-medium">
        {label}
      </label>
      <div className="flex max-w-md gap-2">
        <Input
          id={id}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={placeholder}
          maxLength={60}
          autoComplete="off"
          aria-invalid={submit.isError}
        />
        <Button
          type="submit"
          variant="outline"
          loading={submit.isPending}
          disabled={name.trim() === ""}
        >
          {button}
        </Button>
      </div>
      {children}
      {submit.isError && (
        <p role="alert" className="text-[12.5px] leading-[18px] text-bad-foreground">
          {errorMessage(submit.error)}
        </p>
      )}
    </form>
  );
}

function CreateDeployKey({ onCreated }: { onCreated: (apiKey: CreatedKey) => void }) {
  return (
    <CreateForm
      id="deploy-key-name"
      label="New deploy API key"
      placeholder="Where it is used, such as GitHub Actions"
      button="Create deploy API key"
      create={async (name) => onCreated(await keysApi.create({ name, access: "deploy" }))}
    />
  );
}

function CreateUserKey({
  variantNames,
  onCreated,
}: {
  variantNames: Map<string, { scope: KeyVariant; label: string }>;
  onCreated: (apiKey: CreatedKey) => void;
}) {
  // One variant, or "" for every private one.
  const [chosen, setChosen] = useState("");
  const scope = variantNames.get(chosen);
  return (
    <CreateForm
      id="user-key-name"
      label="New user API key"
      placeholder="Who reads with it, such as Docs build"
      button="Create user API key"
      create={async (name) =>
        onCreated(await keysApi.create({ name, access: "read", variant: scope?.scope ?? null }))
      }
    >
      {variantNames.size > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" aria-label="Which variants it reads" />}
            >
              <span className="max-w-56 truncate">{scope?.label ?? "Every private variant"}</span>
              <ChevronDownIcon className="text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
              <DropdownMenuRadioGroup value={chosen} onValueChange={setChosen}>
                <DropdownMenuRadioItem value="" closeOnClick>
                  Every private variant
                </DropdownMenuRadioItem>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Only one</DropdownMenuLabel>
                  {[...variantNames].map(([key, { label }]) => (
                    <DropdownMenuRadioItem key={key} value={key} closeOnClick>
                      <span className="truncate">{label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="text-[12.5px] leading-[18px] text-muted-foreground">
            {scope ? "It reads this variant, and no other." : "It reads all of them."}
          </span>
        </div>
      )}
    </CreateForm>
  );
}

function Revoke({ apiKey, onDone }: { apiKey: ApiKey; onDone: () => void }) {
  const revoke = useMutation({
    mutationFn: () => keysApi.revoke(apiKey.id),
    onSuccess: () => {
      onDone();
      toast.success(`Revoked ${apiKey.name}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="sm" aria-label={`Revoke ${apiKey.name}`} />}
      >
        Revoke
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {apiKey.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything still using this key stops working at once. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => revoke.mutate()}
            loading={revoke.isPending}
          >
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
