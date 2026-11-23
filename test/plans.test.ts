import { describe, expect, it } from "vitest";
import { giveProStatement, removePlanStatement } from "../src/server/plans";
import selfHosting from "../src/web/content/docs/self-hosting.mdx?raw";
import {
  call,
  createVariant,
  googleLogin,
  json,
  MAIL,
  MAIL_URL,
  mailbox,
  SPEC,
  serveSpec,
  sql,
  upstream,
} from "./harness";

// An instance sells plans when it says where requests for one go.
const SUPPORT = "support@proxy.test";
const FREE = { CONTACT_EMAIL: SUPPORT };
const DAY = 24 * 60 * 60 * 1000;

const workspaceId = async (cookie: string) =>
  ((await (await call("/api/workspace", { headers: { cookie } }, FREE)).json()) as { id: string })
    .id;
/** What whoever takes the payment does: a subscription that is in force until `periodEnd`. */
async function subscribe(cookie: string, periodEnd: number | null = Date.now() + 365 * DAY) {
  const organizationId = await workspaceId(cookie);
  const now = Date.now();
  await sql(
    "INSERT INTO subscription (id, reference_id, plan, status, period_start, period_end, created_at, updated_at) VALUES (?, ?, 'pro', 'active', ?, ?, ?, ?)",
    `sub_${organizationId}`,
    organizationId,
    now,
    periodEnd,
    now,
    now,
  );
}
const url = (n: number) => `https://api.example.com/openapi-${n}.json`;

async function connect(cookie: string, n: number, bindings = {}) {
  serveSpec(SPEC, {}, url(n));
  return call("/api/projects", json("POST", { url: url(n) }, cookie), bindings);
}
const variant = (cookie: string, projectId: string, name: string, bindings = {}) =>
  call(
    "/api/variants",
    json("POST", { projectId, name, selection: { include: { tags: ["pets"] } } }, cookie),
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
    // The size that counts is that of the largest project's documents together.
    const { projectBytes } = workspace.usage as { projectBytes: number };
    expect(projectBytes).toBeGreaterThan(100);
    expect(projectBytes).toBeLessThan(5_000_000);
  });

  it("is lifted by a subscription, for as long as that is in force", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada", FREE);
    for (let n = 1; n <= 3; n++) await connect(cookie, n, FREE);
    expect((await connect(cookie, 4, FREE)).status).toBe(402);

    await subscribe(cookie);
    expect((await connect(cookie, 4, FREE)).status).toBe(201);

    // A period that runs out without being renewed ends the plan by itself.
    // What exists stays; what is new counts against Free again.
    await sql("UPDATE subscription SET period_end = ?", Date.now() - 1000);
    expect((await connect(cookie, 5, FREE)).status).toBe(402);
    const me = (await (await call("/api/me", { headers: { cookie } }, FREE)).json()) as {
      plan: string;
    };
    expect(me.plan).toBe("free");
  });

  it("does not let one workspace's subscription count for another", async () => {
    const ada = await googleLogin("ada@example.com", "Ada", FREE);
    await subscribe(ada);
    for (let n = 1; n <= 4; n++) expect((await connect(ada, n, FREE)).status).toBe(201);

    const bob = await googleLogin("bob@example.com", "Bob", FREE);
    for (let n = 11; n <= 13; n++) expect((await connect(bob, n, FREE)).status).toBe(201);
    expect((await connect(bob, 14, FREE)).status).toBe(402);
  });
});

