import { describe, expect, it } from "vitest";
import { call, createVariant, googleLogin, json, SPEC, serveSpec, sql } from "./harness";

const FREE = { DEFAULT_PLAN: "free" };
const url = (n: number) => `https://api.example.com/openapi-${n}.json`;

async function connect(cookie: string, n: number, bindings = {}) {
  serveSpec(SPEC, {}, url(n));
  return call("/api/projects", json("POST", { url: url(n) }, cookie), bindings);
}
const variant = (cookie: string, projectId: string, name: string, bindings = {}) =>
  call(
    "/api/variants",
    json(
      "POST",
      { projectId, name, selection: { mode: "include", operations: [], tags: ["pets"] } },
      cookie,
    ),
    bindings,
  );

describe("without plans (a self-hosted instance)", () => {
  it("has room for many documents and variants", async () => {
    const cookie = await googleLogin("ada@example.com");
    for (let n = 1; n <= 4; n++) expect((await connect(cookie, n)).status).toBe(201);
    const [project] = (await (
      await call("/api/projects", { headers: { cookie } })
    ).json()) as Array<{
      id: string;
    }>;
    for (let n = 0; n < 16; n++)
      await createVariant(cookie, project?.id as string, { name: `V${n}` });

    const me = (await (await call("/api/me", { headers: { cookie } })).json()) as {
      plan: string;
      limits: Record<string, number | null>;
    };
    expect(me).toMatchObject({ plan: "pro", limits: { projects: 100, variants: null } });
  });
});

describe("on the free plan", () => {
  it("includes three documents, and says so when a fourth is connected", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    for (let n = 1; n <= 3; n++) expect((await connect(cookie, n, FREE)).status).toBe(201);
    const fourth = await connect(cookie, 4, FREE);
    expect(fourth.status).toBe(402);
    expect(await fourth.json()).toMatchObject({ code: "plan-limit", plan: "free" });
  });

  it("includes fifteen variants across the workspace", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    const first = (await (await connect(cookie, 1, FREE)).json()) as { id: string };
    const second = (await (await connect(cookie, 2, FREE)).json()) as { id: string };
    for (let n = 0; n < 15; n++) {
      const project = n % 2 === 0 ? first : second;
      expect((await variant(cookie, project.id, `V${n}`, FREE)).status).toBe(201);
    }
    const sixteenth = await variant(cookie, first.id, "One more", FREE);
    expect(sixteenth.status).toBe(402);
    expect(((await sixteenth.json()) as { error: string }).error).toContain("15 variants");

    const workspace = (await (
      await call("/api/workspace", { headers: { cookie } }, FREE)
    ).json()) as { usage: object; limits: object; plansEnabled: boolean };
    expect(workspace).toMatchObject({
      plansEnabled: true,
      usage: { projects: 2, variants: 15 },
      limits: { projects: 3, variants: 15 },
    });
  });

  it("is lifted by putting the workspace on Pro, which is one statement", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    for (let n = 1; n <= 3; n++) await connect(cookie, n, FREE);
    expect((await connect(cookie, 4, FREE)).status).toBe(402);

    await sql("UPDATE organization SET plan = 'pro'");
    expect((await connect(cookie, 4, FREE)).status).toBe(201);
  });

  it("does not let one workspace's plan leak into another", async () => {
    const ada = await googleLogin("ada@example.com", "Ada", FREE);
    await sql("UPDATE organization SET plan = 'pro'");
    for (let n = 1; n <= 4; n++) expect((await connect(ada, n, FREE)).status).toBe(201);

    const bob = await googleLogin("bob@example.com", "Bob", FREE);
    for (let n = 11; n <= 13; n++) expect((await connect(bob, n, FREE)).status).toBe(201);
    expect((await connect(bob, 14, FREE)).status).toBe(402);
  });
});
