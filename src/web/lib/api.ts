import type {
  DocumentOverrides,
  Drift,
  MergeNote,
  OperationEntry,
  Selection,
  SpecFormat,
  TargetVersion,
} from "@openapi-proxy/core";
import { queryOptions } from "@tanstack/react-query";
import type { KeyAccess, Visibility } from "../../shared/access";
import type { VariantIconName } from "../../shared/variant-icons";

export type { KeyAccess, VariantIconName, Visibility };

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
  /** Whether a new variant starts public or private. */
  defaultVisibility: Visibility;
}

export interface Workspace {
  id: string;
  name: string;
  /** Whether a new variant starts public or private. */
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

/** One of the OpenAPI documents a project is assembled from. */
export interface Source {
  id: string;
  /** What people call it. Also names components that had to be renamed in a merge. */
  name: string;
  url: string;
  /** Names of the request headers sent when fetching it. Values never leave the server. */
  headerNames: string[];
  /** Put in front of every path of this document, or null. */
  pathPrefix: string | null;
  versionUrl: string | null;
  lastKnownVersion: string | null;
  /** Set when the version endpoint reported one version for two different documents. */
  versionMismatchAt: number | null;
  /** What the source sends that lets a check skip the download, if anything. */
  validator: "etag" | "last-modified" | null;
  /** Whether a check can skip the download: by one of those, or by a version endpoint. */
  cheap: boolean;
  apiVersion: string | null;
  specVersion: string;
  bodyBytes: number;
  operations: number;
  lastStatus: "ok" | "error";
  lastError: string | null;
}

/** Something that assembling a project's document did and its owner should know. */
export type ProjectNote =
  | MergeNote
  | { kind: "source-converted"; source: string; from: string; to: string };

export interface Project {
  id: string;
  name: string;
  /** First segment of the public URL: /v/<slug>/<variant>. */
  slug: string;
  /** Everything before the project's slug in its public URLs, e.g. `https://proxy.example.com/v/`. */
  urlPrefix: string;
  /**
   * How long a copy may age before the service checks again. Decided by the
   * service: short when every source can be checked cheaply, an hour if not.
   */
  checkIntervalSeconds: number;
  /** The documents it is assembled from, in order. The first is the main one. */
  sources: Source[];
  /** OpenAPI version of the assembled document: "3.0", "3.1" or "3.2". */
  specVersion: string;
  bodyHash: string;
  bodyBytes: number;
  /** Every operation of its document, by key. */
  operations: OperationEntry[];
  notes: ProjectNote[];
  fetchedAt: number;
  lastStatus: "ok" | "error";
  lastError: string | null;
  createdAt: number;
}

/** A document to connect: where it is, and what to send when fetching it. */
export interface NewSource {
  url: string;
  headers?: HeaderInput[];
  pathPrefix?: string;
}

export interface Variant {
  id: string;
  projectId: string;
  name: string;
  slug: string;
  /** Public path, without a format extension: /v/<project>/<variant>. */
  path: string;
  /** The public URL, without a format extension. Built by the server; never build it here. */
  url: string;
  selection: Selection;
  /** Who may read it at its URL: anyone, or only an API key of its workspace. */
  visibility: Visibility;
  /** The title, description and servers it states instead of the document's, or null. */
  overrides: DocumentOverrides | null;
  /** The icon it has in the navigation, or null for the plain one. */
  icon: VariantIconName | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  keptOperations: number;
  totalOperations: number;
  drift: Drift & { acknowledged: string[] };
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

export interface RefreshResult {
  changed: boolean;
  addedOps: string[];
  removedOps: string[];
  /** Still there, with a different definition (its own, or of something it references). */
  changedOps: string[];
  project: Project;
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
}

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;

