import { and, count, eq, gt, lte, max, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { isVisibility, type Visibility } from "../../shared/access";
import { GUARDS, PLAN_NAMES } from "../../shared/plans";
import { createDb, type Db } from "../db/client";
import {
  apiKeys,
  invitation,
  member,
  organization,
  projects,
  session,
  subscriptions,
  user,
  variants,
} from "../db/schema";
import { appUrl, emailConfigured, sendEmail } from "../email";
import type { AppContext } from "../env";
import { ApiError, badRequest, forbidden, notFound, readJson } from "../errors";
import { newId, randomToken } from "../id";
import { positionOf } from "../limits";
import {
  giveProStatement,
  inForce,
  limitsToApi,
  planOf,
  removePlanStatement,
  sellsPlans,
} from "../plans";

/**
 * The workspace: the people who share the projects. One per person. Whoever
 * created it is its owner and can remove people; everyone in it can invite.
 */
export const workspaceRoutes = new Hono<AppContext>();
/** Looking at, and accepting, an invitation. Open to any signed-in person who has the link. */
export const invitationRoutes = new Hono<AppContext>();

const INVITATION_DAYS = 7;
const INVITATION_MS = INVITATION_DAYS * 24 * 60 * 60 * 1000;
/**
 * Guards against a workspace being used to send mail to strangers, not a
 * pricing plan: a cap on open invitations, a cap on new ones per day, and a
 * pause before the same invitation is emailed again.
 */
const MAX_PENDING_INVITATIONS = 20;
const MAX_INVITATIONS_PER_DAY = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RESEND_PAUSE_MS = 5 * 60_000;
const MAX_MEMBERS = GUARDS.people;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inviteLink(c: { env: AppContext["Bindings"]; req: { url: string } }, id: string): string {
  return `${appUrl(c.env, new URL(c.req.url).origin)}/invite/${id}`;
}

const pendingInvitations = (db: Db, organizationId: string) =>
  db
    .select({
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      invitedBy: user.name,
    })
    .from(invitation)
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(invitation.createdAt);

workspaceRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = c.var.organizationId;

  const [workspace, members, invitations, usage, plan, request] = await Promise.all([
    db
      .select({
        id: organization.id,
        name: organization.name,
        /** Whether a new variant starts public or private. */
        defaultVisibility: organization.defaultVisibility,
      })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .get(),
    db
      .select({
        id: member.id,
        userId: member.userId,
        role: member.role,
        joinedAt: member.createdAt,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, organizationId))
      .orderBy(member.createdAt),
    pendingInvitations(db, organizationId),
    usageOf(db, organizationId),
    planOf(db, c.env, organizationId),
    openRequest(db, organizationId),
  ]);
  if (!workspace) throw notFound("Workspace");
  const { subscription } = plan;

  return c.json({
    ...workspace,
    role: c.var.role,
    plan: plan.plan,
    planName: PLAN_NAMES[plan.plan],
    /** False on an instance that sells no plans: there is nothing to show about them. */
    plansEnabled: sellsPlans(c.env),
    limits: { ...limitsToApi(plan.limits), projectBytes: GUARDS.projectBytes },
    usage,
    /** What the plan comes from: when it renews, or that it is ending. Null on Free. */
    subscription: subscription
      ? {
          status: subscription.status,
          periodEnd: subscription.periodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          canceledAt: subscription.canceledAt,
        }
      : null,
    /** When Pro was asked for, while that is still open. */
    upgradeRequestedAt: subscription ? null : (request?.createdAt ?? null),
    /** Whether a request can reach the people who run this: it is an email to them. */
    planRequests: emailConfigured(c.env) && sellsPlans(c.env),
    members: members.map(({ userId, joinedAt, role, ...rest }) => ({
      ...rest,
      role: role === "owner" ? "owner" : "member",
      joinedAt: joinedAt.getTime(),
      you: userId === c.var.user.id,
    })),
    invitations: invitations.map((pending) => ({
      ...pending,
      expiresAt: pending.expiresAt.getTime(),
      link: inviteLink(c, pending.id),
    })),
    /** Whether this instance can send email at all. Without it, an invitation is a link to pass on. */
    emailConfigured: emailConfigured(c.env),
    contactEmail: c.env.CONTACT_EMAIL || null,
  });
});

