import type { Context } from "hono";
import { keyPrincipal, readOnlyKey } from "./auth";
import { createDb } from "./db/client";
import type { AppContext } from "./env";
import { bearerCredential } from "./keys";
import { REQUEST_COST, spend, tooManyRequests } from "./rate-limit";

/**
 * The MCP endpoint: `POST /mcp`. A Model Context Protocol server over the
 * Streamable HTTP transport, so that an agent can manage variants the way a
 * person does in the app.
 *
 * Three things to know before reading on.
 *
 * It holds no rules of its own. Every tool is a call to this app's own REST
 * API, made as the caller, with the caller's key. Tenancy, plans and
 * validation therefore have exactly one implementation, and a tool can do
 * nothing the API would refuse.
 *
 * It is stateless. No sessions, no streams: each POST is one JSON-RPC message
 * and is answered with one JSON object.
 *
 * It speaks both eras of the protocol. Revision 2026-07-28 ("modern") has no
 * handshake: every request names its protocol version in `_meta` and in
 * headers, and `server/discover` describes the server. Earlier revisions
 * ("legacy") open with `initialize`. Which one a request belongs to is read
 * off the request itself, and the differences are confined to `answerModern`
 * and `answerLegacy` below.
 */

const SERVER = { name: "openapi-proxy", version: "1.0.0" };
const MODERN_VERSION = "2026-07-28";
/** Handshake-era revisions, newest first. */
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_KEY = "io.modelcontextprotocol/serverInfo";

const INSTRUCTIONS =
  "openapi-proxy serves filtered versions (variants) of OpenAPI documents at stable public URLs. " +
  "A project is one OpenAPI document; a variant is a selection of its operations. " +
  "Call get_project to see the operations a project has before creating or changing a variant, " +
  "and give people the variant's url, which serves JSON, or YAML with .yaml appended.";

/** The tool list changes only when this code does, and is the same for everyone. */
const CACHING = { ttlMs: 60 * 60 * 1000, cacheScope: "public" };

// JSON-RPC and MCP error codes.
/** Messages in one request. Each can be a tool call that reaches out to a source. */
const MAX_BATCH = 20;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

// ---- Tools ----

type Json = Record<string, unknown>;
/** Calls this app's REST API as the caller and returns the parsed body. Throws `ToolFailure` when the API refuses. */
type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** Something the model can act on: reported as a tool result with `isError`, not as a protocol error. */
class ToolFailure extends Error {}

interface Tool {
  name: string;
  title: string;
  /** One sentence, written for a model deciding whether to call this. */
  description: string;
  properties: Record<string, Json>;
  required: string[];
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  run(args: Json, api: Api): Promise<Json>;
}

/** A required string argument. */
function text(args: Json, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") throw new ToolFailure(`"${name}" is required.`);
  return value;
}

const id = (args: Json, name: string) => encodeURIComponent(text(args, name));

/** A project without its list of operations, which can run to hundreds of entries. */
function withoutOperations(project: unknown): Json {
  const { operations, ...rest } = project as Json & { operations?: unknown[] };
  return { ...rest, operationCount: Array.isArray(operations) ? operations.length : 0 };
}

const PROJECT_ID = { type: "string", description: "A project id, as returned by list_projects." };
const VARIANT_ID = { type: "string", description: "A variant id, as returned by list_variants." };
const HEADERS = {
  type: "array",
  description:
    "Request headers to send when fetching it, for a document that is not public. Stored encrypted.",
  items: {
    type: "object",
    properties: { name: { type: "string" }, value: { type: "string" } },
    required: ["name", "value"],
  },
};
const PATH_PREFIX = {
  type: "string",
  description:
    'Put in front of every path of this document, such as "/billing", for a service that is mounted under the main API.',
};
const VISIBILITY = {
  type: "string",
  enum: ["public", "private"],
  description:
    "Who may read the variant at its url: anyone (public), or only requests that send an API key of the workspace as Authorization: Bearer (private). Left out when creating, the workspace's default applies.",
};
const OVERRIDES = {
  type: ["object", "null"],
  description:
    "What this variant says at the top of its document instead of the source: a title, a description, and the servers the API is reached at (the first is the default). Use it for another environment or audience, such as a staging server or a public title. Anything left out is the document's own; null removes all overrides.",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    servers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", description: "Starts with https://, http:// or /." },
          description: { type: "string", description: 'Such as "Production" or "Sandbox".' },
        },
        required: ["url"],
      },
    },
  },
};
const SELECTION = {
  type: "object",
  description:
    'Which operations the variant serves. With mode "include", only the listed operations and tags are served, and operations the source adds later stay hidden. With mode "exclude", everything is served except the listed operations and tags, including operations the source adds later. Tags are rules: they also cover operations that get the tag in the future.',
  properties: {
    mode: { type: "string", enum: ["include", "exclude"] },
    operations: {
      type: "array",
      items: { type: "string" },
      description: 'Operation keys exactly as get_project returns them, such as "GET /v1/books".',
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Tag names. Every operation carrying one of them matches.",
    },
  },
  required: ["mode", "operations", "tags"],
};

