import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/server/db/client";
import { claimDue } from "../src/server/scheduled";
import {
  type ApiProject,
  call,
  callsTo,
  createProject,
  createVariant,
  login,
  MAIL,
  mailbox,
  publish,
  rows,
  runTimer,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  upstream,
} from "./harness";

const MINUTE = 60_000;
const project = async (cookie: string, id: string) =>
  (await (await call(`/api/projects/${id}`, { headers: { cookie } })).json()) as ApiProject;
/** In how many minutes the timer looks at the project next. */
async function nextCheckIn(id: string): Promise<number> {
  const [row] = await rows<{ next_check_at: number }>(
    "SELECT next_check_at FROM projects WHERE id = ?",
    id,
  );
  return ((row?.next_check_at ?? Number.NaN) - Date.now()) / MINUTE;
}
/** Make every project due, as if its time had come. */
const due = () => sql("UPDATE projects SET next_check_at = ?", Date.now() - 1);
const check = (cookie: string, id: string) =>
  call(`/api/projects/${id}/check`, { method: "POST", headers: { cookie } });

describe("how often the timer looks at a source", () => {
  it("is about hourly for a source that has to send its whole document", async () => {
    const { project: created } = await publish();
    const minutes = await nextCheckIn(created.id);
    expect(minutes).toBeGreaterThan(50);
    expect(minutes).toBeLessThanOrEqual(60);
  });

  it("is every run for a source that can say that nothing changed", async () => {
    const { cookie, project: created } = await publish();
    serveSpec(SPEC, { etag: '"v1"' });
    await check(cookie, created.id);
    const minutes = await nextCheckIn(created.id);
    expect(minutes).toBeGreaterThan(3);
    expect(minutes).toBeLessThanOrEqual(5);
  });

  it("is as rare as the costliest source of a project", async () => {
    const cookie = await login();
    const cheap = "https://api.example.com/cheap.json";
    serveSpec(SPEC, { etag: '"a"' }, cheap);
    const billing = {
      openapi: "3.1.0",
      info: { title: "Billing", version: "1" },
      paths: { "/invoices": { get: { responses: { "200": { description: "ok" } } } } },
    };
    serveSpec(billing);
    const created = await createProject(cookie, { sources: [{ url: cheap }, { url: SPEC_URL }] });
    await check(cookie, created.id);
    expect(await nextCheckIn(created.id)).toBeGreaterThan(50);
  });

  it("comes back to a source that just failed at the next run, and to one that keeps failing hourly", async () => {
    const { cookie, project: created } = await publish();
    upstream("GET", SPEC_URL, () => new Response("boom", { status: 500 }));

    await check(cookie, created.id);
    expect(await nextCheckIn(created.id)).toBeLessThanOrEqual(5);

    await check(cookie, created.id);
    expect(await nextCheckIn(created.id)).toBeGreaterThan(50);
  });
});

describe("a run of the timer", () => {
  it("notices a change nobody asked about, and says so", async () => {
    const { googleLogin } = await import("./harness");
    const cookie = await googleLogin("ada@example.com", "Ada");
    serveSpec();
    const created = await createProject(cookie);
    await createVariant(cookie, created.id);
    const sent = mailbox();
    const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
    next.paths["/owners"] = {
      get: { tags: ["pets"], responses: { "200": { description: "ok" } } },
    };
    serveSpec(next);
    await due();

    await runTimer({ ...MAIL, APP_URL: "https://proxy.example.com/" });

    expect((await project(cookie, created.id)).operations.map((op) => op.key)).toContain(
      "GET /owners",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(`https://proxy.example.com/p/${created.id}`);
  });

  it("leaves alone what is not due and what nobody serves anything from", async () => {
    const { cookie } = await publish();
    const before = callsTo("GET", SPEC_URL);
    await runTimer(); // checked a moment ago
    expect(callsTo("GET", SPEC_URL)).toBe(before);

    const other = "https://api.example.com/unused.json";
    serveSpec(SPEC, {}, other);
    await createProject(cookie, { url: other });
    await due();
    const unusedBefore = callsTo("GET", other);
    await runTimer();
    expect(callsTo("GET", other)).toBe(unusedBefore);
    expect(callsTo("GET", SPEC_URL)).toBe(before + 1);
  });

  it("checks a project once when two runs come at the same time", async () => {
    await publish();
    await due();
    const before = callsTo("GET", SPEC_URL);
    await Promise.all([runTimer(), runTimer()]);
    expect(callsTo("GET", SPEC_URL)).toBe(before + 1);
  });

  it("gives a project to one of two runs that both saw it as due", async () => {
    const { project: created } = await publish();
    const seen = Date.now() - 1;
    await sql("UPDATE projects SET next_check_at = ?", seen);
    const db = createDb(env.DB);
    const taken = await Promise.all([
      claimDue(db, created.id, seen, Date.now()),
      claimDue(db, created.id, seen, Date.now()),
    ]);
    expect(taken.filter(Boolean)).toHaveLength(1);
  });

  it("records a failing source and moves on", async () => {
    const { cookie, project: created } = await publish();
    const sent = mailbox();
    await due();
    serveSpec("not json at all");
    await runTimer(MAIL);
    expect(await project(cookie, created.id)).toMatchObject({ lastStatus: "error" });
    expect(sent).toEqual([]);
  });

  it("is not held up by sources that are down: everyone gets their turn", async () => {
    const cookie = await login();
    const connect = async (url: string) => {
      serveSpec(SPEC, {}, url);
      const created = await createProject(cookie, { url });
      await createVariant(cookie, created.id);
      return created;
    };
    // More broken projects than one run takes, all due for longer than the healthy one.
    const dead = Array.from({ length: 62 }, (_, n) => `https://dead-${n}.example.com/openapi.json`);
    for (const url of dead) await connect(url);
    const healthy = "https://healthy.example.com/openapi.json";
    const last = await connect(healthy);
    for (const url of dead) upstream("GET", url, () => new Response("down", { status: 500 }));
    await sql("UPDATE projects SET next_check_at = ?", Date.now() - 60 * MINUTE);
    await sql("UPDATE projects SET next_check_at = ? WHERE id = ?", Date.now() - MINUTE, last.id);

    const before = callsTo("GET", healthy);
    await runTimer();
    // The first run goes to the sixty that have been due longest, and all of them fail.
    expect(callsTo("GET", healthy)).toBe(before);
    // They are not due again at once, so the next run reaches the rest.
    await runTimer();
    expect(callsTo("GET", healthy)).toBe(before + 1);
  });

  it("stores a limited number of new documents and leaves the rest for the next run", async () => {
    const cookie = await login();
    // More than a run stores, with room for the checks already under way when it stops.
    const urls = Array.from({ length: 16 }, (_, n) => `https://api-${n}.example.com/openapi.json`);
    for (const url of urls) {
      serveSpec(SPEC, {}, url);
      const created = await createProject(cookie, { url });
      await createVariant(cookie, created.id);
    }
    const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
    next.paths["/owners"] = {
      get: { tags: ["pets"], responses: { "200": { description: "ok" } } },
    };
    for (const url of urls) serveSpec(next, {}, url);
    const changed = async () =>
      (
        await rows<{ n: number }>(
          "SELECT count(*) AS n FROM projects WHERE op_index LIKE '%/owners%'",
        )
      )[0]?.n;

    await due();
    await runTimer();
    const first = (await changed()) as number;
    expect(first).toBeGreaterThanOrEqual(8);
    expect(first).toBeLessThan(16);
    await runTimer();
    expect(await changed()).toBe(16);
  });
});
