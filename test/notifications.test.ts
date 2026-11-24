import { describe, expect, it } from "vitest";
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
  googleLogin,
  json,
  MAIL,
  MAIL_URL,
  mailbox,
  runTimer,
  SPEC,
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
  const project = await createProject(cookie, PUBLISHED);
  return { cookie, project };
}
const PUBLISHED = {
  name: "Test API",
  variants: { docs: { name: "Public docs", include: { tags: ["pets"] } } },
};
const refresh = async (cookie: string, bindings = {}) =>
  (await (
    await call("/api/projects/test/check", { method: "POST", headers: { cookie } }, bindings)
  ).json()) as { changed: boolean; addedOps: string[]; removedOps: string[]; changedOps: string[] };
/** What a person wants to be emailed about for one project. */
const setScope = (cookie: string, scope: string) =>
  call("/api/projects/test/notifications", json("PUT", { scope }, cookie));

describe("what changed", () => {
  it("is worked out per operation, including changes that arrive through a schema", async () => {
    const { cookie, project } = await published();
    expect(project.state.operations.every((entry) => typeof entry.fingerprint === "string")).toBe(
      true,
    );

    serveSpec(nextRelease());
    expect(await refresh(cookie)).toMatchObject({
      changed: true,
      addedOps: ["GET /pets/{id}", "GET /audit"],
      removedOps: ["POST /internal/flush"],
      // Only GET /pets returns a Pet; POST /pets does not mention it.
      changedOps: ["GET /pets"],
    });
  });

  it("is nothing when only something unrelated moved", async () => {
    const { cookie } = await published();
    const next = structuredClone(SPEC);
    next.info.version = "2.0.0";
    (next.components.schemas.Secret.properties as Record<string, unknown>).extra = {
      type: "string",
    };
    serveSpec(next);
    expect(await refresh(cookie)).toMatchObject({
      changed: true,
      addedOps: [],
      removedOps: [],
      changedOps: [],
    });
  });
});

describe("fingerprints from before an upgrade of the engine", () => {
  it("are made again from the stored document, so a change that comes with the upgrade is reported as what it is", async () => {
    const { cookie } = await published();
    // As another version of the engine stored them: computed some other way.
    await sql(
      `UPDATE projects SET op_index = replace(op_index, '"fingerprint":"3:', '"fingerprint":"1:')`,
    );
    serveSpec(nextRelease());
    const result = await refresh(cookie);
    // Not every operation, as comparing old fingerprints with new ones would
    // say, and not none, as refusing to compare them would.
    expect(result.addedOps.sort()).toEqual(["GET /audit", "GET /pets/{id}"]);
    expect(result.removedOps).toEqual(["POST /internal/flush"]);
    expect(result.changedOps).toEqual(["GET /pets"]);
  });
});

