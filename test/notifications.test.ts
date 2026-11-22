import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { scheduled } from "../src/server/scheduled";
import {
  type ApiProject,
  call,
  callsTo,
  createProject,
  createVariant,
  googleLogin,
  json,
  login,
  MAIL,
  MAIL_URL,
  mailbox,
  SPEC,
  SPEC_URL,
  serveSpec,
  sql,
  upstream,
} from "./harness";

type Spec = typeof SPEC & { paths: Record<string, Record<string, unknown>> };
const DAY = 24 * 60 * 60 * 1000;

/** The fixture with: a new operation, a changed schema behind GET /pets, and POST /internal/flush gone. */
function nextRelease(): Spec {
  const next = structuredClone(SPEC) as Spec;
  next.paths["/pets/{id}"] = {
    get: { tags: ["pets"], responses: { "200": { description: "one pet" } } },
  };
  next.paths["/audit"] = {
    get: { tags: ["internal"], responses: { "200": { description: "log" } } },
  };
  (next.components.schemas.Pet.properties as Record<string, unknown>).age = { type: "integer" };
  delete (next.paths as Record<string, unknown>)["/internal/flush"];
  return next;
}

/** Ada's project with one variant serving the `pets` tag. */
async function published(bindings = {}) {
  const cookie = await googleLogin("ada@example.com", "Ada", bindings);
  serveSpec();
  const project = await createProject(cookie);
  const variant = await createVariant(cookie, project.id, { name: "Public docs" });
  return { cookie, project, variant };
}
const refresh = async (cookie: string, id: string, bindings = {}) =>
  (await (
    await call(`/api/projects/${id}/check`, { method: "POST", headers: { cookie } }, bindings)
  ).json()) as { changed: boolean; addedOps: string[]; removedOps: string[]; changedOps: string[] };
/** What a person wants to be emailed about for one project. */
const setScope = (cookie: string, projectId: string, scope: string) =>
  call(`/api/projects/${projectId}/notifications`, json("PUT", { scope }, cookie));

describe("what changed", () => {
  it("is worked out per operation, including changes that arrive through a schema", async () => {
    const { cookie, project } = await published();
    expect(project.operations.every((entry) => typeof entry.fingerprint === "string")).toBe(true);

    serveSpec(nextRelease());
    expect(await refresh(cookie, project.id)).toMatchObject({
      changed: true,
      addedOps: ["GET /pets/{id}", "GET /audit"],
      removedOps: ["POST /internal/flush"],
      // Only GET /pets returns a Pet; POST /pets does not mention it.
      changedOps: ["GET /pets"],
    });
  });

  it("is nothing when only something unrelated moved", async () => {
    const { cookie, project } = await published();
    const next = structuredClone(SPEC);
    next.info.version = "2.0.0";
    (next.components.schemas.Secret.properties as Record<string, unknown>).extra = {
      type: "string",
    };
    serveSpec(next);
    expect(await refresh(cookie, project.id)).toMatchObject({
      changed: true,
      addedOps: [],
      removedOps: [],
      changedOps: [],
    });
  });
});

describe("fingerprints from before an upgrade of the engine", () => {
  it("are made again from the stored document, so a change that comes with the upgrade is reported as what it is", async () => {
    const { cookie, project } = await published();
    // As another version of the engine stored them: computed some other way.
    await sql(
      `UPDATE projects SET op_index = replace(op_index, '"fingerprint":"3:', '"fingerprint":"1:') WHERE id = ?`,
      project.id,
    );
    serveSpec(nextRelease());
    const result = await refresh(cookie, project.id);
    // Not every operation, as comparing old fingerprints with new ones would
    // say, and not none, as refusing to compare them would.
    expect(result.addedOps.sort()).toEqual(["GET /audit", "GET /pets/{id}"]);
    expect(result.removedOps).toEqual(["POST /internal/flush"]);
    expect(result.changedOps).toEqual(["GET /pets"]);
  });
});

