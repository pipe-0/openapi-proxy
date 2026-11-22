import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
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
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { type ApiToken, type CreatedToken, tokensApi, tokensQuery } from "@/lib/api-tokens";
import { formatRelativeTime } from "@/lib/utils";

/**
 * API tokens, on the Workspace page: what exists, making one (shown once),
 * revoking one, and where agents connect.
 */
export function ApiTokens({ owner }: { owner: boolean }) {
  const queryClient = useQueryClient();
  const tokens = useQuery(tokensQuery);
  const [created, setCreated] = useState<CreatedToken>();
  const refresh = () => queryClient.invalidateQueries({ queryKey: tokensQuery.queryKey });
  const endpoint = `${window.location.origin}/mcp`;

  return (
    <Section
      title="API tokens"
      description="For scripts and agents. A token acts as the person who made it, in this workspace, through the API and the MCP endpoint."
    >
      {tokens.data && tokens.data.length > 0 && (
        <ul className="flex flex-col">
          {tokens.data.map((token) => (
            <li key={token.id} className="flex min-h-12 items-center gap-3 border-b py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{token.name}</p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {token.prefix}…, made by {token.yours ? "you" : token.createdBy},{" "}
                  {token.lastUsedAt === null
                    ? "never used"
                    : `last used ${formatRelativeTime(token.lastUsedAt)}`}
                </p>
              </div>
              {(token.yours || owner) && <Revoke token={token} onDone={refresh} />}
            </li>
          ))}
        </ul>
      )}

      <Create
        onCreated={(token) => {
          setCreated(token);
          void refresh();
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

      <Dialog open={created !== undefined} onOpenChange={(open) => !open && setCreated(undefined)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your new token</DialogTitle>
            <DialogDescription>
              Copy it now and keep it somewhere safe. It will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            {/* The one literal on this page that is copied character for character. */}
            <code
              className="min-w-0 flex-1 rounded-lg border bg-subtle px-2.5 py-2 font-mono text-[12.5px] break-all"
              data-testid="new-token"
            >
              {created?.token}
            </code>
            <CopyButton
              value={created?.token ?? ""}
              what="Token copied"
              aria-label="Copy the token"
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function Create({ onCreated }: { onCreated: (token: CreatedToken) => void }) {
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => tokensApi.create(name.trim()),
    onSuccess: (token) => {
      setName("");
      onCreated(token);
    },
  });

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "" && !create.isPending) create.mutate();
      }}
    >
      <label htmlFor="token-name" className="text-[13px] leading-5 font-medium">
        New token
      </label>
      <div className="flex max-w-md gap-2">
        <Input
          id="token-name"
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
          Create token
        </Button>
      </div>
      {create.isError && (
        <p role="alert" className="text-[12.5px] leading-[18px] text-bad-foreground">
          {errorMessage(create.error)}
        </p>
      )}
    </form>
  );
}

function Revoke({ token, onDone }: { token: ApiToken; onDone: () => void }) {
  const revoke = useMutation({
    mutationFn: () => tokensApi.revoke(token.id),
    onSuccess: () => {
      onDone();
      toast.success(`Revoked ${token.name}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="sm" aria-label={`Revoke ${token.name}`} />}
      >
        Revoke
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke {token.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Anything still using this token stops working at once. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => revoke.mutate()}
            loading={revoke.isPending}
          >
            Revoke token
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