  constructor(status: number, body: ErrorBody) {
    super(body.error || body.message || `The request failed (${status}).`);
    this.status = status;
    this.code = body.code ?? "unknown";
    this.detail = body.detail;
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
  projectNotifications: (id: string) =>
    request<{ scope: NotificationScope }>(`/api/projects/${id}/notifications`),
  setProjectNotifications: (id: string, scope: NotificationScope) =>
    request<{ scope: NotificationScope }>(
      `/api/projects/${id}/notifications`,
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
  /** One document, or several that are merged into one project (the first is the main one). */
  createProject: (documents: NewSource[]) =>
    request<Project>("/api/projects", body("POST", { sources: documents })),
  addSource: (projectId: string, source: NewSource) =>
    request<Project>(`/api/projects/${projectId}/sources`, body("POST", source)),
  updateSource: (
    projectId: string,
    sourceId: string,
    changes: Partial<{
      name: string;
      pathPrefix: string | null;
      versionUrl: string | null;
      headers: HeaderInput[];
    }>,
  ) => request<Project>(`/api/projects/${projectId}/sources/${sourceId}`, body("PATCH", changes)),
  makeMainSource: (projectId: string, sourceId: string) =>
    request<Project>(`/api/projects/${projectId}/sources/${sourceId}/main`, { method: "POST" }),
  removeSource: (projectId: string, sourceId: string) =>
    request<Project>(`/api/projects/${projectId}/sources/${sourceId}`, { method: "DELETE" }),
  getProjectSpec: async (id: string) => (await send(`/api/projects/${id}/spec`)).text(),
  checkProject: (id: string) =>
    request<RefreshResult>(`/api/projects/${id}/check`, { method: "POST" }),
  updateProject: (id: string, changes: Partial<{ name: string; slug: string }>) =>
    request<Project>(`/api/projects/${id}`, body("PATCH", changes)),
  deleteProject: (id: string) =>
    request<{ ok: boolean }>(`/api/projects/${id}?cascade=true`, { method: "DELETE" }),
  checkProjectSlug: (slug: string, except: string) =>
    request<SlugCheck>(
      `/api/projects/slug-check?slug=${encodeURIComponent(slug)}&except=${encodeURIComponent(except)}`,
    ),

  listVariants: () => request<Variant[]>("/api/variants"),
  createVariant: (variant: {
    projectId: string;
    name: string;
    slug?: string;
    selection: Selection;
    overrides?: DocumentOverrides | null;
    icon?: VariantIconName | null;
    visibility?: Visibility;
  }) => request<Variant>("/api/variants", body("POST", variant)),
  updateVariant: (
    id: string,
    changes: Partial<{
      name: string;
      slug: string;
      selection: Selection;
      overrides: DocumentOverrides | null;
      icon: VariantIconName | null;
      visibility: Visibility;
      acknowledgedMissingOps: string[];
      reviewNewOps: boolean;
    }>,
  ) => request<Variant>(`/api/variants/${id}`, body("PATCH", changes)),
  deleteVariant: (id: string) =>
    request<{ ok: boolean }>(`/api/variants/${id}`, { method: "DELETE" }),
  checkVariantSlug: (projectId: string, slug: string) =>
    request<SlugCheck>(
      `/api/variants/slug-check?projectId=${encodeURIComponent(projectId)}&slug=${encodeURIComponent(slug)}`,
    ),
};

/**
 * Every query the app makes, in one place: keys never drift from the fetchers,
 * and route loaders and components share one cache entry.
 */
export const queries = {
  me: queryOptions({ queryKey: ["me"], queryFn: api.me, staleTime: 5 * 60_000, retry: false }),
  authConfig: queryOptions({ queryKey: ["auth-config"], queryFn: api.authConfig }),
  projects: queryOptions({ queryKey: ["projects"], queryFn: api.listProjects }),
  variants: queryOptions({ queryKey: ["variants"], queryFn: api.listVariants }),
  workspace: queryOptions({ queryKey: ["workspace"], queryFn: api.workspace }),
  invitation: (id: string) =>
    queryOptions({ queryKey: ["invitation", id], queryFn: () => api.invitation(id), retry: false }),
};

/** A URL as people read it: without the protocol. */
export function bareUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
