import { describe, expect, it } from "vitest";
import {
  bearer,
  call,
  callAsProgram,
  callsTo,
  createKey,
  createProject,
  googleLogin,
  json,
  mainSource,
  SPEC,
  SPEC_URL,
  serveSpec,
} from "./harness";

/**
 * The budget of API requests each workspace has. Cloudflare's rate limiter
 * does the counting in production; here a stand-in does, so that a test can
 * see what was charged, to whom.
 */
function limiter(limit = 300) {
  const used = new Map<string, number>();
  const charges: Array<{ key: string; delta: number }> = [];
  const binding = {
    limit: async ({ key, delta = 1 }: { key: string; delta?: number }) => {
      const before = used.get(key) ?? 0;
      used.set(key, before + delta);
      charges.push({ key, delta });
      // As the real one: allowed while the count is below the limit.
      return { success: before < limit };
    },
  };
  const spent = () => charges.reduce((sum, charge) => sum + charge.delta, 0);
  return { bindings: { API_RATE_LIMIT: binding } as object, charges, used, spent };
}

const BILLING_URL = "https://billing.example.com/openapi.json";

describe("a workspace's budget of requests", () => {
  it("is spent one request at a time, and then the answer is 429", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const { bindings } = limiter(5);
    const list = () => call("/api/projects", { headers: { cookie: ada } }, bindings);
    for (let n = 0; n < 5; n++) expect((await list()).status).toBe(200);

    const refused = await list();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toMatchObject({ code: "rate-limited" });
  });

  it("charges ten for a request that makes the instance fetch a source", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    serveSpec();
    serveSpec({ ...SPEC, info: { title: "Billing API", version: "1" } }, {}, BILLING_URL);
    const meter = limiter();
    const priced = async (path: string, init: RequestInit) => {
      const before = meter.spent();
      const response = await call(path, init, meter.bindings);
      expect(response.status, await response.clone().text()).toBeLessThan(300);
      return { cost: meter.spent() - before, response };
    };

    const connected = await priced(
      "/api/projects",
      json("POST", { url: "https://api.example.com/openapi.json" }, ada),
    );
    expect(connected.cost).toBe(10);
    const project = (await connected.response.json()) as { id: string; sources: [{ id: string }] };
    const at = `/api/projects/${project.id}`;

    expect((await priced(`${at}/check`, { method: "POST", headers: { cookie: ada } })).cost).toBe(
      10,
    );
    expect((await priced(`${at}/sources`, json("POST", { url: BILLING_URL }, ada))).cost).toBe(10);
    expect(
      (await priced(`${at}/sources/${project.sources[0].id}`, json("PATCH", { headers: [] }, ada)))
        .cost,
    ).toBe(10);

    // Everything else costs one.
    expect((await priced(at, { headers: { cookie: ada } })).cost).toBe(1);
    expect((await priced(at, json("PATCH", { name: "Renamed" }, ada))).cost).toBe(1);
    expect((await priced("/api/variants", { headers: { cookie: ada } })).cost).toBe(1);
  });

  it("belongs to the workspace: tokens and agents spend from it, other workspaces do not", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const bob = await googleLogin("bob@example.com", "Bob");
    serveSpec();
    const project = await createProject(ada);
    const { key: token } = await createKey(ada);
    const meter = limiter(4);

    // A session and a token are one budget.
    await call("/api/projects", { headers: { cookie: ada } }, meter.bindings);
    await callAsProgram("/api/projects", { headers: bearer(token) }, meter.bindings);
    await call(`/api/projects/${project.id}`, { headers: { cookie: ada } }, meter.bindings);
    await callAsProgram(`/api/projects/${project.id}`, { headers: bearer(token) }, meter.bindings);
    expect(new Set(meter.charges.map((charge) => charge.key)).size).toBe(1);
    expect(meter.spent()).toBe(4);

    // Ada's workspace is out of budget, by any door.
    expect((await call("/api/projects", { headers: { cookie: ada } }, meter.bindings)).status).toBe(
      429,
    );
    expect(
      (await callAsProgram("/api/projects", { headers: bearer(token) }, meter.bindings)).status,
    ).toBe(429);
    // Bob's is untouched.
    expect((await call("/api/projects", { headers: { cookie: bob } }, meter.bindings)).status).toBe(
      200,
    );
  });

  it("is not spent by signing in, by a request that is refused, or by reading a public document", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    serveSpec();
    const project = await createProject(ada);
    await call(
      "/api/variants",
      json(
        "POST",
        {
          projectId: project.id,
          name: "Public",
          selection: {},
        },
        ada,
      ),
    );
    const meter = limiter();
    await call("/api/auth-config", {}, meter.bindings);
    await call("/api/projects", {}, meter.bindings); // nobody signed in: 401
    await callAsProgram("/api/projects", { headers: bearer("oap_nonsense") }, meter.bindings);
    const served = await call(`/v/${project.slug}/public.json`, {}, meter.bindings);
    expect(served.status).toBe(200);
    expect(meter.charges).toEqual([]);
    expect(mainSource(project).url).toBeTruthy();
  });

  it("does not take the API down when the limiter itself fails, but stops fetching for anyone", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    serveSpec();
    const project = await createProject(ada);
    const broken = {
      API_RATE_LIMIT: {
        limit: async () => {
          throw new Error("unavailable");
        },
      },
    } as object;
    // Reading and editing go on.
    expect((await call("/api/projects", { headers: { cookie: ada } }, broken)).status).toBe(200);
    expect(
      (await call(`/api/projects/${project.id}`, json("PATCH", { name: "Renamed" }, ada), broken))
        .status,
    ).toBe(200);

    // What would make the instance fetch a URL does not, with nothing counting it.
    const before = callsTo("GET", SPEC_URL);
    const refresh = await call(
      `/api/projects/${project.id}/check`,
      { method: "POST", headers: { cookie: ada } },
      broken,
    );
    expect(refresh.status).toBe(429);
    const connect = await call(
      "/api/projects",
      json("POST", { url: "https://elsewhere.example.com/openapi.json" }, ada),
      broken,
    );
    expect(connect.status).toBe(429);
    expect(callsTo("GET", SPEC_URL)).toBe(before);
  });
});