/** Every tool, in the order clients see them. To add one, add an entry: nothing else needs to change. */
const TOOLS: Tool[] = [
  {
    name: "list_projects",
    title: "List projects",
    description:
      "List the workspace's projects (each one API, assembled from one or more OpenAPI documents) with their sources, status and where their variants are served.",
    properties: {},
    required: [],
    annotations: { readOnlyHint: true },
    run: async (_args, api) => ({
      projects: ((await api("GET", "/api/projects")) as unknown[]).map(withoutOperations),
    }),
  },
  {
    name: "get_project",
    title: "Get a project and its operations",
    description:
      "Get one project together with the operations of its document (key, tags, summary), optionally narrowed to a tag or a search text; call this before choosing what a variant serves.",
    properties: {
      projectId: PROJECT_ID,
      tag: { type: "string", description: "Only operations carrying this tag." },
      search: {
        type: "string",
        description: "Only operations whose key or summary contains this text.",
      },
    },
    required: ["projectId"],
    annotations: { readOnlyHint: true },
    run: async (args, api) => {
      const project = (await api("GET", `/api/projects/${id(args, "projectId")}`)) as Json;
      const tag = typeof args.tag === "string" ? args.tag : undefined;
      const needle = typeof args.search === "string" ? args.search.toLowerCase() : undefined;
      const all = (Array.isArray(project.operations) ? project.operations : []) as Array<
        Json & { key: string; tags: string[]; summary?: string }
      >;
      const operations = all
        .filter((operation) => tag === undefined || operation.tags.includes(tag))
        .filter(
          (operation) =>
            needle === undefined ||
            operation.key.toLowerCase().includes(needle) ||
            (operation.summary ?? "").toLowerCase().includes(needle),
        )
        // The key already says method and path; the fingerprint is for change detection.
        .map(({ fingerprint: _fingerprint, method: _method, path: _path, ...rest }) => rest);
      return { ...withoutOperations(project), operations };
    },
  },
  {
    name: "connect_project",
    title: "Connect an OpenAPI document",
    description:
      "Create a project from the URL of an OpenAPI 3.x document (JSON or YAML); more documents can be merged into it afterwards with add_source.",
    properties: {
      url: { type: "string", description: "Where the OpenAPI document can be fetched." },
      headers: HEADERS,
    },
    required: ["url"],
    annotations: { openWorldHint: true },
    run: async (args, api) =>
      withoutOperations(
        await api("POST", "/api/projects", {
          url: text(args, "url"),
          ...(Array.isArray(args.headers) ? { headers: args.headers } : {}),
        }),
      ),
  },
  {
    name: "add_source",
    title: "Merge another document into a project",
    description:
      "Add another OpenAPI document to a project, merging its operations into the project's document; where it defines an operation the project already has, the existing one is kept, and the result's notes say what was left out or renamed.",
    properties: {
      projectId: PROJECT_ID,
      url: { type: "string", description: "Where the OpenAPI document can be fetched." },
      headers: HEADERS,
      pathPrefix: PATH_PREFIX,
      name: { type: "string", description: "What to call this document. Its title if left out." },
    },
    required: ["projectId", "url"],
    annotations: { openWorldHint: true },
    run: async (args, api) => {
      const body: Json = { url: text(args, "url") };
      if (Array.isArray(args.headers)) body.headers = args.headers;
      for (const field of ["pathPrefix", "name"]) {
        if (typeof args[field] === "string") body[field] = args[field];
      }
      return withoutOperations(
        await api("POST", `/api/projects/${id(args, "projectId")}/sources`, body),
      );
    },
  },
  {
    name: "remove_source",
    title: "Take a document out of a project",
    description:
      "Remove one of a project's documents by its source id (see the sources of get_project); its operations disappear from the project and from every variant that served them.",
    properties: {
      projectId: PROJECT_ID,
      sourceId: { type: "string", description: "The id of one of the project's sources." },
    },
    required: ["projectId", "sourceId"],
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (args, api) =>
      withoutOperations(
        await api(
          "DELETE",
          `/api/projects/${id(args, "projectId")}/sources/${id(args, "sourceId")}`,
        ),
      ),
  },
  {
    name: "check_project",
    title: "Check a project's source now",
    description:
      "Ask the project's sources for their current documents right now and report which operations were added, removed or changed since the last check.",
    properties: { projectId: PROJECT_ID },
    required: ["projectId"],
    annotations: { idempotentHint: true, openWorldHint: true },
    run: async (args, api) => {
      const outcome = (await api("POST", `/api/projects/${id(args, "projectId")}/check`)) as Json;
      return { ...outcome, project: withoutOperations(outcome.project) };
    },
  },
  {
    name: "list_variants",
    title: "List variants",
    description:
      "List variants with their public url, what they serve and whether their source has changed, for the whole workspace or one project.",
    properties: { projectId: { ...PROJECT_ID, description: "Only this project's variants." } },
    required: [],
    annotations: { readOnlyHint: true },
    run: async (args, api) => {
      const variants = (await api("GET", "/api/variants")) as Array<Json>;
      return {
        variants:
          typeof args.projectId === "string"
            ? variants.filter((variant) => variant.projectId === args.projectId)
            : variants,
      };
    },
  },
  {
    name: "get_variant",
    title: "Get a variant",
    description:
      "Get one variant: its public url, its selection, how many operations it serves, and what changed in its source since it was last reviewed.",
    properties: { variantId: VARIANT_ID },
    required: ["variantId"],
    annotations: { readOnlyHint: true },
    run: async (args, api) => (await api("GET", `/api/variants/${id(args, "variantId")}`)) as Json,
  },
  {
    name: "create_variant",
    title: "Create a variant",
    description:
      "Create a variant of a project, a named selection of its operations that is served at its own url from then on; the result contains that url. Append .json or .yaml for a format, and /3.0 or /3.1 before it for an OpenAPI version (such as <url>/3.0.json).",
    properties: {
      projectId: PROJECT_ID,
      name: { type: "string", description: 'What people call it, such as "Public docs".' },
      selection: SELECTION,
      slug: {
        type: "string",
        description:
          "Last segment of the url: 2 to 64 characters of a-z, 0-9 and hyphens. Derived from the name if left out.",
      },
      overrides: OVERRIDES,
      visibility: VISIBILITY,
    },
    required: ["projectId", "name", "selection"],
    annotations: {},
    run: async (args, api) =>
      (await api("POST", "/api/variants", {
        projectId: text(args, "projectId"),
        name: text(args, "name"),
        selection: args.selection,
        ...(typeof args.slug === "string" ? { slug: args.slug } : {}),
        ...(args.overrides !== undefined ? { overrides: args.overrides } : {}),
        ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
      })) as Json,
  },
  {
    name: "update_variant",
    title: "Change a variant",
    description:
      "Change a variant's name, selection, overrides, visibility or slug; a new selection or override is served immediately, and a new slug moves the url so the old one stops working.",
    properties: {
      variantId: VARIANT_ID,
      name: { type: "string" },
      selection: SELECTION,
      slug: {
        type: "string",
        description: "Changing it breaks whatever still requests the old url.",
      },
      overrides: OVERRIDES,
      visibility: VISIBILITY,
    },
    required: ["variantId"],
    annotations: { idempotentHint: true },
    run: async (args, api) => {
      const changes: Json = {};
      for (const field of ["name", "selection", "slug", "overrides", "visibility"]) {
        if (args[field] !== undefined) changes[field] = args[field];
      }
      return (await api("PATCH", `/api/variants/${id(args, "variantId")}`, changes)) as Json;
    },
  },
  {
    name: "delete_variant",
    title: "Delete a variant",
    description:
      "Delete a variant for good; its url stops working at once and anything still requesting it gets a 404.",
    properties: { variantId: VARIANT_ID },
    required: ["variantId"],
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (args, api) =>
      (await api("DELETE", `/api/variants/${id(args, "variantId")}`)) as Json,
  },
  {
    name: "delete_project",
    title: "Delete a project",
    description:
      "Delete a project for good, together with all of its variants, whose urls stop working at once.",
    properties: { projectId: PROJECT_ID },
    required: ["projectId"],
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (args, api) =>
      (await api("DELETE", `/api/projects/${id(args, "projectId")}?cascade=true`)) as Json,
  },
];

