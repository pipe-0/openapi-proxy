/**
 * What a workspace may do. Shared by the server (which enforces it) and the
 * web app and landing page (which explain it), so they can never disagree.
 *
 * Plans only exist where they are sold: on an instance that says where
 * requests for one go (CONTACT_EMAIL, as the hosted service does). There a
 * workspace is on Free until it has a subscription. A self-hosted instance
 * leaves that unset, and every workspace gets "pro".
 *
 * The free plan is meant to be enough for most teams: a few APIs, each with a
 * handful of audiences. What it costs to host is mostly storage (a compressed
 * copy of each source and of each rendered variant) and one check of each
 * source per interval, which stays small at these numbers. Pro is for
 * companies with many APIs, or many versions of them.
 */
export type Plan = "free" | "pro";

export interface PlanLimits {
  /** OpenAPI documents the workspace connects. */
  projects: number;
  /** Variants across all its projects. */
  variants: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: { projects: 3, variants: 15 },
  pro: { projects: 100, variants: Number.POSITIVE_INFINITY },
};

export const PLAN_NAMES: Record<Plan, string> = { free: "Free", pro: "Pro" };

/**
 * Guards that hold on every plan and on self-hosted instances alike. They
 * keep one workspace from outgrowing what a Worker and D1 handle well
 * (memory and CPU for a document, D1's 2 MB rows), not from buying more.
 */
export const GUARDS = {
  variantsPerProject: 100,
  people: 50,
  apiKeys: 100,
  sourcesPerProject: 10,
  /** All of a project's sources together, before compression. */
  projectBytes: 5_000_000,
} as const;

/** What each plan costs on the hosted service, as the pricing page shows it. */
export const PLAN_PRICES: Record<Plan, { amount: string; per: string }> = {
  free: { amount: "$0", per: "forever" },
  pro: { amount: "$69", per: "per year" },
};

export function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "pro";
}
