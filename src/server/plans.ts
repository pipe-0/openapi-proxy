import { eq } from "drizzle-orm";
import { isPlan, PLAN_LIMITS, type Plan, type PlanLimits } from "../shared/plans";
import type { Db } from "./db/client";
import { organization } from "./db/schema";
import type { Env } from "./env";

/**
 * Which plan a workspace is on. Its own, if someone set one; otherwise the
 * instance default, which is "pro" (no commercial limits) unless the operator
 * says DEFAULT_PLAN=free.
 *
 * There is no checkout. Moving a workspace to Pro is one statement:
 *
 *   UPDATE organization SET plan = 'pro' WHERE id = '<organization id>';
 */
export function resolvePlan(
  env: Pick<Env, "DEFAULT_PLAN">,
  stored: string | null | undefined,
): Plan {
  if (isPlan(stored)) return stored;
  return isPlan(env.DEFAULT_PLAN) ? env.DEFAULT_PLAN : "pro";
}

export interface WorkspacePlan {
  plan: Plan;
  limits: PlanLimits;
}

export async function planOf(db: Db, env: Env, organizationId: string): Promise<WorkspacePlan> {
  const row = await db
    .select({ plan: organization.plan })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .get();
  const plan = resolvePlan(env, row?.plan);
  return { plan, limits: PLAN_LIMITS[plan] };
}

/** Limits as JSON: "no limit" travels as null. */
export function limitsToApi(limits: PlanLimits): Record<keyof PlanLimits, number | null> {
  const finite = (value: number) => (Number.isFinite(value) ? value : null);
  return { projects: finite(limits.projects), variants: finite(limits.variants) };
}
