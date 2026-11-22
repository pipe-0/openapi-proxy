import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Mark } from "@/components/brand";
import { useTitle } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage, queries, RequestError } from "@/lib/api";

/**
 * Where an invitation link leads. The person is signed in by the time this
 * renders (the route requires it and brings them back here afterwards).
 */
export function InvitePage() {
  useTitle("Invitation");
  const { invitationId } = useParams({ from: "/_client/invite/$invitationId" });
  const queryClient = useQueryClient();
  const invitation = useQuery(queries.invitation(invitationId));

  const accept = useMutation({
    mutationFn: () => api.acceptInvitation(invitationId),
    onSuccess: () => {
      // A different workspace now: nothing cached still applies.
      queryClient.clear();
      window.location.assign("/app");
    },
  });
  const switchAccount = useMutation({
    mutationFn: () => api.signOut(),
    onSettled: () => {
      queryClient.clear();
      window.location.assign(`/login?from=${encodeURIComponent(`/invite/${invitationId}`)}`);
    },
  });

  const data = invitation.data;
  const missing = invitation.error instanceof RequestError && invitation.error.status === 404;

  return (
    <main className="flex min-h-svh items-center justify-center bg-subtle p-6">
      <div className="w-full max-w-sm rounded-xl border bg-background p-7 shadow-sm">
        <Mark className="size-9" />
        {!data && !invitation.error && <Skeleton className="mt-6 h-24" />}

        {(missing || data?.state === "expired") && (
          <Message title="This invitation is no longer valid">
            It was cancelled or has expired. Ask for a new one.
          </Message>
        )}

        {data?.state === "already-member" && (
          <>
            <Message title={`You are in ${data.workspace}`}>Nothing left to do.</Message>
            <Button className="mt-5 w-full" onClick={() => window.location.assign("/app")}>
              Open it
            </Button>
          </>
        )}

        {data?.state === "ready" && (
          <>
            <Message title={`Join ${data.workspace}?`}>
              {data.invitedBy} invited you to work on their OpenAPI variants with them. You will see
              and be able to change everything in this workspace.
            </Message>
            {accept.isError && (
              <p role="alert" className="mt-3 text-[13px] text-bad-foreground">
                {errorMessage(accept.error)}
              </p>
            )}
            <Button
              className="mt-5 w-full"
              loading={accept.isPending}
              onClick={() => accept.mutate()}
            >
              Join workspace
            </Button>
          </>
        )}

        {data?.state === "wrong-account" && (
          <>
            <Message title="This invitation is for someone else">{data.reason}</Message>
            <Button
              variant="outline"
              className="mt-5 w-full"
              loading={switchAccount.isPending}
              onClick={() => switchAccount.mutate()}
            >
              Sign in with another account
            </Button>
          </>
        )}

        {data?.state === "blocked" && (
          <>
            <Message title={`You cannot join ${data.workspace} yet`}>{data.reason}</Message>
            <Button
              variant="outline"
              className="mt-5 w-full"
              onClick={() => window.location.assign("/app")}
            >
              Open my workspace
            </Button>
          </>
        )}
      </div>
    </main>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h1 className="type-heading">{title}</h1>
      <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{children}</p>
    </div>
  );
}