describe("the email about it", () => {
  it("lists new operations, and changes and removals that touch what a variant serves", async () => {
    const { cookie, project } = await published();
    const sent = mailbox();
    serveSpec(nextRelease());
    await refresh(cookie, project.id, MAIL);

    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email?.to).toBe("ada@example.com");
    expect(email?.subject).toBe("Test API: 2 new, 1 changed");
    // Served by a rule the moment it appeared, and one that no variant has.
    expect(email?.text).toContain("GET /pets/{id}: served by Public docs");
    expect(email?.text).toContain("GET /audit: not in any variant yet");
    expect(email?.text).toContain("GET /pets: served by Public docs");
    // Nobody served POST /internal/flush, so its removal is not news at this setting.
    expect(email?.text).not.toContain("/internal/flush");
    expect(email?.text).toContain(`https://proxy.test/p/${project.id}`);
    expect(email?.text).not.toMatch(/—/);
  });

  it("covers everything in the source for someone who asked for that", async () => {
    const { cookie, project } = await published();
    await setScope(cookie, project.id, "all");
    const sent = mailbox();
    serveSpec(nextRelease());
    await refresh(cookie, project.id, MAIL);

    expect(sent[0]?.subject).toBe("Test API: 2 new, 1 changed, 1 removed");
    expect(sent[0]?.text).toContain("POST /internal/flush: was not served");
  });

  it("goes to each member at their own setting, and not to those who turned it off", async () => {
    const { cookie: ada, project } = await published();
    for (const [email, scope] of [
      ["bob@example.com", "all"],
      ["carol@example.com", "off"],
    ] as const) {
      const invitation = (await (
        await call("/api/workspace/invitations", json("POST", { email }, ada))
      ).json()) as { id: string };
      const cookie = await googleLogin(email);
      await call(`/api/invitations/${invitation.id}/accept`, {
        method: "POST",
        headers: { cookie },
      });
      await setScope(cookie, project.id, scope);
    }

    const sent = mailbox();
    serveSpec(nextRelease());
    await refresh(ada, project.id, MAIL);

    expect(sent.map((email) => email.to).sort()).toEqual(["ada@example.com", "bob@example.com"]);
    const to = (address: string) => sent.find((email) => email.to === address);
    expect(to("ada@example.com")?.subject).toBe("Test API: 2 new, 1 changed");
    expect(to("bob@example.com")?.subject).toBe("Test API: 2 new, 1 changed, 1 removed");
  });

  it("is not sent when nothing a person follows changed", async () => {
    const { cookie, project } = await published();
    const sent = mailbox();
    // Only an operation nobody serves changes.
    const next = structuredClone(SPEC) as Spec;
    (next.paths["/internal/flush"]?.post as Record<string, unknown>).summary = "Flush everything";
    serveSpec(next);
    await refresh(cookie, project.id, MAIL);
    expect(sent).toEqual([]);

    await setScope(cookie, project.id, "all");
    (next.paths["/internal/flush"]?.post as Record<string, unknown>).summary = "Flush it all";
    serveSpec(next);
    await refresh(cookie, project.id, MAIL);
    expect(sent.map((email) => email.subject)).toEqual(["Test API: 1 changed"]);
  });

  it("is sent once, whoever notices the change first", async () => {
    const { cookie, project, variant } = await published();
    const sent = mailbox();
    serveSpec(nextRelease());
    await sql("UPDATE projects SET fetched_at = ?", Date.now() - DAY);

    // A reader, a second reader, and someone pressing "Check now", all at once.
    await Promise.all([
      call(variant.path, undefined, MAIL),
      call(variant.path, undefined, MAIL),
      refresh(cookie, project.id, MAIL),
    ]);
    expect(sent).toHaveLength(1);
  });

  it("is not needed for anything: without an email provider, checks work the same", async () => {
    const { cookie, project } = await published();
    serveSpec(nextRelease());
    expect((await refresh(cookie, project.id)).changed).toBe(true);
    expect(callsTo("POST", MAIL_URL)).toBe(0);
  });

  it("reports a message as not sent when the provider would not take the address", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const answers: unknown[] = [
      // Taken, but the address is on the provider's list of addresses not to write to.
      {
        success: true,
        errors: [],
        result: { queued: [], permanent_bounces: [], suppressed_recipients: ["bob@example.com"] },
      },
      // Refused outright.
      { success: false, errors: [{ code: 10203, message: "sending disabled" }], result: null },
    ];
    let subject = "";
    upstream("POST", MAIL_URL, async (request) => {
      subject = ((await request.json()) as { subject: string }).subject;
      const answer = answers.shift() as { success: boolean };
      return Response.json(answer, { status: answer.success ? 200 : 403 });
    });
    for (const email of ["bob@example.com", "carol@example.com"]) {
      const invited = await call(
        "/api/workspace/invitations",
        json("POST", { email }, cookie),
        MAIL,
      );
      // The invitation exists either way, as a link to pass on.
      expect(invited.status).toBe(201);
      expect(await invited.json()).toMatchObject({ emailed: false });
    }
    expect(subject).not.toMatch(/[\r\n]/);
  });
});