/** How much of its plan a workspace uses. */
async function usageOf(db: Db, organizationId: string) {
  const [projectCount, variantCount] = await Promise.all([
    db
      .select({ n: count(), largest: max(projects.bodyBytes) })
      .from(projects)
      .where(eq(projects.organizationId, organizationId)),
    db
      .select({ n: count() })
      .from(variants)
      .innerJoin(projects, eq(projects.id, variants.projectId))
      .where(eq(projects.organizationId, organizationId)),
  ]);
  return {
    projects: projectCount[0]?.n ?? 0,
    variants: variantCount[0]?.n ?? 0,
    /** The documents of the largest project together, which is what the size limit is about. */
    projectBytes: projectCount[0]?.largest ?? 0,
  };
}

/** A request for Pro that nobody has acted on yet: a subscription that is not paid for. */
const openRequest = (db: Db, organizationId: string) =>
  db
    .select({ id: subscriptions.id, createdAt: subscriptions.createdAt })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.referenceId, organizationId), eq(subscriptions.status, "incomplete")),
    )
    .get();

const day = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

/**
 * Ask for Pro, or ask to cancel it. There is no checkout yet, so both are a
 * note in the subscription and an email to the people who run the instance
 * (CONTACT_EMAIL), who do by hand what Stripe will do one day:
 *
 * - **Upgrade** makes the workspace's subscription one that is not yet paid
 *   for (`incomplete`). They send a payment link, and when it is paid, make
 *   it `active`. The email carries the statement.
 * - **Cancel** marks the subscription not to be renewed. They cancel it
 *   where the money is taken, and remove it when what was paid for has run
 *   out (the email carries that statement too), or it lapses by itself at
 *   the end of its period if it has one.
 *
 * Whether a request is new is decided by the write that records it, so asking
 * twice (two tabs, two clicks) sends one email. An upgrade that was asked for
 * a day ago and not answered can be asked for again.
 */
