import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ApiKeys } from "@/components/api-keys";
import { CopyButton } from "@/components/copy-button";
import { Field, Notice, Page, PageHeader, Section, useTitle } from "@/components/page";
import { Segmented } from "@/components/segmented";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { VISIBILITY } from "@/components/visibility";
import {
  api,
  errorMessage,
  queries,
  RequestError,
  type Visibility,
  type Workspace,
} from "@/lib/api";
import { cn, formatBytes, plural } from "@/lib/utils";
import { PLAN_LIMITS, PLAN_PRICES } from "../../shared/plans";

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

        {workspace.plansEnabled && <Billing workspace={workspace} onDone={refresh} />}

        <NewVariants workspace={workspace} onDone={refresh} />

        <ApiKeys owner={owner} />

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
        // A key acts as the person who made it, so it goes with them: said
        // here, because a docs build or a partner may be reading with one.
        const question = leaving
          ? "Leave this workspace? You lose access to its projects, and the API keys you made here stop working."
          : `Remove ${member.name}? They lose access to these projects, and the API keys they made stop working.`;
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

/**
 * The plan, how much of it is in use, and the one thing there is to ask for:
 * Pro, or the end of it. Asking is an email to the people who run the
 * service; they answer by email.
 */
function Billing({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const { limits, usage, plan, subscription, upgradeRequestedAt } = workspace;
  const want = subscription ? "cancel" : "upgrade";
  const owner = workspace.role === "owner";
  const you = workspace.members.find((member) => member.you);
  const label = want === "upgrade" ? "Request upgrade to Pro" : "Request cancellation";
  const ask = useMutation({
    mutationFn: () => api.requestPlan(want),
    onSuccess: () => {
      onDone();
      toast.success(want === "upgrade" ? "Upgrade requested" : "Cancellation requested");
    },
  });

  return (
    <Section
      title="Billing"
      description={
        plan === "free" ? (
          <>
            Pro has {PLAN_LIMITS.pro.projects} projects and no limit on variants, for{" "}
            {PLAN_PRICES.pro.amount} {PLAN_PRICES.pro.per}.{" "}
            <a
              className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-current"
              href="/pricing"
              target="_blank"
              rel="noreferrer"
            >
              Compare plans
            </a>
          </>
        ) : (
          "What this workspace pays for, and how much of it is in use."
        )
      }
    >
      <dl className="grid max-w-md grid-cols-[8rem_1fr] gap-y-2.5 text-[13px]">
        <dt className="text-muted-foreground">Plan</dt>
        <dd>
          <span className="font-medium">{workspace.planName}</span>
          {subscription?.periodEnd && (
            <span className="text-muted-foreground">
              , {subscription.cancelAtPeriodEnd ? "ends" : "renews"} on{" "}
              {formatDate(subscription.periodEnd, true)}
            </span>
          )}
        </dd>
        <Usage label="Projects" used={usage.projects} limit={limits.projects} />
        <Usage label="Variants" used={usage.variants} limit={limits.variants} />
        {/* The limit is on one project's documents together, so the largest is the one that counts. */}
        <Usage
          label={usage.projects > 1 ? "Largest project" : "Project size"}
          used={usage.projectBytes}
          limit={limits.projectBytes}
          format={formatBytes}
        />
      </dl>

      {subscription?.status === "past_due" && (
        <Notice tone="warn">
          The last payment did not go through. Pro stays on while that is sorted out.
        </Notice>
      )}

      {upgradeRequestedAt ? (
        <Notice tone="neutral">
          You asked for Pro on {formatDate(upgradeRequestedAt)}. We will write to{" "}
          {you?.email ?? "you"} with a payment link.
        </Notice>
      ) : subscription?.cancelAtPeriodEnd ? (
        <Notice tone="neutral">
          {subscription.canceledAt
            ? `You asked to cancel on ${formatDate(subscription.canceledAt)}. `
            : "Cancellation was asked for. "}
          {subscription.periodEnd
            ? `Pro stays until ${formatDate(subscription.periodEnd, true)}, and is not renewed.`
            : "We will confirm by email."}
        </Notice>
      ) : !owner ? (
        <p className="text-[13px] text-muted-foreground">
          Only the owner of the workspace can change its plan.
        </p>
      ) : workspace.planRequests || workspace.contactEmail ? (
        <div className="flex flex-col gap-2">
          <div>
            {workspace.planRequests ? (
              <Button
                variant="outline"
                loading={ask.isPending}
                onClick={() => {
                  if (
                    want === "upgrade" ||
                    window.confirm(
                      "Ask to cancel Pro? We confirm by email before anything changes.",
                    )
                  ) {
                    ask.mutate();
                  }
                }}
              >
                {label}
              </Button>
            ) : (
              // This instance sends no email of its own: the request is a letter from the owner.
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={`mailto:${workspace.contactEmail}?subject=${encodeURIComponent(
                      `${label}: ${workspace.name}`,
                    )}&body=${encodeURIComponent(
                      `Workspace: ${workspace.name} (${workspace.id})\nFrom: ${you?.email ?? ""}\n`,
                    )}`}
                  />
                }
              >
                {label}
              </Button>
            )}
          </div>
          {ask.isError ? (
            <p role="alert" className="text-[12.5px] leading-[18px] text-bad-foreground">
              {errorMessage(ask.error)}
            </p>
          ) : (
            <p className="text-[12.5px] leading-[18px] text-muted-foreground">
              {!workspace.planRequests
                ? `Opens an email to ${workspace.contactEmail}.`
                : want === "upgrade"
                  ? `We email a payment link to ${you?.email ?? "you"}.`
                  : "We confirm by email. Nothing changes before that."}
            </p>
          )}
        </div>
      ) : (
        <p className="text-[13px] leading-5 text-muted-foreground">
          To change the plan, ask whoever runs this instance.
        </p>
      )}
    </Section>
  );
}

