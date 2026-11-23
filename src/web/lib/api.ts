import type {
  ApplyRequest,
  ApplyResult,
  ProjectDefinition,
  ProjectNote,
  ProjectView,
  SourceState,
  SpecFormat,
  TargetVersion,
  VariantDefinition,
  VariantState,
} from "@openapi-proxy/core";
import { queryOptions } from "@tanstack/react-query";
import type { KeyAccess, Visibility } from "../../shared/access";
import type { VariantIconName } from "../../shared/variant-icons";

export type {
  ApplyRequest,
  ApplyResult,
  KeyAccess,
  ProjectDefinition,
  ProjectNote,
  SourceState,
  VariantDefinition,
  VariantIconName,
  VariantState,
  Visibility,
};

/** A project as the app reads it: its definition, and what the service knows about it. */
export type Project = ProjectView;

export type Plan = "free" | "pro";
/** Which source changes a person is emailed about. */
export type NotificationScope = "off" | "served" | "all";

/** What a plan allows. `null` means no limit. */
export interface Limits {
  projects: number | null;
  variants: number | null;
}

export interface Me {
  user: { id: string; name: string; email: string; image?: string | null };
  workspace: { id: string; name: string };
  role: "owner" | "member";
  plan: Plan;
  planName: string;
  /** False on an instance without plans: nothing about them is shown. */
  plansEnabled: boolean;
  limits: Limits;
  emailConfigured: boolean;
  /** Who may read a variant when neither it nor its project says. */
  defaultVisibility: Visibility;
  /** Everything before a project's slug in its public URLs, e.g. `https://proxy.example.com/v/`. */
  urlPrefix: string;
}

export interface Workspace {
  id: string;
  name: string;
  /** Who may read a variant when neither it nor its project says. */
  defaultVisibility: Visibility;
  /** Your own role in it. */
  role: "owner" | "member";
  plan: Plan;
  planName: string;
  /** False on an instance without plans: there is nothing to show about them. */
  plansEnabled: boolean;
  /** What the plan allows, and how large one project's documents may be together (on every plan). */
  limits: Limits & { projectBytes: number };
  /** What is in use. `projectBytes` is the largest project's documents together. */
  usage: { projects: number; variants: number; projectBytes: number };
  /** What the plan comes from: when it renews, or that it is ending. Null on Free. */
  subscription: {
    status: "trialing" | "active" | "past_due";
    /** The end of what is paid for: when it renews, or ends. */
    periodEnd: number | null;
    /** Its owner asked to cancel (at `canceledAt`): it is not renewed. */
    cancelAtPeriodEnd: boolean;
    canceledAt: number | null;
  } | null;
  /** When Pro was asked for, while nobody has acted on it yet. */
  upgradeRequestedAt: number | null;
  /** Whether this instance can take such a request (it is an email to whoever runs it). */
  planRequests: boolean;
  members: Array<{
    id: string;
    name: string;
    email: string;
    image: string | null;
    role: "owner" | "member";
    joinedAt: number;
    you: boolean;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    invitedBy: string;
    expiresAt: number;
    link: string;
  }>;
  emailConfigured: boolean;
  contactEmail: string | null;
}

export interface SentInvitation {
  id: string;
  email: string;
  link: string;
  /** False when this instance does not send email: pass the link on yourself. */
  emailed: boolean;
}

/** An invitation as the invited person sees it. */
export interface ReceivedInvitation {
  id: string;
  workspace: string;
  invitedBy: string;
  email: string;
  state: "ready" | "wrong-account" | "expired" | "already-member" | "blocked";
  reason?: string;
}

export interface AuthConfig {
  configured: boolean;
  problem?: "missing" | "example-values";
  methods: { google: boolean; password: boolean };
  /** Whether this instance has terms and a privacy policy (the hosted service does). */
  legal: boolean;
}

/**
 * What follows a variant's URL for one representation of it: `.json` for the
 * version its document has, `/3.0.json` for one it is converted to.
 */
export function representation(version: TargetVersion | null, format: SpecFormat): string {
  return `${version === null ? "" : `/${version}`}.${format}`;
}

export interface HeaderInput {
  name: string;
  /** Omit to keep the value already stored under this name. */
  value?: string;
}

/** What "Check now" found. The project itself is read again afterwards. */
export interface CheckResult {
  changed: boolean;
  addedOps: string[];
  removedOps: string[];
  /** Still there, with a different definition (its own, or of something it references). */
  changedOps: string[];
  lastStatus: "ok" | "error";
  lastError: string | null;
}

export interface SlugCheck {
  slug: string;
  valid: boolean;
  available: boolean;
}

interface ErrorBody {
  code?: string;
  /** Our routes answer `{ error }`, better-auth answers `{ message }`. */
  error?: string;
  message?: string;
  detail?: string;
  /** For a document that was refused: the source it belongs to. */
  source?: string;
}

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly source: string | undefined;

  constructor(status: number, body: ErrorBody) {
    super(body.error || body.message || `The request failed (${status}).`);
    this.status = status;
    this.code = body.code ?? "unknown";
    this.detail = body.detail;
    this.source = body.source;
  }
}