workspaceRoutes.post("/plan-request", async (c) => {
  if (!sellsPlans(c.env)) throw notFound("Plans");
  if (c.var.role !== "owner") {
    throw forbidden("Only the owner of the workspace can change its plan.");
  }
  const db = createDb(c.env.DB);
  const organizationId = c.var.organizationId;
  const [{ plan, subscription }, usage, workspace, payload] = await Promise.all([
    planOf(db, c.env, organizationId),
    usageOf(db, organizationId),
    db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .get(),
    readJson(c),
  ]);
  if (!workspace) throw notFound("Workspace");
  const want = subscription ? "cancel" : "upgrade";
  if (payload.want !== want) {
    throw badRequest(
      subscription
        ? 'This workspace is on Pro. What can be asked for is "cancel".'
        : 'This workspace is on Free. What can be asked for is "upgrade".',
    );
  }
  const to = c.env.CONTACT_EMAIL;
  if (!to || !emailConfigured(c.env)) {
    throw new ApiError(
      503,
      "not-available",
      "This instance cannot take the request. Write to whoever runs it.",
    );
  }

  const now = Date.now();
  const { name, email } = c.var.user;
  const who = `${name} (${email})`;
  const facts = `Workspace: ${organizationId}\nPlan now: ${PLAN_NAMES[plan]}\nIn use: ${usage.projects} projects, ${usage.variants} variants`;
  /** Send it, or put things back so that it can be asked again. */
  const tell = async (message: { subject: string; paragraphs: string[] }, undo: () => unknown) => {
    if (await sendEmail(c.env, { to, ...message })) return c.json({ ok: true, want, sent: true });
    await undo();
    throw new ApiError(
      502,
      "not-sent",
      `The request could not be sent. Please write to ${to} instead.`,
    );
  };

  if (subscription) {
    const marked = await db
      .update(subscriptions)
      .set({ cancelAtPeriodEnd: true, canceledAt: now, updatedAt: now })
      .where(and(eq(subscriptions.id, subscription.id), eq(subscriptions.cancelAtPeriodEnd, false)))
      .returning({ id: subscriptions.id });
    // Asked already: it is marked, and they know.
    if (marked.length === 0) return c.json({ ok: true, want, sent: false });
    return tell(
      {
        subject: `Cancellation requested: ${workspace.name}`,
        paragraphs: [
          `${who} would like to cancel Pro for the workspace "${workspace.name}".`,
          `Write to: ${email}`,
          facts,
          subscription.periodEnd
            ? `It is marked not to renew and ends by itself on ${day(subscription.periodEnd)}. Cancel it where the payment is taken, so that it is not charged again.`
            : `Cancel it where the payment is taken, so that it is not charged again. The workspace keeps Pro until you remove it. When what was paid for has run out:\n${removePlanStatement(email)}`,
        ],
      },
      () =>
        db
          .update(subscriptions)
          .set({ cancelAtPeriodEnd: false, canceledAt: null })
          .where(and(eq(subscriptions.id, subscription.id), eq(subscriptions.canceledAt, now))),
    );
  }

  // The write that records the request decides whether it is new: one that has
  // waited a day is asked again, a fresh one is not, and anything else the row
  // was (canceled, run out) starts over.
  const before = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.referenceId, organizationId))
    .get();
  const asked = {
    plan: "pro" as const,
    status: "incomplete" as const,
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
    updatedAt: now,
  };
  const recorded = await db
    .insert(subscriptions)
    .values({ id: newId("sub"), referenceId: organizationId, createdAt: now, ...asked })
    .onConflictDoUpdate({
      target: subscriptions.referenceId,
      set: {
        ...asked,
        createdAt: sql`CASE WHEN ${subscriptions.status} = 'incomplete' THEN ${subscriptions.createdAt} ELSE ${now} END`,
      },
      setWhere: or(
        ne(subscriptions.status, "incomplete"),
        lte(subscriptions.updatedAt, now - DAY_MS),
      ),
    })
    .returning({ id: subscriptions.id });
  // Asked within the day: it is on its way.
  const requested = recorded[0]?.id;
  if (!requested) return c.json({ ok: true, want, sent: false });
  return tell(
    {
      subject: `Upgrade to Pro requested: ${workspace.name}`,
      paragraphs: [
        `${who} would like to move the workspace "${workspace.name}" to Pro.`,
        `Write to: ${email}`,
        facts,
        `Once it is paid for, this gives the workspace Pro until you remove it:\n${giveProStatement(email)}`,
      ],
    },
    () =>
      before
        ? // As it was, and old enough for the next try to send again.
          db
            .update(subscriptions)
            .set({ ...before, updatedAt: Math.min(before.updatedAt, now - DAY_MS) })
            .where(eq(subscriptions.id, requested))
        : db.delete(subscriptions).where(eq(subscriptions.id, requested)),
  );
});

workspaceRoutes.patch("/", async (c) => {
  const payload = await readJson(c);
  const updates: { name?: string; defaultVisibility?: Visibility } = {};
  if (payload.name !== undefined) {
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (name === "" || name.length > 100) throw badRequest("name must be 1 to 100 characters.");
    updates.name = name;
  }
  if (payload.defaultVisibility !== undefined) {
    if (!isVisibility(payload.defaultVisibility)) {
      throw badRequest('defaultVisibility must be "public" or "private".');
    }
    updates.defaultVisibility = payload.defaultVisibility;
  }
  if (Object.keys(updates).length === 0) throw badRequest("Nothing to update.");
  await createDb(c.env.DB)
    .update(organization)
    .set(updates)
    .where(eq(organization.id, c.var.organizationId));
  return c.json({ ok: true, ...updates });
});

