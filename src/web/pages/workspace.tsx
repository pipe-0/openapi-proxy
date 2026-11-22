import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ApiTokens } from "@/components/api-tokens";
import { CopyButton } from "@/components/copy-button";
import { Field, Notice, Page, PageHeader, Section, useTitle } from "@/components/page";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  api,
  errorMessage,
  type NotificationScope,
  queries,
  RequestError,
  type Workspace,
} from "@/lib/api";
import { GUARDS, PLAN_LIMITS } from "../../shared/plans";

const SCOPES: ReadonlyArray<{ value: NotificationScope; label: string }> = [
  { value: "off", label: "Nothing" },
  { value: "served", label: "What my variants serve" },
  { value: "all", label: "Everything" },
];

const SCOPE_HINTS: Record<NotificationScope, string> = {
  off: "You are not emailed when a source changes.",
  served:
    "You are emailed about new operations, and about changes and removals that touch something a variant serves.",
  all: "You are emailed about every operation that is added, changed or removed in a source, served or not.",
};

export function WorkspacePage() {
  useTitle("Workspace");
  const workspace = useQuery(queries.workspace);

  if (!workspace.data) {
    return (
      <Page className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-64" />
      </Page>
    );
  }
  return <Loaded workspace={workspace.data} />;
}

function Loaded({ workspace }: { workspace: Workspace }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queries.workspace.queryKey });
  const owner = workspace.role === "owner";

  return (
    <Page>
      <PageHeader
        title="Workspace"
        description="The people who share these projects. Everyone here can see and change all of them."
      />
      <div className="flex flex-col gap-14">
        <Section title="People">
          <ul className="flex flex-col">
            {workspace.members.map((member) => (
              <li key={member.id} className="flex min-h-12 items-center gap-3 border-b py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.name}
                    {member.you && (
                      <span className="font-normal text-muted-foreground"> (you)</span>
                    )}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground">{member.email}</p>
                </div>
                {member.role === "owner" ? (
                  <span className="text-[13px] text-muted-foreground">Owner</span>
                ) : (
                  (owner || member.you) && (
                    <RemoveMember member={member} leaving={member.you} onDone={refresh} />
                  )
                )}
              </li>
            ))}
            {workspace.invitations.map((invitation) => (
              <li key={invitation.id} className="flex min-h-12 items-center gap-2 border-b py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{invitation.email}</p>
                  <p className="truncate text-[13px] text-muted-foreground">
                    Invited by {invitation.invitedBy}, not joined yet
                  </p>
                </div>
                <CopyButton
                  value={invitation.link}
                  label="Copy link"
                  what="Invitation link copied"
                  variant="ghost"
                  size="sm"
                />
                <CancelInvitation id={invitation.id} onDone={refresh} />
              </li>
            ))}
          </ul>
          <Invite emailConfigured={workspace.emailConfigured} onDone={refresh} />
        </Section>

        <Notifications emailConfigured={workspace.emailConfigured} />

        <ApiTokens owner={owner} />

        {workspace.plansEnabled && <Plan workspace={workspace} />}

        <Rename workspace={workspace} onDone={refresh} />
      </div>
    </Page>
  );
}

function Invite({ emailConfigured, onDone }: { emailConfigured: boolean; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const invite = useMutation({
    mutationFn: () => api.invite(email.trim()),
    onSuccess: (invitation) => {
      setEmail("");
      onDone();
      toast.success(
        invitation.emailed
          ? `Invitation sent to ${invitation.email}`
          : `Invitation created for ${invitation.email}. Copy its link and send it to them.`,
      );
    },
  });

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (email.trim() !== "" && !invite.isPending) invite.mutate();
      }}
    >
      <label htmlFor="invite-email" className="text-[13px] leading-5 font-medium">
        Invite someone
      </label>
      <div className="flex max-w-md gap-2">
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@company.com"
          autoComplete="off"
          aria-invalid={invite.isError}
        />
        <Button
          type="submit"
          variant="outline"
          loading={invite.isPending}
          disabled={email.trim() === ""}
        >
          Invite
        </Button>
      </div>
      {invite.isError ? (
        <p role="alert" className="text-[12.5px] leading-[18px] text-bad-foreground">
          {errorMessage(invite.error)}
        </p>
      ) : (
        <p className="max-w-prose text-[12.5px] leading-[18px] text-muted-foreground">
          They join by signing in with this address.{" "}
          {emailConfigured
            ? "We email them the invitation."
            : "This instance does not send email, so you get a link to pass on."}
        </p>
      )}
    </form>
  );
}

