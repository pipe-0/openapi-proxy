import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { Section } from "@/components/page";
import { Segmented } from "@/components/segmented";
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
import { errorMessage, type KeyAccess, queries } from "@/lib/api";
import { type ApiKey, type CreatedKey, keysApi, keysQuery } from "@/lib/api-keys";
import { formatRelativeTime } from "@/lib/utils";

/** Every variant of the workspace by id, as "Project / Variant", to say what a key reads. */
function useVariantNames(): Map<string, string> {
  const projects = useQuery(queries.projects);
  const variants = useQuery(queries.variants);
  const projectNames = new Map((projects.data ?? []).map((project) => [project.id, project.name]));
  return new Map(
    (variants.data ?? []).map((variant) => [
      variant.id,
      `${projectNames.get(variant.projectId) ?? "Project"} / ${variant.name}`,
    ]),
  );
}

/** What a key may do, in the words of the list. */
function accessOf(apiKey: ApiKey, variantNames: Map<string, string>): string {
  if (apiKey.access === "full") return "Full access";
  if (apiKey.variantId === null) return "Reads every private variant";
  return `Reads ${variantNames.get(apiKey.variantId) ?? "one private variant"}`;
}

/**
 * API keys, on the Workspace page: what exists and what each may do, making
 * one (shown once), revoking one, and where agents connect.
 */
export function ApiKeys({ owner }: { owner: boolean }) {
  const queryClient = useQueryClient();
  const keys = useQuery(keysQuery);
  const variantNames = useVariantNames();
  const [created, setCreated] = useState<CreatedKey>();
  const reload = () => queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
  const endpoint = `${window.location.origin}/mcp`;

  return (
    <Section
      title="API keys"
      description={
        <>
          For scripts, agents and the readers of private variants. A key acts as the person who made
          it, in this workspace, and is sent as{" "}
          <span className="font-medium text-foreground">Authorization: Bearer</span> followed by the
          key.
        </>
      }
    >
      {keys.data && keys.data.length > 0 && (
        <ul className="flex flex-col">
          {keys.data.map((apiKey) => (
            <li key={apiKey.id} className="flex min-h-12 items-center gap-3 border-b py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  <span className="font-medium">{apiKey.name}</span>
                  <span className="text-muted-foreground"> · {accessOf(apiKey, variantNames)}</span>
                </p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {apiKey.prefix}…, made by {apiKey.yours ? "you" : apiKey.createdBy},{" "}
                  {apiKey.lastUsedAt === null
                    ? "never used"
                    : `last used ${formatRelativeTime(apiKey.lastUsedAt)}`}
                </p>
              </div>
              {(apiKey.yours || owner) && <Revoke apiKey={apiKey} onDone={reload} />}
            </li>
          ))}
        </ul>
      )}

      <Create
        variantNames={variantNames}
        onCreated={(apiKey) => {
          setCreated(apiKey);
          void reload();
        }}
      />

      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] leading-5 text-muted-foreground">
        Agents connect to this workspace over MCP at
        <span className="text-foreground">{endpoint}</span>
        <CopyButton
          value={endpoint}
          what="MCP endpoint copied"
          variant="ghost"
          size="icon-xs"
          aria-label="Copy the MCP endpoint"
        />
        <a
          href="/docs/api-and-mcp"
          target="_blank"
          rel="noreferrer"
          className="font-medium whitespace-nowrap text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
        >
          How to connect
        </a>
      </p>

      <NewKeyDialog created={created} onClose={() => setCreated(undefined)} />
    </Section>
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
  /** A command that uses the key, to copy as a whole. */
  usage?: ((key: string) => string) | undefined;
  onClose: () => void;
}) {
  const command = created && usage ? usage(created.key) : undefined;
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
            <p className="text-[13px] leading-5 text-muted-foreground">To read the variant:</p>
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

const ACCESS_HINTS: Record<KeyAccess, string> = {
  full: "The API, the MCP endpoint and every private variant.",
  read: "Private variants, and nothing else.",
};

function Create({
  variantNames,
  onCreated,
}: {
  variantNames: Map<string, string>;
  onCreated: (apiKey: CreatedKey) => void;
}) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<KeyAccess>("full");
  // For a key that only reads: one variant, or "" for all of them.
  const [variantId, setVariantId] = useState("");
  const create = useMutation({
    mutationFn: () =>
      keysApi.create({
        name: name.trim(),
        access,
        ...(access === "read" ? { variantId: variantId === "" ? null : variantId } : {}),
      }),
    onSuccess: (apiKey) => {
      setName("");
      onCreated(apiKey);
    },
  });

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "" && !create.isPending) create.mutate();
      }}
    >
      <label htmlFor="key-name" className="text-[13px] leading-5 font-medium">
        New key
      </label>
      <div className="flex max-w-md gap-2">
        <Input
          id="key-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="What it is for, such as Deploy pipeline"
          maxLength={60}
          autoComplete="off"
          aria-invalid={create.isError}
        />
        <Button
          type="submit"
          variant="outline"
          loading={create.isPending}
          disabled={name.trim() === ""}
        >
          Create key
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented
          aria-label="What the key may do"
          value={access}
          onValueChange={setAccess}
          options={[
            { value: "full", label: "Full access" },
            { value: "read", label: "Read only" },
          ]}
        />
        {access === "read" && variantNames.size > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" aria-label="Which variants it reads" />}
            >
              <span className="max-w-56 truncate">
                {variantId === ""
                  ? "Every private variant"
                  : (variantNames.get(variantId) ?? "One variant")}
              </span>
              <ChevronDownIcon className="text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
              <DropdownMenuRadioGroup value={variantId} onValueChange={setVariantId}>
                <DropdownMenuRadioItem value="" closeOnClick>
                  Every private variant
                </DropdownMenuRadioItem>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Only one</DropdownMenuLabel>
                  {[...variantNames].map(([id, label]) => (
                    <DropdownMenuRadioItem key={id} value={id} closeOnClick>
                      <span className="truncate">{label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <span className="text-[12.5px] leading-[18px] text-muted-foreground">
          {ACCESS_HINTS[access]}
        </span>
      </div>
      {create.isError && (
        <p role="alert" className="text-[12.5px] leading-[18px] text-bad-foreground">
          {errorMessage(create.error)}
        </p>
      )}
    </form>
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
