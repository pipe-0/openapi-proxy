import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/server/db/client";
import { claimDue } from "../src/server/scheduled";
import {
  applied,
  apply,
  call,
  callsTo,
  createKey,
  createProject,
  definitionOf,
  deploy,
  document,
  getProject,
  googleLogin,
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
/** In how many minutes the timer looks at the project next. NaN: never. */
async function nextCheckIn(slug = "test"): Promise<number> {
  const [row] = await rows<{ next_check_at: number | null }>(
    "SELECT next_check_at FROM projects WHERE slug = ?",
    slug,
  );
  return ((row?.next_check_at ?? Number.NaN) - Date.now()) / MINUTE;
}
/** Make every project that is checked at all due, as if its time had come. */
const due = () =>
  sql("UPDATE projects SET next_check_at = ? WHERE next_check_at IS NOT NULL", Date.now() - 1);
const check = (cookie: string, slug = "test") =>
  call(`/api/projects/${slug}/check`, { method: "POST", headers: { cookie } });
/** The main fixture with one more path. */
const withOwners = () => {
  const next = structuredClone(SPEC) as typeof SPEC & { paths: Record<string, unknown> };
  next.paths["/owners"] = {
    get: { tags: ["pets"], responses: { "200": { description: "ok" } } },
  };
  return next;
};

describe("how often the timer looks at a source", () => {
  it("is about hourly for a source that has to send its whole document", async () => {
    await publish();
    const minutes = await nextCheckIn();
    expect(minutes).toBeGreaterThan(50);
    expect(minutes).toBeLessThanOrEqual(60);
  });

  it("is every run for a source that can say that nothing changed", async () => {
    serveSpec(SPEC, { etag: '"v1"' });
    await publish({ serve: false });
    const minutes = await nextCheckIn();
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
    await createProject(cookie, {
      sources: [
        { name: "cheap", url: cheap, follow: true, main: true },
        { name: "billing", url: SPEC_URL, follow: true },
      ],
    });
    await check(cookie);
    expect(await nextCheckIn()).toBeGreaterThan(50);
  });

  it("comes back to a source that just failed at the next run, and to one that keeps failing hourly", async () => {
    const { cookie } = await publish();
    upstream("GET", SPEC_URL, () => new Response("boom", { status: 500 }));

    await check(cookie);
    expect(await nextCheckIn()).toBeLessThanOrEqual(5);

    await check(cookie);
    expect(await nextCheckIn()).toBeGreaterThan(50);
  });

  it("is never for a project whose documents are uploaded, or one that stops following", async () => {
    const cookie = await login();
    const uploaded = definitionOf({ sources: [{ file: "openapi.json" }], variants: { all: {} } });
    await applied(apply(cookie, uploaded, { documents: { main: document() } }));
    expect(await nextCheckIn()).toBeNaN();
    await sql("UPDATE projects SET next_check_at = 0");
    await runTimer();
    expect(await nextCheckIn()).toBeNaN();

    // A source that is followed is checked, until the definition stops saying so.
    serveSpec();
    const followed = definitionOf({ project: "second", variants: { all: {} } });
    await applied(apply(cookie, followed));
    expect(await nextCheckIn("second")).toBeGreaterThan(50);
    await applied(apply(cookie, { ...followed, sources: [{ url: SPEC_URL }] }));
    expect(await nextCheckIn("second")).toBeNaN();
    const before = callsTo("GET", SPEC_URL);
    await sql("UPDATE projects SET next_check_at = 0");
    await runTimer();
    expect(callsTo("GET", SPEC_URL)).toBe(before);
  });
});

describe("after a deploy to a project with a followed source", () => {
  /** A project deployed from a file whose one source the service follows. */
  async function deployed() {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const { key } = await createKey(cookie);
    const definition = definitionOf({ variants: { public: {} } });
    await applied(deploy(key, definition, { documents: { main: document() } }));
    return { cookie, key, definition };
  }
  const watching = async () =>
    (await rows<{ watch_until: number | null }>("SELECT watch_until FROM projects"))[0]
      ?.watch_until ?? null;

  it("the timer looks at every run for a quarter of an hour, because the API is about to change", async () => {
    await deployed();
    // The deploy uploaded what the pipeline read. The service has not asked yet.
    expect(callsTo("GET", SPEC_URL)).toBe(0);
    expect(await nextCheckIn()).toBeLessThanOrEqual(0);
    expect(((await watching()) as number) - Date.now()).toBeGreaterThan(14 * MINUTE);

    // The API is not live yet: the document is still the old one.
    serveSpec();
    await runTimer();
    expect(callsTo("GET", SPEC_URL)).toBe(1);
    // A source without validators is otherwise looked at hourly. Not now.
    expect(await nextCheckIn()).toBeLessThanOrEqual(5);
    expect(await watching()).not.toBeNull();

    await due();
    await runTimer();
    expect(callsTo("GET", SPEC_URL)).toBe(2);
    expect(await nextCheckIn()).toBeLessThanOrEqual(5);
  });

  it("the first new document ends that, and the usual pace returns", async () => {
    const { cookie } = await deployed();
    serveSpec(withOwners());
    await runTimer();
    expect((await getProject(cookie)).state.operations.map((op) => op.key)).toContain(
      "GET /owners",
    );
    expect(await watching()).toBeNull();
    expect(await nextCheckIn()).toBeGreaterThan(50);
  });

  it("so does the quarter of an hour running out", async () => {
    await deployed();
    serveSpec();
    await sql("UPDATE projects SET watch_until = ?", Date.now() - 1);
    await runTimer();
    expect(await nextCheckIn()).toBeGreaterThan(50);
  });

  it("a save in the app opens no such window", async () => {
    const { cookie } = await publish();
    expect(await watching()).toBeNull();
    await applied(apply(cookie, definitionOf({ name: "Renamed", variants: { public: {} } })));
    expect(await watching()).toBeNull();
    expect(await nextCheckIn()).toBeGreaterThan(50);
  });
});

describe("a run of the timer", () => {
  it("notices a change nobody asked about, and says so", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    serveSpec();
    await createProject(cookie, { variants: { public: {} } });
    const sent = mailbox();
    serveSpec(withOwners());
    await due();

    await runTimer({ ...MAIL, APP_URL: "https://proxy.example.com/" });

    expect((await getProject(cookie)).state.operations.map((op) => op.key)).toContain(
      "GET /owners",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("https://proxy.example.com/p/test");
  });

  it("leaves alone what is not due and what nobody serves anything from", async () => {
    const { cookie } = await publish();
    const before = callsTo("GET", SPEC_URL);
    await runTimer(); // checked a moment ago
    expect(callsTo("GET", SPEC_URL)).toBe(before);

    const other = "https://api.example.com/unused.json";
    serveSpec(SPEC, {}, other);
    await createProject(cookie, { project: "unused", sources: [{ url: other, follow: true }] });
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
    await publish();
    const seen = Date.now() - 1;
    await sql("UPDATE projects SET next_check_at = ?", seen);
    const [{ id } = { id: "" }] = await rows<{ id: string }>("SELECT id FROM projects");
    const db = createDb(env.DB);
    const taken = await Promise.all([
      claimDue(db, id, seen, Date.now()),
      claimDue(db, id, seen, Date.now()),
    ]);
    expect(taken.filter(Boolean)).toHaveLength(1);
  });

  it("records a failing source and moves on", async () => {
    const { cookie } = await publish();
    const sent = mailbox();
    await due();
    serveSpec("not json at all");
    await runTimer(MAIL);
    expect((await getProject(cookie)).state.check).toMatchObject({ lastStatus: "error" });
    expect(sent).toEqual([]);
  });

  it("is not held up by sources that are down: everyone gets their turn", async () => {
    const cookie = await login();
    const connect = async (slug: string, url: string) => {
      serveSpec(SPEC, {}, url);
      await applied(
        apply(
          cookie,
          definitionOf({
            project: slug,
            sources: [{ url, follow: true }],
            variants: { public: {} },
          }),
        ),
      );
    };
    // More broken projects than one run takes, all due for longer than the healthy one.
    const dead = Array.from({ length: 62 }, (_, n) => `https://dead-${n}.example.com/openapi.json`);
    for (const [n, url] of dead.entries()) await connect(`dead-${n}`, url);
    const healthy = "https://healthy.example.com/openapi.json";
    await connect("healthy", healthy);
    for (const url of dead) upstream("GET", url, () => new Response("down", { status: 500 }));
    await sql("UPDATE projects SET next_check_at = ?", Date.now() - 60 * MINUTE);
    await sql("UPDATE projects SET next_check_at = ? WHERE slug = 'healthy'", Date.now() - MINUTE);

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
    for (const [n, url] of urls.entries()) {
      serveSpec(SPEC, {}, url);
      await applied(
        apply(
          cookie,
          definitionOf({
            project: `api-${n}`,
            sources: [{ url, follow: true }],
            variants: { public: {} },
          }),
        ),
      );
    }
    for (const url of urls) serveSpec(withOwners(), {}, url);
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