function RemoveMember({
  member,
  leaving,
  onDone,
}: {
  member: Workspace["members"][number];
  leaving: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeMember(member.id),
    onSuccess: () => {
      if (leaving) {
        // Everything on screen belonged to the workspace that was just left.
        queryClient.clear();
        window.location.assign("/app");
        return;
      }
      onDone();
      toast.success(`${member.name} was removed`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={remove.isPending}
      onClick={() => {
        const question = leaving
          ? "Leave this workspace? You lose access to its projects."
          : `Remove ${member.name}? They lose access to these projects.`;
        if (window.confirm(question)) remove.mutate();
      }}
    >
      {leaving ? "Leave" : "Remove"}
    </Button>
  );
}

function CancelInvitation({ id, onDone }: { id: string; onDone: () => void }) {
  const cancel = useMutation({
    mutationFn: () => api.cancelInvitation(id),
    onSuccess: onDone,
    onError: (error) => toast.error(errorMessage(error)),
  });
  return (
    <Button variant="ghost" size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>
      Cancel
    </Button>
  );
}

function Notifications({ emailConfigured }: { emailConfigured: boolean }) {
  const queryClient = useQueryClient();
  const me = useQuery(queries.me);
  const save = useMutation({
    mutationFn: (scope: NotificationScope) => api.setNotifications(scope),
    onMutate: (scope) => {
      queryClient.setQueryData(queries.me.queryKey, (current) =>
        current ? { ...current, notifications: scope } : current,
      );
    },
    onError: (error) => {
      toast.error(errorMessage(error));
      void queryClient.invalidateQueries({ queryKey: queries.me.queryKey });
    },
  });
  const scope = me.data?.notifications ?? "served";

  return (
    <Section
      title="Email about changes"
      description="When a source adds, changes or removes operations, we can tell you. This setting is yours alone."
    >
      {emailConfigured ? (
        <Field hint={SCOPE_HINTS[scope]}>
          <Segmented
            aria-label="Email about changes"
            value={scope}
            onValueChange={(next) => save.mutate(next)}
            options={SCOPES}
          />
        </Field>
      ) : (
        <Notice tone="neutral">
          This instance is not set up to send email, so nothing is sent. Changes still show up on
          each variant.
        </Notice>
      )}
    </Section>
  );
}

function Plan({ workspace }: { workspace: Workspace }) {
  const { limits, usage } = workspace;
  const used = (count: number, limit: number | null, noun: string) =>
    limit === null ? `${count} ${noun}` : `${count} of ${limit} ${noun}`;

  return (
    <Section
      title={`${workspace.planName} plan`}
      description={`${used(usage.projects, limits.projects, "projects")} and ${used(usage.variants, limits.variants, "variants")} in use.`}
    >
      {workspace.plan === "free" && (
        <p className="max-w-prose text-[13px] leading-5 text-muted-foreground">
          Need more? Pro has {PLAN_LIMITS.pro.projects} projects, each with up to{" "}
          {GUARDS.variantsPerProject} variants.{" "}
          {workspace.contactEmail ? (
            <>
              Subscriptions are handled by email for now: write to{" "}
              <a
                className="font-medium text-foreground underline underline-offset-4"
                href={`mailto:${workspace.contactEmail}?subject=${encodeURIComponent(`openapi-proxy Pro for ${workspace.name}`)}`}
              >
                {workspace.contactEmail}
              </a>{" "}
              and you get a payment link from Stripe.
            </>
          ) : (
            "Ask whoever runs this instance."
          )}
        </p>
      )}
    </Section>
  );
}

function Rename({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const [name, setName] = useState(workspace.name);
  const save = useMutation({
    mutationFn: () => api.renameWorkspace(name.trim()),
    onSuccess: () => {
      onDone();
      toast.success("Name saved");
    },
  });
  const changed = name.trim() !== "" && name.trim() !== workspace.name;
  return (
    <Section title="Name" description="Shown to people you invite.">
      <Field
        htmlFor="workspace-name"
        error={save.error instanceof RequestError ? save.error.message : undefined}
      >
        <div className="flex max-w-md gap-2">
          <Input
            id="workspace-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
          />
          <Button
            variant="outline"
            disabled={!changed}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </div>
      </Field>
    </Section>
  );
}