describe("asking for another plan", () => {
  const HOSTED = { ...FREE, ...MAIL };
  const ask = (cookie: string, want: string, bindings: object = HOSTED) =>
    call("/api/workspace/plan-request", json("POST", { want }, cookie), bindings);
  const billing = async (cookie: string, bindings: object = HOSTED) =>
    (await (await call("/api/workspace", { headers: { cookie } }, bindings)).json()) as {
      id: string;
      plan: string;
      usage: { projects: number; variants: number };
      limits: { projects: number | null; variants: number | null };
      subscription: {
        status: string;
        periodEnd: number | null;
        cancelAtPeriodEnd: boolean;
        canceledAt: number | null;
      } | null;
      upgradeRequestedAt: number | null;
      planRequests: boolean;
    };

  it("for Pro is an email to the people who run the service, with what to do when it is paid", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    await connect(cookie, 1, HOSTED);
    const sent = mailbox();
    expect(await billing(cookie)).toMatchObject({
      plan: "free",
      usage: { projects: 1, variants: 0 },
      limits: { projects: 3, variants: 15 },
      subscription: null,
      upgradeRequestedAt: null,
      planRequests: true,
    });

    const response = await ask(cookie, "upgrade");
    expect(await response.json()).toEqual({ ok: true, want: "upgrade", sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: SUPPORT, subject: expect.stringContaining("Upgrade") });
    expect(sent[0]?.text).toContain("Ada (ada@example.com)");
    expect(sent[0]?.text).toContain("In use: 1 projects, 0 variants");
    // Asked for, not paid for: still Free, and the app says that it was asked.
    expect(await billing(cookie)).toMatchObject({
      plan: "free",
      subscription: null,
      upgradeRequestedAt: expect.any(Number),
    });

    // Asked already: a second click, or a second tab, sends nothing more.
    const again = await Promise.all([ask(cookie, "upgrade"), ask(cookie, "upgrade")]);
    for (const answer of again) expect(await answer.json()).toMatchObject({ sent: false });
    expect(sent).toHaveLength(1);
    // After a day without an answer it can be asked again, about the same subscription.
    await sql("UPDATE subscription SET updated_at = updated_at - ?", 25 * 3_600_000);
    expect(await (await ask(cookie, "upgrade")).json()).toMatchObject({ sent: true });
    expect(sent).toHaveLength(2);
    expect((await sql("SELECT count(*) AS n FROM subscription")).results).toEqual([{ n: 1 }]);

    // The statement in the email is the one that gives Pro: until it is removed.
    const statement = /INSERT OR REPLACE INTO subscription.*;/.exec(sent[1]?.text ?? "");
    expect(statement?.[0]).toBe(giveProStatement("ada@example.com"));
    await sql(statement?.[0] as string);
    expect(await billing(cookie)).toMatchObject({
      plan: "pro",
      limits: { projects: 100, variants: null },
      subscription: { status: "active", periodEnd: null, cancelAtPeriodEnd: false },
      upgradeRequestedAt: null,
    });
    expect((await sql("SELECT count(*) AS n FROM subscription")).results).toEqual([{ n: 1 }]);
  });

  it("is not needed: whoever runs the instance gives Pro and removes it, by email address", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const bob = await googleLogin("bob@example.com", "Bob");
    // Someone Ada invited: their address names the same workspace.
    const invited = (await (
      await call("/api/workspace/invitations", json("POST", { email: "cy@example.com" }, ada))
    ).json()) as { id: string };
    const cy = await googleLogin("cy@example.com", "Cy");
    await call(`/api/invitations/${invited.id}/accept`, json("POST", {}, cy));

    await sql(giveProStatement("cy@example.com"));
    expect(await billing(ada)).toMatchObject({
      plan: "pro",
      subscription: { status: "active", periodEnd: null },
    });
    expect((await billing(bob)).plan).toBe("free");
    // Run again, it is the same one subscription.
    await sql(giveProStatement("ada@example.com"));
    expect((await sql("SELECT count(*) AS n FROM subscription")).results).toEqual([{ n: 1 }]);

    // Removed, the workspace is on Free at once, and can ask for Pro again.
    await sql(removePlanStatement("ada@example.com"));
    expect(await billing(ada)).toMatchObject({ plan: "free", subscription: null });
    const sent = mailbox();
    expect(await (await ask(ada, "upgrade")).json()).toMatchObject({ sent: true });
    expect(sent).toHaveLength(1);
    // Given while a request is open, the request is what becomes the subscription.
    await sql(giveProStatement("ada@example.com"));
    expect(await billing(ada)).toMatchObject({ plan: "pro", upgradeRequestedAt: null });
    expect((await sql("SELECT count(*) AS n FROM subscription")).results).toEqual([{ n: 1 }]);

    // The self-hosting page shows these two statements, as they are.
    const flat = (text: string) =>
      text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
    expect(flat(selfHosting)).toContain(giveProStatement("ada@example.com"));
    expect(flat(selfHosting)).toContain(removePlanStatement("ada@example.com"));

    // An address with a quote in it is a string like any other.
    expect(giveProStatement("o'brien@example.com")).toContain("'o''brien@example.com'");
    await sql(giveProStatement("o'brien@example.com"));
    await sql(removePlanStatement("nobody@example.com"));
    expect((await billing(ada)).plan).toBe("pro");
  });

  it("to cancel marks the subscription not to renew, and Pro stays to the end of what is paid for", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const sent = mailbox();
    const periodEnd = Date.now() + 100 * DAY;
    await subscribe(cookie, periodEnd);
    expect(await billing(cookie)).toMatchObject({
      plan: "pro",
      subscription: { status: "active", periodEnd, cancelAtPeriodEnd: false },
    });

    // On Pro there is nothing to upgrade to.
    expect((await ask(cookie, "upgrade")).status).toBe(400);
    expect(await (await ask(cookie, "cancel")).json()).toMatchObject({
      want: "cancel",
      sent: true,
    });
    expect(sent.at(-1)).toMatchObject({ to: SUPPORT, subject: expect.stringContaining("Cancel") });
    expect(sent.at(-1)?.text).toContain(new Date(periodEnd).toISOString().slice(0, 10));
    expect(await billing(cookie)).toMatchObject({
      plan: "pro",
      subscription: { cancelAtPeriodEnd: true, canceledAt: expect.any(Number), periodEnd },
    });
    // Asked already: nothing more is sent.
    expect(await (await ask(cookie, "cancel")).json()).toMatchObject({ sent: false });
    expect(sent).toHaveLength(1);

    // At the end of the period it is over, without anyone doing anything.
    await sql("UPDATE subscription SET period_end = ?", Date.now() - 1000);
    expect(await billing(cookie)).toMatchObject({ plan: "free", subscription: null });
    // And a subscription that ran out is no obstacle to asking for a new one.
    expect(await (await ask(cookie, "upgrade")).json()).toMatchObject({ sent: true });
    expect(await billing(cookie)).toMatchObject({
      plan: "free",
      upgradeRequestedAt: expect.any(Number),
    });
    expect(
      (await sql("SELECT status, period_end, cancel_at_period_end FROM subscription")).results,
    ).toEqual([{ status: "incomplete", period_end: null, cancel_at_period_end: 0 }]);
  });

  it("to cancel one without an end tells them how to remove it", async () => {
    const cookie = await googleLogin("ada@example.com", "Ada");
    const sent = mailbox();
    await sql(giveProStatement("ada@example.com"));
    expect(await (await ask(cookie, "cancel")).json()).toMatchObject({ sent: true });
    // Pro stays until they do.
    expect(await billing(cookie)).toMatchObject({
      plan: "pro",
      subscription: { cancelAtPeriodEnd: true, periodEnd: null },
    });
    const statement = /DELETE FROM subscription.*;/.exec(sent[0]?.text ?? "");
    expect(statement?.[0]).toBe(removePlanStatement("ada@example.com"));
    await sql(statement?.[0] as string);
    expect(await billing(cookie)).toMatchObject({ plan: "free", subscription: null });
  });

  it("comes after a note about each sign-up, on an instance that is run as a service", async () => {
    const sent = mailbox();
    await googleLogin("ada@example.com", "Ada", HOSTED);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: SUPPORT, subject: "New sign-up: ada@example.com" });
    expect(sent[0]?.text).toContain("Ada (ada@example.com) signed up.");
    // Signing in again is not signing up.
    await googleLogin("ada@example.com", "Ada", HOSTED);
    expect(sent).toHaveLength(1);
    // Where nothing is sold, nobody is told: a self-hosted instance is its owner's business.
    await googleLogin("bob@example.com", "Bob", MAIL);
    expect(sent).toHaveLength(1);
    // And the workspace page says how large a project may be, next to the other limits.
    const workspace = await billing(await googleLogin("ada@example.com", "Ada", HOSTED));
    expect(workspace).toMatchObject({
      limits: { projects: 3, variants: 15, projectBytes: 5_000_000 },
      usage: { projects: 0, variants: 0, projectBytes: 0 },
    });
  });

  it("is for the owner, in a browser, on an instance that sells plans and can send email", async () => {
    const owner = await googleLogin("ada@example.com", "Ada");
    const sent = mailbox();

    // Someone who was invited cannot change what the workspace pays for.
    const invited = (await (
      await call("/api/workspace/invitations", json("POST", { email: "bob@example.com" }, owner))
    ).json()) as { id: string };
    const member = await googleLogin("bob@example.com", "Bob");
    await call(`/api/invitations/${invited.id}/accept`, json("POST", {}, member));
    expect((await ask(member, "upgrade")).status).toBe(403);

    // Where nothing is sold there is nothing to ask for, and every workspace has everything.
    expect((await ask(owner, "upgrade", MAIL)).status).toBe(404);
    expect(await billing(owner, MAIL)).toMatchObject({ plan: "pro", subscription: null });
    // Without email there is nobody the app could tell.
    expect((await ask(owner, "upgrade", FREE)).status).toBe(503);
    expect((await billing(owner, FREE)).planRequests).toBe(false);

    // An email that is not accepted leaves nothing open, so it can be tried again.
    upstream("POST", MAIL_URL, () => Response.json({ success: false }, { status: 500 }));
    const failed = await ask(owner, "upgrade");
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toContain(SUPPORT);
    expect((await billing(owner)).upgradeRequestedAt).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
