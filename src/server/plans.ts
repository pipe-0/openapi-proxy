import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { isPlan, PLAN_LIMITS, type Plan, type PlanLimits } from "../shared/plans";
import type { Db } from "./db/client";
import { type SubscriptionRow, subscriptions } from "./db/schema";
import type { Env } from "./env";

/**
 * Whether this instance sells plans. It does when there is someone to ask for
 * one: `CONTACT_EMAIL`, which is where requests for Pro are sent. Without it
 * (a self-hosted instance) there is nothing to buy, and every workspace has
 * everything.
 */
export const sellsPlans = (env: Pick<Env, "CONTACT_EMAIL">): boolean =>
  Boolean(env.CONTACT_EMAIL?.trim());

/**
 * "This subscription is in force at `now`": paid for, or within the grace
 * that Stripe gives a payment that is late, and not past the end of its
 * period. A period that runs out without being renewed ends the plan by
 * itself, whoever forgot what.
 */
export const inForce = (now: number) =>
  and(
    inArray(subscriptions.status, ["trialing", "active", "past_due"]),
    or(isNull(subscriptions.periodEnd), gt(subscriptions.periodEnd, now)),
  );

export interface WorkspacePlan {
  plan: Plan;
  limits: PlanLimits;
  /** The subscription the plan comes from. None on Free, and none where plans are not sold. */
  subscription: SubscriptionRow | undefined;
}

/** A string as SQLite reads one. */
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** The workspace of the person with this email address. A person is in exactly one. */
const workspaceOf = (email: string, and?: string) =>
  `SELECT organization_id${and ? `, ${and}` : ""} FROM member JOIN user ON user.id = member.user_id WHERE user.email = ${quoted(email)}`;

/**
 * There is no checkout yet, so a person does what a payment would, with one
 * of two statements. Both name the workspace by the email address of anyone
 * in it, and both can be run again. They are in the emails that requests
 * send, and in docs/self-hosting.md for whoever runs an instance.
 *
 * Giving Pro: the workspace's subscription becomes an active one without an
 * end, whether it had asked for one or not.
 */
export const giveProStatement = (email: string) =>
  `INSERT OR REPLACE INTO subscription (reference_id, plan, status) ${workspaceOf(email, "'pro', 'active'")};`;

/** Taking it away again: the workspace is on Free from that moment. */
export const removePlanStatement = (email: string) =>
  `DELETE FROM subscription WHERE reference_id IN (${workspaceOf(email)});`;

/**
 * Which plan a workspace is on: that of its subscription in force, and Free
 * without one. Where plans are not sold, Pro.
 */
export async function planOf(
  db: Db,
  env: Env,
  organizationId: string,
  now = Date.now(),
): Promise<WorkspacePlan> {
  if (!sellsPlans(env)) return { plan: "pro", limits: PLAN_LIMITS.pro, subscription: undefined };
  const subscription = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.referenceId, organizationId), inForce(now)))
    .get();
  const plan = subscription && isPlan(subscription.plan) ? subscription.plan : "free";
  return { plan, limits: PLAN_LIMITS[plan], subscription };
}

/** Limits as JSON: "no limit" travels as null. */
export function limitsToApi(limits: PlanLimits): Record<keyof PlanLimits, number | null> {
  const finite = (value: number) => (Number.isFinite(value) ? value : null);
  return { projects: finite(limits.projects), variants: finite(limits.variants) };
}