workspaceRoutes.post("/invitations", async (c) => {
  const db = createDb(c.env.DB);
  const organizationId = c.var.organizationId;
  const payload = await readJson(c);
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw badRequest("That does not look like an email address.");
  }

  const [members, pending, workspace] = await Promise.all([
    db
      .select({ email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, organizationId)),
    pendingInvitations(db, organizationId),
    db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .get(),
  ]);
  if (members.some((existing) => existing.email.toLowerCase() === email)) {
    throw new ApiError(409, "already-member", `${email} is already in this workspace.`);
  }

  const now = Date.now();
  const expiresAt = new Date(now + INVITATION_MS);
  const again = pending.find((existing) => existing.email === email);
  let id: string;
  let send = true;
  if (again) {
    // Inviting someone twice extends the invitation and sends it again, unless
    // it only just went out. Whether it did is decided by the write itself, so
    // of several requests at once, one sends.
    id = again.id;
    const lastSentBefore = new Date(now + INVITATION_MS - RESEND_PAUSE_MS);
    const extended = await db
      .update(invitation)
      .set({ expiresAt })
      .where(and(eq(invitation.id, id), lte(invitation.expiresAt, lastSentBefore)))
      .returning({ id: invitation.id });
    send = extended.length > 0;
  } else {
    id = `inv_${randomToken(24)}`;
    await db.insert(invitation).values({
      id,
      organizationId,
      email,
      role: "member",
      status: "pending",
      expiresAt,
      inviterId: c.var.user.id,
    });
    // The caps are checked by position, after the insert (see limits.ts), so
    // that requests sent together cannot all slip in under them.
    const ofWorkspace = eq(invitation.organizationId, organizationId);
    const [open, today] = await Promise.all([
      positionOf(
        db,
        invitation,
        id,
        and(ofWorkspace, eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date(now))),
      ),
      positionOf(
        db,
        invitation,
        id,
        and(ofWorkspace, gt(invitation.createdAt, new Date(now - DAY_MS))),
      ),
    ]);
    const refusal =
      open > MAX_PENDING_INVITATIONS
        ? new ApiError(409, "limit-reached", "Too many invitations are waiting for an answer.")
        : today > MAX_INVITATIONS_PER_DAY
          ? new ApiError(
              429,
              "limit-reached",
              "That is a lot of invitations for one day. Try again tomorrow.",
            )
          : members.length + open > MAX_MEMBERS
            ? new ApiError(
                409,
                "limit-reached",
                `A workspace can have up to ${MAX_MEMBERS} people.`,
              )
            : undefined;
    if (refusal) {
      await db.delete(invitation).where(eq(invitation.id, id));
      throw refusal;
    }
  }

  const link = inviteLink(c, id);
  const inviter = c.var.user.name;
  const emailed =
    send &&
    (await sendEmail(c.env, {
      to: email,
      subject: `${inviter} invited you to ${workspace?.name ?? "a workspace"} on openapi-proxy`,
      paragraphs: [
        `${inviter} invited you to work with them on openapi-proxy${
          workspace?.name ? `, in the workspace ${workspace.name}` : ""
        }.`,
        "Sign in with this email address to join:",
        link,
      ],
      footer: `The invitation is valid for ${INVITATION_DAYS} days. If you were not expecting it, you can ignore this email.`,
    }));

  return c.json(
    {
      id,
      email,
      expiresAt: (send ? expiresAt : (again?.expiresAt ?? expiresAt)).getTime(),
      invitedBy: inviter,
      link,
      emailed,
    },
    again ? 200 : 201,
  );
});

workspaceRoutes.delete("/invitations/:id", async (c) => {
  const removed = await createDb(c.env.DB)
    .update(invitation)
    .set({ status: "canceled" })
    .where(
      and(
        eq(invitation.id, c.req.param("id")),
        eq(invitation.organizationId, c.var.organizationId),
        eq(invitation.status, "pending"),
      ),
    )
    .returning({ id: invitation.id });
  if (removed.length === 0) throw notFound("Invitation");
  return c.json({ ok: true });
});

/** Remove someone (the owner may), or leave (anyone but the owner may). */
workspaceRoutes.delete("/members/:id", async (c) => {
  const db = createDb(c.env.DB);
  const target = await db
    .select({ id: member.id, userId: member.userId, role: member.role })
    .from(member)
    .where(and(eq(member.id, c.req.param("id")), eq(member.organizationId, c.var.organizationId)))
    .get();
  if (!target) throw notFound("Member");

  const leaving = target.userId === c.var.user.id;
  if (target.role === "owner") {
    throw forbidden("The owner of a workspace cannot be removed from it.");
  }
  if (!leaving && c.var.role !== "owner") {
    throw forbidden("Only the owner of the workspace can remove people.");
  }

  await db.batch([
    db.delete(member).where(eq(member.id, target.id)),
    // Their API keys acted for them in this workspace, and go with them.
    db
      .delete(apiKeys)
      .where(
        and(eq(apiKeys.userId, target.userId), eq(apiKeys.organizationId, c.var.organizationId)),
      ),
  ]);
  return c.json({ ok: true });
});

// ---- Invitations, from the invited person's side ----