describe("the hourly run", () => {
  async function run(bindings = {}) {
    const ctx = createExecutionContext();
    await scheduled({} as ScheduledController, { ...env, ...bindings }, ctx);
    await waitOnExecutionContext(ctx);
  }
  const project = async (cookie: string, id: string) =>
    (await (await call(`/api/projects/${id}`, { headers: { cookie } })).json()) as ApiProject;

  it("notices a change no reader has come by to trigger, and says so", async () => {
    const { cookie, project: created } = await published();
    const sent = mailbox();
    serveSpec(nextRelease());
    await sql("UPDATE projects SET fetched_at = ?", Date.now() - 2 * 60 * 60 * 1000);

    await run({ ...MAIL, APP_URL: "https://proxy.example.com/" });

    expect((await project(cookie, created.id)).operations.map((op) => op.key)).toContain(
      "GET /pets/{id}",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(`https://proxy.example.com/p/${created.id}`);
  });

  it("leaves alone what was checked recently and what nobody serves anything from", async () => {
    const { cookie } = await published();
    const before = callsTo("GET", SPEC_URL);
    await run(); // checked a moment ago
    expect(callsTo("GET", SPEC_URL)).toBe(before);

    const other = "https://api.example.com/unused.json";
    serveSpec(SPEC, {}, other);
    await createProject(cookie, { url: other });
    await sql("UPDATE projects SET fetched_at = ?", Date.now() - 2 * 60 * 60 * 1000);
    const unusedBefore = callsTo("GET", other);
    await run();
    expect(callsTo("GET", other)).toBe(unusedBefore);
    expect(callsTo("GET", SPEC_URL)).toBe(before + 1);
  });

  it("is not held up by sources that are down: everyone gets their turn", async () => {
    const cookie = await login();
    const connect = async (url: string) => {
      serveSpec(SPEC, {}, url);
      const created = await createProject(cookie, { url });
      await createVariant(cookie, created.id);
      return created;
    };
    // More broken projects than one run takes, all checked longer ago than the healthy one.
    const dead = Array.from({ length: 42 }, (_, n) => `https://dead-${n}.example.com/openapi.json`);
    for (const url of dead) await connect(url);
    const healthy = "https://healthy.example.com/openapi.json";
    await connect(healthy);
    for (const url of dead) upstream("GET", url, () => new Response("down", { status: 500 }));
    const HOUR = 60 * 60 * 1000;
    await sql("UPDATE projects SET fetched_at = ?", Date.now() - 5 * HOUR);
    await sql(
      "UPDATE projects SET fetched_at = ? WHERE slug LIKE 'test-43%'",
      Date.now() - 4 * HOUR,
    );

    const before = callsTo("GET", healthy);
    await run();
    // The first run goes to the forty that have waited longest, and all of them fail.
    expect(callsTo("GET", healthy)).toBe(before);
    // An hour later they are at the back of the line, although they have not succeeded since.
    await sql("UPDATE projects SET check_claimed_at = check_claimed_at - ?", HOUR);
    await run();
    expect(callsTo("GET", healthy)).toBe(before + 1);
  });

  it("records a failing source and moves on", async () => {
    const { cookie, project: created } = await published();
    const sent = mailbox();
    await sql("UPDATE projects SET fetched_at = ?", Date.now() - 2 * 60 * 60 * 1000);
    serveSpec("not json at all");
    await run(MAIL);
    expect(await project(cookie, created.id)).toMatchObject({ lastStatus: "error" });
    expect(sent).toEqual([]);
  });
});
