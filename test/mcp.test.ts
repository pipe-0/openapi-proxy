import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  bearer,
  call,
  callAsProgram,
  callsTo,
  createProject,
  createToken,
  googleLogin,
  ORIGIN,
  SPEC_URL,
  serveSpec,
} from "./harness";

/**
 * The MCP endpoint, judged by someone else: the official MCP client drives
 * it, in each of the ways a client can open a conversation. `legacy` is the
 * handshake of protocol revisions up to 2025-11-25; the pinned mode is the
 * stateless revision 2026-07-28; `auto` is a client that works out which of
 * the two a server speaks.
 */
const MODES = [
  ["the 2025 handshake", "legacy", "2025-11-25"],
  ["revision 2026-07-28", { pin: "2026-07-28" }, "2026-07-28"],
  // Given the choice, a client that speaks both ends up on the current revision.
  ["a client that negotiates", "auto", "2026-07-28"],
] as const;

async function connect(token: string, mode: (typeof MODES)[number][1] = "auto") {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    requestInit: { headers: bearer(token) },
    // The client's requests go straight into the Worker.
    fetch: (input, init) => callAsProgram(String(input), init),
  });
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return client;
}

/** A person with a token, and their document ready to be fetched. */
async function person(email = "ada@example.com") {
  const cookie = await googleLogin(email, email.split("@")[0]);
  const { token } = await createToken(cookie);
  serveSpec();
  return { cookie, token };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const structured = <T>(result: ToolResult) => result.structuredContent as T;
const textOf = (result: ToolResult) =>
  (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";

describe.each(MODES)("with %s", (_label, mode, version) => {
  it("agrees on the protocol and says who it is", async () => {
    const { token } = await person();
    const client = await connect(token, mode);
    expect(client.getNegotiatedProtocolVersion()).toBe(version);
    expect(client.getServerVersion()).toMatchObject({ name: "openapi-proxy" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
    expect(client.getInstructions()).toContain("variant");
    await client.close();
  });

  it("lists the tools, each described well enough to be chosen", async () => {
    const { token } = await person();
    const client = await connect(token, mode);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_projects",
      "get_project",
      "connect_project",
      "add_source",
      "remove_source",
      "check_project",
      "list_variants",
      "get_variant",
      "create_variant",
      "update_variant",
      "delete_variant",
      "delete_project",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
    const byName = (name: string) => tools.find((tool) => tool.name === name);
    expect(byName("list_projects")?.annotations?.readOnlyHint).toBe(true);
    expect(byName("delete_project")?.annotations?.destructiveHint).toBe(true);
    expect(byName("create_variant")?.inputSchema.required).toEqual([
      "projectId",
      "name",
      "selection",
    ]);
    await client.close();
  });

  it("goes from a URL to a served variant", async () => {
    const { token } = await person();
    const client = await connect(token, mode);

    const connected = await client.callTool({
      name: "connect_project",
      arguments: { url: SPEC_URL },
    });
    expect(connected.isError).toBeFalsy();
    const project = structured<{ id: string; name: string; operationCount: number }>(connected);
    expect(project).toMatchObject({ name: "Test API", operationCount: 3 });
    // The same thing as text, for clients that only read that.
    expect(JSON.parse(textOf(connected))).toMatchObject({ id: project.id });

    const detail = structured<{ operations: Array<{ key: string; tags: string[] }> }>(
      await client.callTool({ name: "get_project", arguments: { projectId: project.id } }),
    );
    expect(detail.operations.map((operation) => operation.key)).toEqual([
      "GET /pets",
      "POST /pets",
      "POST /internal/flush",
    ]);
    const internal = structured<{ operations: Array<{ key: string }> }>(
      await client.callTool({
        name: "get_project",
        arguments: { projectId: project.id, tag: "internal" },
      }),
    );
    expect(internal.operations.map((operation) => operation.key)).toEqual(["POST /internal/flush"]);
    const searched = structured<{ operations: Array<{ key: string }> }>(
      await client.callTool({
        name: "get_project",
        arguments: { projectId: project.id, search: "get /p" },
      }),
    );
    expect(searched.operations.map((operation) => operation.key)).toEqual(["GET /pets"]);

    const variant = structured<{ id: string; url: string; keptOperations: number }>(
      await client.callTool({
        name: "create_variant",
        arguments: {
          projectId: project.id,
          name: "Public docs",
          selection: { mode: "include", operations: [], tags: ["pets"] },
        },
      }),
    );
    expect(variant.keptOperations).toBe(2);
    expect(variant.url).toBe(`${ORIGIN}/v/test/public-docs`);

    // The URL the tool hands out is the one that serves the document.
    const served = await call(variant.url);
    expect(served.status).toBe(200);
    const document = (await served.json()) as { paths: object; components: { schemas: object } };
    expect(Object.keys(document.paths)).toEqual(["/pets"]);
    expect(Object.keys(document.components.schemas)).toEqual(["Pet"]);

    const narrowed = structured<{ keptOperations: number }>(
      await client.callTool({
        name: "update_variant",
        arguments: {
          variantId: variant.id,
          selection: { mode: "include", operations: ["GET /pets"], tags: [] },
        },
      }),
    );
    expect(narrowed.keptOperations).toBe(1);

    const listed = structured<{ variants: Array<{ id: string }> }>(
      await client.callTool({ name: "list_variants", arguments: { projectId: project.id } }),
    );
    expect(listed.variants.map((each) => each.id)).toEqual([variant.id]);

    const checked = structured<{ changed: boolean }>(
      await client.callTool({ name: "check_project", arguments: { projectId: project.id } }),
    );
    expect(checked.changed).toBe(false);

    await client.callTool({ name: "delete_variant", arguments: { variantId: variant.id } });
    expect((await call(variant.url)).status).toBe(404);
    await client.close();
  });

  it("reports what the API refuses as a result the model can read", async () => {
    const { token } = await person();
    const client = await connect(token, mode);
    const project = structured<{ id: string }>(
      await client.callTool({ name: "connect_project", arguments: { url: SPEC_URL } }),
    );
    const create = (slug: string) =>
      client.callTool({
        name: "create_variant",
        arguments: {
          projectId: project.id,
          name: "Docs",
          slug,
          selection: { mode: "exclude", operations: [], tags: [] },
        },
      });
    expect((await create("docs")).isError).toBeFalsy();

    const taken = await create("docs");
    expect(taken.isError).toBe(true);
    expect(textOf(taken)).toContain("already used");

    const invalid = await create("Not A Slug");
    expect(invalid.isError).toBe(true);

    const missing = await client.callTool({ name: "get_variant", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('"variantId" is required');

    // A tool that does not exist is the caller's mistake, not a result.
    await expect(client.callTool({ name: "drop_everything", arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );
    await client.close();
  });

  it("keeps workspaces apart", async () => {
    const ada = await person("ada@example.com");
    const adasProject = await createProject(ada.cookie);
    const bob = await person("bob@example.com");
    const client = await connect(bob.token, mode);

    expect(
      structured<{ projects: unknown[] }>(await client.callTool({ name: "list_projects" }))
        .projects,
    ).toEqual([]);
    for (const [name, args] of [
      ["get_project", { projectId: adasProject.id }],
      ["check_project", { projectId: adasProject.id }],
      ["delete_project", { projectId: adasProject.id }],
      [
        "create_variant",
        {
          projectId: adasProject.id,
          name: "Mine now",
          selection: { mode: "exclude", operations: [], tags: [] },
        },
      ],
    ] as const) {
      const refused = await client.callTool({ name, arguments: args });
      expect(refused.isError, name).toBe(true);
      expect(textOf(refused)).toContain("not found");
    }
    // Still there for its owner.
    expect(
      (await call(`/api/projects/${adasProject.id}`, { headers: { cookie: ada.cookie } })).status,
    ).toBe(200);
    await client.close();
  });

  it("does not let anyone in without a valid token", async () => {
    await expect(connect(`oap_${"0".repeat(40)}`, mode)).rejects.toThrow();
  });
});

describe("the wire, as the specification writes it", () => {
  const post = (token: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
    callAsProgram("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? bearer(token) : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const modern = (method: string, params: object = {}) => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "ExampleClient", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
  const modernHeaders = (method: string, name?: string) => ({
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
  });

  it("asks for a token, the way HTTP asks", async () => {
    const response = await post(undefined, modern("tools/list"), modernHeaders("tools/list"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("only accepts POST", async () => {
    const { token } = await person();
    for (const method of ["GET", "DELETE"]) {
      const response = await callAsProgram("/mcp", { method, headers: bearer(token) });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("turns away pages on other sites", async () => {
    const { token } = await person();
    const response = await post(token, modern("tools/list"), {
      ...modernHeaders("tools/list"),
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
  });

  it("describes itself to server/discover", async () => {
    const { token } = await person();
    const response = await post(token, modern("server/discover"), modernHeaders("server/discover"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"],
        capabilities: { tools: {} },
        cacheScope: "public",
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "openapi-proxy" } },
      },
    });
  });

  it("marks results complete and cacheable where the revision requires it", async () => {
    const { token } = await person();
    const listed = (await (
      await post(token, modern("tools/list"), modernHeaders("tools/list"))
    ).json()) as {
      result: { resultType: string; ttlMs: number; cacheScope: string; tools: object[] };
    };
    expect(listed.result).toMatchObject({ resultType: "complete", cacheScope: "public" });
    expect(listed.result.ttlMs).toBeGreaterThan(0);
    expect(listed.result.tools).toHaveLength(12);

    const called = (await (
      await post(
        token,
        modern("tools/call", { name: "list_projects", arguments: {} }),
        modernHeaders("tools/call", "list_projects"),
      )
    ).json()) as { result: object };
    expect(called.result).toMatchObject({
      resultType: "complete",
      isError: false,
      structuredContent: { projects: [] },
    });
  });

  it("rejects headers that disagree with the body", async () => {
    const { token } = await person();
    const cases: Array<[object, Record<string, string>]> = [
      [modern("tools/list"), { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call" }],
      [modern("tools/list"), { "mcp-protocol-version": "2025-11-25", "mcp-method": "tools/list" }],
      [modern("tools/list"), { "mcp-method": "tools/list" }],
      [modern("tools/list"), { "mcp-protocol-version": "2026-07-28" }],
      [
        modern("tools/call", { name: "list_projects", arguments: {} }),
        modernHeaders("tools/call", "delete_project"),
      ],
      [modern("tools/call", { name: "list_projects", arguments: {} }), modernHeaders("tools/call")],
    ];
    for (const [body, headers] of cases) {
      const response = await post(token, body, headers);
      expect(response.status, JSON.stringify(headers)).toBe(400);
      expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32020);
    }
    // A name that is not plain ASCII travels base64-encoded, and is decoded before it is compared.
    const encoded = await post(
      token,
      modern("tools/call", { name: "list_projects", arguments: {} }),
      modernHeaders("tools/call", `=?base64?${btoa("list_projects")}?=`),
    );
    expect(encoded.status).toBe(200);
  });

  it("names the versions it speaks when asked for one it does not", async () => {
    const { token } = await person();
    const body = modern("tools/list");
    (body.params._meta as Record<string, unknown>)["io.modelcontextprotocol/protocolVersion"] =
      "1900-01-01";
    const response = await post(token, body, {
      "mcp-protocol-version": "1900-01-01",
      "mcp-method": "tools/list",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: -32022,
        data: { requested: "1900-01-01", supported: expect.arrayContaining(["2026-07-28"]) },
      },
    });
  });

  it("answers an unknown method with 404 in the stateless revision, and 200 in the handshake ones", async () => {
    const { token } = await person();
    const now = await post(token, modern("resources/list"), modernHeaders("resources/list"));
    expect(now.status).toBe(404);
    expect(((await now.json()) as { error: { code: number } }).error.code).toBe(-32601);

    const then = await post(token, { jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(then.status).toBe(200);
    expect(await then.json()).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("speaks the handshake: initialize, initialized, ping, and several messages at once", async () => {
    const { token } = await person();
    const initialize = (protocolVersion: string) =>
      post(token, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "ExampleClient", version: "1.0.0" },
        },
      });
    const opened = await initialize("2025-06-18");
    expect(opened.status).toBe(200);
    expect(opened.headers.get("mcp-session-id")).toBeNull();
    expect(await opened.json()).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "openapi-proxy" },
      },
    });
    // A version from this era that we do not know: we answer with our newest of the era.
    expect(await (await initialize("2025-01-01")).json()).toMatchObject({
      result: { protocolVersion: "2025-11-25" },
    });

    const acknowledged = await post(
      token,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { "mcp-protocol-version": "2025-06-18" },
    );
    expect(acknowledged.status).toBe(202);
    expect(await acknowledged.text()).toBe("");

    const ping = await post(token, { jsonrpc: "2.0", id: "p", method: "ping" });
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: "p", result: {} });

    const batch = await post(token, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    const answers = (await batch.json()) as Array<{ id: number; result: { tools?: object[] } }>;
    expect(answers.map((each) => each.id)).toEqual([1, 2]);
    expect(answers[1]?.result.tools).toHaveLength(12);
  });

  it("takes a handful of messages in one request, not hundreds", async () => {
    const { cookie, token } = await person();
    const project = await createProject(cookie);
    const before = callsTo("GET", SPEC_URL);
    const flood = await post(
      token,
      Array.from({ length: 200 }, (_, id) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "check_project", arguments: { projectId: project.id } },
      })),
    );
    expect(flood.status).toBe(400);
    expect(await flood.json()).toMatchObject({ error: { code: -32600 } });
    expect(callsTo("GET", SPEC_URL)).toBe(before);
  });

  it("says so when it cannot read the request", async () => {
    const { token } = await person();
    const garbage = await post(token, "{ not json");
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ id: null, error: { code: -32700 } });

    const shapeless = await post(token, { hello: "world" });
    expect(shapeless.status).toBe(400);
    expect(await shapeless.json()).toMatchObject({ error: { code: -32600 } });
  });
});