/** A message worth showing for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof RequestError) return error.message;
  return "Something went wrong. Check your connection and try again.";
}

let onUnauthorized: (() => void) | undefined;

/** Called when a request finds the session gone (expired, or signed out in another tab). */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function send(path: string, init?: RequestInit & { quiet?: boolean }): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorBody;
    if (response.status === 401 && !init?.quiet) onUnauthorized?.();
    throw new RequestError(response.status, body);
  }
  return response;
}

export async function request<T>(
  path: string,
  init?: RequestInit & { quiet?: boolean },
): Promise<T> {
  return (await send(path, init)).json() as Promise<T>;
}

export const body = (method: string, payload: unknown): RequestInit => ({
  method,
  body: JSON.stringify(payload),
});

export const api = {
  authConfig: () => request<AuthConfig>("/api/auth-config"),
  me: () => request<Me>("/api/me", { quiet: true }),
  /** Starts the Google sign-in and returns the URL to send the browser to. */
  signInWithGoogle: (returnTo: string) =>
    request<{ url: string }>("/api/auth/sign-in/social", {
      ...body("POST", { provider: "google", callbackURL: returnTo, errorCallbackURL: "/login" }),
      quiet: true,
    }),
  signInWithPassword: (password: string) =>
    request<{ ok: boolean }>("/api/auth/sign-in/admin-password", {
      ...body("POST", { password }),
      quiet: true,
    }),
  signOut: () => request<unknown>("/api/auth/sign-out", { ...body("POST", {}), quiet: true }),
  /** Which changes to a project's documents you are emailed about. Yours alone. */
  projectNotifications: (slug: string) =>
    request<{ scope: NotificationScope }>(`/api/projects/${slug}/notifications`),
  setProjectNotifications: (slug: string, scope: NotificationScope) =>
    request<{ scope: NotificationScope }>(
      `/api/projects/${slug}/notifications`,
      body("PUT", { scope }),
    ),

  workspace: () => request<Workspace>("/api/workspace"),
  requestPlan: (want: "upgrade" | "cancel") =>
    request<{ ok: boolean; sent: boolean }>("/api/workspace/plan-request", body("POST", { want })),
  renameWorkspace: (name: string) =>
    request<{ ok: boolean }>("/api/workspace", body("PATCH", { name })),
  setDefaultVisibility: (defaultVisibility: Visibility) =>
    request<{ ok: boolean }>("/api/workspace", body("PATCH", { defaultVisibility })),
  invite: (email: string) =>
    request<SentInvitation>("/api/workspace/invitations", body("POST", { email })),
  cancelInvitation: (id: string) =>
    request<{ ok: boolean }>(`/api/workspace/invitations/${id}`, { method: "DELETE" }),
  removeMember: (id: string) =>
    request<{ ok: boolean }>(`/api/workspace/members/${id}`, { method: "DELETE" }),
  invitation: (id: string) => request<ReceivedInvitation>(`/api/invitations/${id}`),
  acceptInvitation: (id: string) =>
    request<{ ok: boolean }>(`/api/invitations/${id}/accept`, { method: "POST" }),

  listProjects: () => request<Project[]>("/api/projects"),
  getProject: (slug: string) => request<Project>(`/api/projects/${slug}`),
  /**
   * Apply a definition: the one way a project is created or changed. With
   * `dryRun` everything is worked out and nothing is written.
   */
  applyProject: (payload: ApplyRequest, options: { dryRun?: boolean } = {}) =>
    request<ApplyResult>(
      `/api/projects/${payload.definition.project}${options.dryRun ? "?dryRun=true" : ""}`,
      body("PUT", payload),
    ),
  /** The project's documents assembled into one, as text. */
  getProjectDocument: async (slug: string) => (await send(`/api/projects/${slug}/document`)).text(),
  checkProject: (slug: string) =>
    request<CheckResult>(`/api/projects/${slug}/check`, { method: "POST" }),
  /** The request headers the service sends when it fetches a followed source. */
  setCredentials: (slug: string, source: string, headers: HeaderInput[]) =>
    request<ApplyResult>(`/api/projects/${slug}/credentials`, body("PUT", { source, headers })),
  deleteProject: (slug: string) =>
    request<{ ok: boolean }>(`/api/projects/${slug}`, { method: "DELETE" }),
  /** Whether a slug is free for a new project. */
  checkProjectSlug: (slug: string) => request<SlugCheck>(`/api/slugs/${encodeURIComponent(slug)}`),
};

/**
 * Every query the app makes, in one place: keys never drift from the fetchers,
 * and route loaders and components share one cache entry.
 */
export const queries = {
  me: queryOptions({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60_000, retry: false }),
  authConfig: queryOptions({ queryKey: ["auth-config"], queryFn: api.authConfig }),
  projects: queryOptions({ queryKey: ["projects"], queryFn: api.listProjects }),
  workspace: queryOptions({ queryKey: ["workspace"], queryFn: api.workspace }),
  invitation: (id: string) =>
    queryOptions({ queryKey: ["invitation", id], queryFn: () => api.invitation(id), retry: false }),
};

/** A URL as people read it: without the protocol. */
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