/** One line of what a plan allows: how much is used, and of how much. */
function Usage({
  label,
  used,
  limit,
  format = String,
}: {
  label: string;
  used: number;
  limit: number | null;
  /** How the two numbers are written, such as a size in MB. */
  format?: (value: number) => string;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        {limit === null ? (
          `${format(used)}, no limit`
        ) : (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="tabular-nums">
              {format(used)} of {format(limit)}
            </span>
            <span
              role="img"
              aria-label={`${format(used)} of ${format(limit)} used`}
              className="h-1.5 w-28 overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn(
                  "block h-full rounded-full",
                  used >= limit ? "bg-warn-foreground" : "bg-foreground/60",
                )}
                style={{ width: `${Math.min(100, (used / Math.max(limit, 1)) * 100)}%` }}
              />
            </span>
          </span>
        )}
      </dd>
    </>
  );
}

const formatDate = (epochMs: number, withYear = false) =>
  new Date(epochMs).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    ...(withYear ? { year: "numeric" } : {}),
  });

/**
 * Who may read a variant when neither it nor its project says. Variants
 * follow this as it changes, so a team that works on internal APIs sets it
 * once and nothing it makes is public by accident.
 */
function NewVariants({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const queryClient = useQueryClient();
  const projects = useQuery(queries.projects);
  // The variants that say nothing themselves, in projects that say nothing either.
  const following = (projects.data ?? [])
    .flatMap((project) => Object.values(project.state.variants))
    .filter((variant) => variant.visibility.from === "workspace").length;
  const save = useMutation({
    mutationFn: (next: Visibility) => api.setDefaultVisibility(next),
    onSuccess: (_, next) => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: queries.me.queryKey });
      void queryClient.invalidateQueries({ queryKey: queries.projects.queryKey });
      if (following > 0) {
        toast.success(
          `${plural(following, "variant")} ${following === 1 ? "is" : "are"} ${next} now`,
        );
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const value = save.isPending && save.variables ? save.variables : workspace.defaultVisibility;
  const pick = (next: Visibility) => {
    if (next === value) return;
    const sure =
      next === "private" ||
      following === 0 ||
      window.confirm(
        `Make ${plural(following, "variant")} public? Anyone with ${following === 1 ? "its URL" : "their URLs"} will be able to read ${following === 1 ? "it" : "them"}.`,
      );
    if (sure) save.mutate(next);
  };
  return (
    <Section
      title="Default visibility"
      description="Who can read a variant when neither it nor its project says. A project can say for its variants, and a variant for itself."
    >
      <Field
        hint={
          <>
            {value === "private"
              ? "Such a variant is read with a user API key of this workspace."
              : "Such a variant can be read by anyone with its URL."}{" "}
            {following === 0
              ? "No variant follows this at the moment."
              : `${plural(following, "variant")} ${following === 1 ? "follows" : "follow"} this, and ${following === 1 ? "changes" : "change"} with it at once.`}
          </>
        }
      >
        <Segmented
          aria-label="Variants are"
          value={value}
          onValueChange={pick}
          options={[
            { value: "public", label: VISIBILITY.public.label },
            { value: "private", label: VISIBILITY.private.label },
          ]}
        />
      </Field>
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