/** The tools as `tools/list` describes them. */
const LISTING = TOOLS.map(({ name, title, description, properties, required, annotations }) => ({
  name,
  title,
  description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { title, ...annotations },
}));

// ---- JSON-RPC ----

type RequestId = string | number;

interface Message {
  jsonrpc: "2.0";
  id?: RequestId;
  method: string;
  params?: Json & { _meta?: Json };
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Json;
  const hasValidId =
    message.id === undefined || typeof message.id === "string" || typeof message.id === "number";
  return message.jsonrpc === "2.0" && typeof message.method === "string" && hasValidId;
}

/** What to send back for one message: an HTTP status, and a JSON-RPC response unless it was a notification. */
interface Answer {
  status: 200 | 202 | 400 | 404;
  body?: Json;
}

const done = (requestId: RequestId, result: Json): Answer => ({
  status: 200,
  body: { jsonrpc: "2.0", id: requestId, result },
});

const failed = (
  requestId: RequestId | null,
  code: number,
  message: string,
  status: Answer["status"] = 200,
  data?: Json,
): Answer => ({
  status,
  body: { jsonrpc: "2.0", id: requestId, error: { code, message, ...(data ? { data } : {}) } },
});

/** Run a tool. A refusal by the API is a result the model can read; an unknown tool is a protocol error. */
async function callTool(params: Message["params"], api: Api): Promise<Json | undefined> {
  const tool = TOOLS.find((candidate) => candidate.name === params?.name);
  if (!tool) return undefined;
  const args = params?.arguments;
  try {
    const value = await tool.run(
      typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Json) : {},
      api,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    };
  } catch (error) {
    if (!(error instanceof ToolFailure)) throw error;
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
}