type InvitationState =
  /** Can be accepted right now. */
  | "ready"
  /** Signed in with a different address than the one invited. */
  | "wrong-account"
  | "expired"
  | "already-member"
  /** This person's current workspace has projects, or other people in it that they own. */
  | "blocked";

async function inspect(
  db: Db,
  id: string,
  me: { id: string; email: string },
  organizationId: string,
) {
  const row = await db
    .select({
      id: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      workspace: organization.name,
      invitedBy: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, id))
    .get();
  if (!row) throw notFound("Invitation");
  const account = await db
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, me.id))
    .get();

  let state: InvitationState = "ready";
  let reason: string | undefined;
  /** What accepting has to do with the workspace this person is in now. */
  let leave: "delete-workspace" | "leave-workspace" | undefined;

  if (row.organizationId === organizationId) {
    state = "already-member";
  } else if (row.status !== "pending" || row.expiresAt.getTime() <= Date.now()) {
    state = "expired";
  } else if (row.email !== me.email.toLowerCase()) {
    state = "wrong-account";
    reason = `This invitation is for ${row.email}. You are signed in as ${me.email}.`;
  } else if (!account?.emailVerified) {
    // The invitation is addressed to a mailbox; only its proven holder may take it.
    state = "wrong-account";
    reason = `The address ${me.email} has not been verified by your sign-in provider.`;
  } else {
    // A person has one workspace, so joining means leaving the current one.
    const [members, owned, own, paid] = await Promise.all([
      db.select({ n: count() }).from(member).where(eq(member.organizationId, organizationId)),
      db.select({ n: count() }).from(projects).where(eq(projects.organizationId, organizationId)),
      db.select({ role: member.role }).from(member).where(eq(member.userId, me.id)).get(),
      db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.referenceId, organizationId), inForce(Date.now())))
        .get(),
    ]);
    const alone = (members[0]?.n ?? 0) <= 1;
    if (!alone && own?.role === "owner") {
      state = "blocked";
      reason = "You own a workspace that other people are in. Remove them first.";
    } else if (alone && paid) {
      // Deleting it would leave a subscription that is charged for nothing.
      state = "blocked";
      reason =
        "Your current workspace has a subscription, and joining another one would delete the workspace. Cancel the subscription first, or sign in with another account.";
    } else if (alone && (owned[0]?.n ?? 0) > 0) {
      state = "blocked";
      reason =
        "Your current workspace has projects, and joining another one would leave them behind. Delete them first, or sign in with another account.";
    } else {
      leave = alone ? "delete-workspace" : "leave-workspace";
    }
  }
  return { row, state, reason, leave };
}

invitationRoutes.get("/:id", async (c) => {
  const { row, state, reason } = await inspect(
    createDb(c.env.DB),
    c.req.param("id"),
    c.var.user,
    c.var.organizationId,
  );
  return c.json({
    id: row.id,
    workspace: row.workspace,
    invitedBy: row.invitedBy,
    email: row.email,
    state,
    ...(reason ? { reason } : {}),
  });
});

invitationRoutes.post("/:id/accept", async (c) => {
  const db = createDb(c.env.DB);
  const me = c.var.user;
  const current = c.var.organizationId;
  const { row, state, reason, leave } = await inspect(db, c.req.param("id"), me, current);

  if (state === "already-member") return c.json({ ok: true, workspace: row.workspace });
  if (state !== "ready") {
    throw new ApiError(409, `invitation-${state}`, reason ?? "This invitation is no longer valid.");
  }

  // One transaction: out of the old workspace, into the new one. The unique
  // index on member.user_id makes the middle state impossible to keep.
  await db.batch([
    leave === "delete-workspace"
      ? db.delete(organization).where(eq(organization.id, current))
      : db.delete(member).where(eq(member.userId, me.id)),
    db.insert(member).values({
      id: `mem_${randomToken(16)}`,
      organizationId: row.organizationId,
      userId: me.id,
      role: "member",
      createdAt: new Date(),
    }),
    db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, row.id)),
    // Keys made in the workspace being left do not come along.
    db.delete(apiKeys).where(eq(apiKeys.userId, me.id)),
    // Kept in step for better-auth; requests read the member table, not this.
    db
      .update(session)
      .set({ activeOrganizationId: row.organizationId })
      .where(eq(session.userId, me.id)),
  ]);
  return c.json({ ok: true, workspace: row.workspace });
});
