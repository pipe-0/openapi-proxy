import { createFileRoute } from "@tanstack/react-router";
import { requireSession } from "@/lib/require-session";
import { InvitePage } from "@/pages/invite";

/** Accepting an invitation. Outside the app shell, but only for someone signed in. */
export const Route = createFileRoute("/_client/invite/$invitationId")({
  beforeLoad: requireSession,
  component: InvitePage,
});