const unknownTool = (message: Message) =>
  failed(message.id as RequestId, INVALID_PARAMS, `Unknown tool: ${String(message.params?.name)}`);

/** Protocol revisions up to 2025-11-25: a handshake first, then plain results. */
async function answerLegacy(message: Message & { id: RequestId }, api: Api): Promise<Answer> {
  switch (message.method) {
    case "initialize": {
      const asked = message.params?.protocolVersion;
      return done(message.id, {
        // The client's version if we speak it, otherwise our newest of this era.
        protocolVersion:
          typeof asked === "string" && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return done(message.id, {});
    case "tools/list":
      return done(message.id, { tools: LISTING });
    case "tools/call": {
      const result = await callTool(message.params, api);
      return result ? done(message.id, result) : unknownTool(message);
    }
    default:
      return failed(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

/** A header value as the client meant it: `=?base64?...?=` wraps values that are not plain ASCII. */
function decodeHeader(value: string | undefined): string | undefined {
  const encoded = /^=\?base64\?(.*)\?=$/.exec(value ?? "");
  if (!encoded) return value;
  try {
    const bytes = Uint8Array.from(atob(encoded[1] ?? ""), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Revision 2026-07-28: no handshake. The request says which version it
 * speaks, in its `_meta` and again in headers that have to agree with the
 * body, and every result says that it is complete and who answered.
 */
async function answerModern(
  c: Context<AppContext>,
  message: Message & { id: RequestId },
  api: Api,
): Promise<Answer> {
  const { id: requestId, method, params } = message;
  const mismatch = (header: string, sent: string | undefined, body: unknown) =>
    failed(
      requestId,
      HEADER_MISMATCH,
      `Header mismatch: ${header} header value '${sent ?? ""}' does not match body value '${String(body ?? "")}'`,
      400,
    );

  const declared = params?._meta?.[VERSION_KEY];
  const versionHeader = c.req.header("mcp-protocol-version");
  if (versionHeader === undefined || versionHeader !== declared) {
    return mismatch("MCP-Protocol-Version", versionHeader, declared);
  }
  if (declared !== MODERN_VERSION) {
    return failed(requestId, UNSUPPORTED_VERSION, "Unsupported protocol version", 400, {
      supported: SUPPORTED_VERSIONS,
      requested: declared,
    });
  }
  const methodHeader = c.req.header("mcp-method");
  if (methodHeader !== method) return mismatch("Mcp-Method", methodHeader, method);

  const complete = (result: Json) =>
    done(requestId, { resultType: "complete", ...result, _meta: { [SERVER_KEY]: SERVER } });

  switch (method) {
    case "server/discover":
      return complete({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        ...CACHING,
      });
    case "tools/list":
      return complete({ tools: LISTING, ...CACHING });
    case "tools/call": {
      const nameHeader = decodeHeader(c.req.header("mcp-name"));
      if (nameHeader !== params?.name) return mismatch("Mcp-Name", nameHeader, params?.name);
      const result = await callTool(params, api);
      return result ? complete(result) : unknownTool(message);
    }
    default:
      return failed(
        requestId,
        METHOD_NOT_FOUND,
        `Method not found: ${method}. This server supports protocol versions ${SUPPORTED_VERSIONS.join(", ")}.`,
        404,
      );
  }
}

async function answer(c: Context<AppContext>, message: unknown, api: Api): Promise<Answer> {
  if (!isMessage(message)) return failed(null, INVALID_REQUEST, "Invalid request", 400);
  // A notification asks for nothing back. None of them changes anything here.
  if (message.id === undefined) return { status: 202 };
  const request = message as Message & { id: RequestId };

  const versionHeader = c.req.header("mcp-protocol-version");
  const modern =
    request.params?._meta?.[VERSION_KEY] !== undefined ||
    (versionHeader !== undefined && !LEGACY_VERSIONS.includes(versionHeader));
  return modern ? answerModern(c, request, api) : answerLegacy(request, api);
}

// ---- HTTP ----

/**
 * Handle a request to the MCP endpoint. `dispatch` sends a request through
 * this same app, which is how tools reach the REST API.
 */
export async function handleMcp(
  c: Context<AppContext>,
  dispatch: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  c.header("cache-control", "no-store");
  if (c.req.method !== "POST") {
    // No streams to open with GET and no sessions to end with DELETE.
    c.header("allow", "POST");
    return c.json(failed(null, INVALID_REQUEST, "This endpoint accepts POST only.").body, 405);
  }

  // A browser page on another site has no business here (the specification
  // requires this check against DNS rebinding). Programs send no Origin.
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== new URL(c.req.url).origin) {
    return c.json(failed(null, INVALID_REQUEST, "This origin is not allowed.").body, 403);
  }

  const authorization = c.req.header("authorization");
  const credential = bearerCredential(authorization);
  const principal =
    credential === undefined ? undefined : await keyPrincipal(c, createDb(c.env.DB), credential);
  if (!principal) {
    c.header("www-authenticate", "Bearer");
    return c.json(
      {
        code: "unauthorized",
        error:
          credential === undefined
            ? "Send an API key: Authorization: Bearer <key>."
            : "This API key is not valid.",
      },
      401,
    );
  }
  if (principal.access !== "full") return readOnlyKey(c);
  // Charged to the workspace like any request. What a tool then asks of the
  // API is charged there, at the API's own prices.
  if (!(await spend(c.env, principal.organizationId, REQUEST_COST))) return tooManyRequests(c);

  const api: Api = async (method, path, body) => {
    const response = await dispatch(
      new Request(new URL(path, c.req.url), {
        method,
        headers: {
          authorization: authorization as string,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const data = (await response.json().catch(() => undefined)) as
      | { error?: string; detail?: string }
      | undefined;
    if (!response.ok) {
      throw new ToolFailure(
        [data?.error ?? `The request failed (${response.status}).`, data?.detail]
          .filter(Boolean)
          .join(" "),
      );
    }
    return data;
  };

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(failed(null, PARSE_ERROR, "Parse error").body, 400);
  }

  // Handshake-era clients may send several messages in one array.
  if (Array.isArray(payload)) {
    if (payload.length > MAX_BATCH) {
      return c.json(
        failed(null, INVALID_REQUEST, `At most ${MAX_BATCH} messages in one request.`).body,
        400,
      );
    }
    const answers = await Promise.all(payload.map((message) => answer(c, message, api)));
    const bodies = answers.flatMap((each) => (each.body ? [each.body] : []));
    return bodies.length > 0 ? c.json(bodies) : c.body(null, 202);
  }

  const { status, body } = await answer(c, payload, api);
  return body ? c.json(body, status) : c.body(null, status);
}