describe("the email about it", () => {
  it("lists new operations, and changes and removals that touch what a variant serves", async () => {
    const { cookie } = await published();
    const sent = mailbox();
    serveSpec(nextRelease());
    await refresh(cookie, MAIL);

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
    expect(email?.text).toContain("https://proxy.test/p/test");
    // The setting is on the project's settings page, not the workspace's.
    expect(email?.text).toContain(
      "Choose what you are emailed about: https://proxy.test/p/test/settings",
    );
    expect(email?.text).not.toMatch(/—/);
  });

  it("covers everything in the source for someone who asked for that", async () => {
    const { cookie } = await published();
    await setScope(cookie, "all");
    const sent = mailbox();
    serveSpec(nextRelease());
    await refresh(cookie, MAIL);

    expect(sent[0]?.subject).toBe("Test API: 2 new, 1 changed, 1 removed");
    expect(sent[0]?.text).toContain("POST /internal/flush: was not served");
  });

  it("goes to each member at their own setting, and not to those who turned it off", async () => {
    const { cookie: ada } = await published();
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
      await setScope(cookie, scope);
    }

    const sent = mailbox();
    serveSpec(nextRelease());
    await refresh(ada, MAIL);

    expect(sent.map((email) => email.to).sort()).toEqual(["ada@example.com", "bob@example.com"]);
    const to = (address: string) => sent.find((email) => email.to === address);
    expect(to("ada@example.com")?.subject).toBe("Test API: 2 new, 1 changed");
    expect(to("bob@example.com")?.subject).toBe("Test API: 2 new, 1 changed, 1 removed");
  });

  it("is not sent when nothing a person follows changed", async () => {
    const { cookie } = await published();
    const sent = mailbox();
    // Only an operation nobody serves changes.
    const next = structuredClone(SPEC) as Spec;
    (next.paths["/internal/flush"]?.post as Record<string, unknown>).summary = "Flush everything";
    serveSpec(next);
    await refresh(cookie, MAIL);
    expect(sent).toEqual([]);

    await setScope(cookie, "all");
    (next.paths["/internal/flush"]?.post as Record<string, unknown>).summary = "Flush it all";
    serveSpec(next);
    await refresh(cookie, MAIL);
    expect(sent.map((email) => email.subject)).toEqual(["Test API: 1 changed"]);
  });

  it("is sent once, whoever notices the change first", async () => {
    const { cookie } = await published();
    const sent = mailbox();
    serveSpec(nextRelease());
    await sql("UPDATE projects SET next_check_at = ?", Date.now() - DAY);

    // The timer and two people pressing "Check now", all at once.
    await Promise.all([runTimer(MAIL), refresh(cookie, MAIL), refresh(cookie, MAIL)]);
    expect(sent).toHaveLength(1);
  });

  it("is sent when a deploy brings a document that changed, once, and not for a first deploy", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const { key } = await createKey(cookie);
    const definition = definitionOf({ ...PUBLISHED, sources: [{ file: "openapi.json" }] });
    const sent = mailbox();
    // The first deploy: everything is new, and nobody is told so.
    await applied(deploy(key, definition, { documents: { main: document() } }, MAIL));
    expect(sent).toEqual([]);

    const result = await applied(
      deploy(key, definition, { documents: { main: document(nextRelease()) } }, MAIL),
    );
    expect(result.operations).toMatchObject({
      added: ["GET /pets/{id}", "GET /audit"],
      removed: ["POST /internal/flush"],
      changed: ["GET /pets"],
    });
    expect(sent.map((email) => email.subject)).toEqual(["Test API: 2 new, 1 changed"]);

    // The same document again, and a change to the definition alone: no news.
    await applied(deploy(key, definition, { documents: { main: document(nextRelease()) } }, MAIL));
    await applied(
      deploy(
        key,
        { ...definition, variants: { docs: {} } },
        { documents: { main: document(nextRelease()) } },
        MAIL,
      ),
    );
    await applied(apply(cookie, { ...definition, name: "Renamed" }, { editInApp: true }, MAIL));
    // Nor is what an edit to the definition does to the operations: moving every
    // path under a prefix is the doing of whoever saved it, not something to tell them.
    const moved = await applied(
      apply(
        cookie,
        { ...definition, sources: [{ file: "openapi.json", pathPrefix: "/v2" }] },
        { editInApp: true },
        MAIL,
      ),
    );
    expect(moved.operations.removed.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);

    // The same holds when the edit brings a document along: a document that is
    // added to the project, or one that comes with a change to how it is merged.
    const billing = {
      openapi: "3.1.0",
      info: { title: "Billing", version: "1" },
      paths: { "/invoices": { get: { responses: { "200": { description: "ok" } } } } },
    };
    const added = await applied(
      apply(
        cookie,
        {
          ...definition,
          sources: [
            { name: "core", file: "openapi.json", main: true, pathPrefix: "/v2" },
            { name: "billing", file: "billing.json" },
          ],
        },
        { documents: { billing: document(billing) } },
        MAIL,
      ),
    );
    expect(added.operations.added).toEqual(["GET /invoices"]);
    expect(sent).toHaveLength(1);
    // A new document for sources that are merged as before is news again.
    const next = structuredClone(billing) as typeof billing & { paths: Record<string, unknown> };
    next.paths["/refunds"] = { post: { responses: { "201": { description: "refunded" } } } };
    await applied(
      apply(
        cookie,
        {
          ...definition,
          sources: [
            { name: "core", file: "openapi.json", main: true, pathPrefix: "/v2" },
            { name: "billing", file: "billing.json" },
          ],
        },
        { documents: { billing: document(next) } },
        MAIL,
      ),
    );
    expect(sent.map((email) => email.subject)).toEqual([
      "Test API: 2 new, 1 changed",
      "Test API: 1 new",
    ]);
  });

  it("is not needed for anything: without an email provider, checks work the same", async () => {
    const { cookie } = await published();
    serveSpec(nextRelease());
    expect((await refresh(cookie)).changed).toBe(true);
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
