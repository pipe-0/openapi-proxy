import { describe, expect, it } from "vitest";
import {
  call,
  createProject,
  createVariant,
  googleCallback,
  googleLogin,
  json,
  login,
  MAIL,
  mailbox,
  serveSpec,
  sql,
} from "./harness";

interface Workspace {
  id: string;
  name: string;
  role: "owner" | "member";
  members: Array<{ id: string; email: string; role: string; you: boolean }>;
  invitations: Array<{ id: string; email: string; link: string }>;
  usage: { projects: number; variants: number };
}
interface Invitation {
  id: string;
  link: string;
  emailed: boolean;
}

const get = async <T>(path: string, cookie: string) =>
  (await (await call(path, { headers: { cookie } })).json()) as T;
const workspace = (cookie: string) => get<Workspace>("/api/workspace", cookie);
const projectsOf = (cookie: string) => get<Array<{ id: string }>>("/api/projects", cookie);

async function invite(cookie: string, email: string, bindings = {}) {
  const response = await call(
    "/api/workspace/invitations",
    json("POST", { email }, cookie),
    bindings,
  );
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return (await response.json()) as Invitation;
}
const accept = (cookie: string, id: string) =>
  call(`/api/invitations/${id}/accept`, { method: "POST", headers: { cookie } });

/** Ada with a project, and Bob invited and joined. */
async function team() {
  const ada = await googleLogin("ada@example.com", "Ada");
  serveSpec();
  const project = await createProject(ada);
  const invitation = await invite(ada, "bob@example.com");
  const bob = await googleLogin("bob@example.com", "Bob");
  expect((await accept(bob, invitation.id)).status).toBe(200);
  return { ada, bob, project, invitation };
}

describe("inviting someone", () => {
  it("brings them into the workspace, where they see and can change the same projects", async () => {
    const { ada, bob, project } = await team();

    expect((await projectsOf(bob)).map((p) => p.id)).toEqual([project.id]);
    const variant = await createVariant(bob, project.id);
    expect((await get<Array<{ id: string }>>("/api/variants", ada)).map((v) => v.id)).toEqual([
      variant.id,
    ]);

    const seenByBob = await workspace(bob);
    expect(seenByBob.role).toBe("member");
    expect(seenByBob.members.map((m) => [m.email, m.role, m.you])).toEqual([
      ["ada@example.com", "owner", false],
      ["bob@example.com", "member", true],
    ]);
    expect(seenByBob.invitations).toEqual([]);
    // The workspace Bob got when he first signed in was empty, and is gone.
    expect((await sql("SELECT count(*) AS n FROM organization")).results[0]).toEqual({ n: 1 });
    expect((await sql("SELECT count(*) AS n FROM member")).results[0]).toEqual({ n: 2 });
  });

  it("emails the invitation when email is set up, and always returns a link", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const sent = mailbox();

    const quiet = await invite(ada, "carol@example.com");
    expect(quiet.emailed).toBe(false);
    expect(quiet.link).toBe(`https://proxy.test/invite/${quiet.id}`);
    expect(sent).toEqual([]);

    const mailed = await invite(ada, "Bob@Example.com ", MAIL);
    expect(mailed.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "bob@example.com", from: MAIL.EMAIL_FROM });
    expect(sent[0]?.subject).toContain("Ada invited you");
    expect(sent[0]?.text).toContain(mailed.link);
    expect(sent[0]?.html).toContain(`href="${mailed.link}"`);

    // Inviting the same address again resends the same invitation.
    const again = await invite(ada, "bob@example.com", MAIL);
    expect(again.id).toBe(mailed.id);
    expect((await workspace(ada)).invitations.map((i) => i.email)).toEqual([
      "carol@example.com",
      "bob@example.com",
    ]);
  });

  it("only works for the invited address, while it is valid", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const invitation = await invite(ada, "bob@example.com");

    const mallory = await googleLogin("mallory@example.com");
    const shown = await get<{ state: string }>(`/api/invitations/${invitation.id}`, mallory);
    expect(shown.state).toBe("wrong-account");
    expect((await accept(mallory, invitation.id)).status).toBe(409);
    expect((await accept(mallory, "inv_does-not-exist")).status).toBe(404);

    const bob = await googleLogin("bob@example.com");
    await sql("UPDATE invitation SET expires_at = ?", Date.now() - 1000);
    expect((await accept(bob, invitation.id)).status).toBe(409);

    const second = await invite(ada, "bob@example.com");
    await call(`/api/workspace/invitations/${second.id}`, {
      method: "DELETE",
      headers: { cookie: ada, origin: "https://proxy.test" },
    });
    expect((await accept(bob, second.id)).status).toBe(409);
    expect((await workspace(ada)).members).toHaveLength(1);
  });

  it("needs an address the sign-in provider vouches for", async () => {
    const ada = await googleLogin("ada@example.com");
    const invitation = await invite(ada, "bob@example.com");
    const bob = await googleLogin("bob@example.com");
    await sql("UPDATE user SET email_verified = 0 WHERE email = 'bob@example.com'");

    const refused = await accept(bob, invitation.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toContain("not been verified");
  });

  it("cannot be used to send mail in bulk", async () => {
    const ada = await googleLogin("ada@example.com");
    const sent = mailbox();
    // Asking again right away does not email again.
    await invite(ada, "bob@example.com", MAIL);
    await invite(ada, "bob@example.com", MAIL);
    expect(sent).toHaveLength(1);

    // Open invitations are capped, and so are new ones per day, cancelled or not.
    for (let i = 0; i < 19; i++) await invite(ada, `person${i}@example.com`);
    const full = await call(
      "/api/workspace/invitations",
      json("POST", { email: "one-too-many@example.com" }, ada),
    );
    expect(full.status).toBe(409);

    await sql("UPDATE invitation SET status = 'canceled'");
    for (let i = 0; i < 10; i++) await invite(ada, `more${i}@example.com`);
    const tomorrow = await call(
      "/api/workspace/invitations",
      json("POST", { email: "tomorrow@example.com" }, ada),
    );
    expect(tomorrow.status).toBe(429);
  });

  it("does not let someone walk away from projects by accident", async () => {
    const ada = await googleLogin("ada@example.com");
    const invitation = await invite(ada, "bob@example.com");

    const bob = await googleLogin("bob@example.com");
    serveSpec();
    await createProject(bob);
    const blocked = await accept(bob, invitation.id);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe("invitation-blocked");
    expect(await projectsOf(bob)).toHaveLength(1);
  });

  it("is refused for people who are already in, and for nonsense", async () => {
    const { ada } = await team();
    const post = (email: unknown) =>
      call("/api/workspace/invitations", json("POST", { email }, ada));
    expect((await post("bob@example.com")).status).toBe(409);
    expect((await post("not an address")).status).toBe(400);
    expect((await post(42)).status).toBe(400);
  });
});

describe("leaving and being removed", () => {
  const remove = (cookie: string, memberId: string) =>
    call(`/api/workspace/members/${memberId}`, {
      method: "DELETE",
      headers: { cookie, origin: "https://proxy.test" },
    });

  it("ends access at once, even though the session is still valid", async () => {
    const { ada, bob, project } = await team();
    const bobId = (await workspace(ada)).members.find((m) => m.email === "bob@example.com")?.id;

    expect((await remove(ada, bobId as string)).status).toBe(200);

    // Bob's session still works, but it now leads to a new, empty workspace of his own.
    expect(await projectsOf(bob)).toEqual([]);
    expect((await call(`/api/projects/${project.id}`, { headers: { cookie: bob } })).status).toBe(
      404,
    );
    expect((await workspace(bob)).role).toBe("owner");
    expect((await workspace(ada)).members).toHaveLength(1);
  });

  it("is the owner's call: a member can leave, but not remove others or the owner", async () => {
    const { ada, bob } = await team();
    const carolInvite = await invite(bob, "carol@example.com"); // members may invite
    const carol = await googleLogin("carol@example.com");
    await accept(carol, carolInvite.id);

    const members = (await workspace(ada)).members;
    const id = (email: string) => members.find((m) => m.email === email)?.id as string;

    expect((await remove(bob, id("carol@example.com"))).status).toBe(403);
    expect((await remove(bob, id("ada@example.com"))).status).toBe(403);
    expect((await remove(ada, id("ada@example.com"))).status).toBe(403);
    expect((await remove(carol, id("carol@example.com"))).status).toBe(200);
    expect((await workspace(ada)).members.map((m) => m.email)).toEqual([
      "ada@example.com",
      "bob@example.com",
    ]);
  });

  it("cannot reach into another workspace", async () => {
    const { ada } = await team();
    const stranger = await googleLogin("eve@example.com");
    const members = (await workspace(ada)).members;
    for (const member of members) {
      expect((await remove(stranger, member.id)).status).toBe(404);
    }
    const pending = await invite(ada, "dan@example.com");
    const cancel = await call(`/api/workspace/invitations/${pending.id}`, {
      method: "DELETE",
      headers: { cookie: stranger, origin: "https://proxy.test" },
    });
    expect(cancel.status).toBe(404);
    expect((await workspace(ada)).invitations).toHaveLength(1);
  });
});

describe("one workspace per person", () => {
  it("is all that better-auth's own organization endpoints could break, so they are closed", async () => {
    const ada = await googleLogin("ada@example.com");
    for (const [method, path] of [
      ["POST", "/api/auth/organization/create"],
      ["POST", "/api/auth/organization/invite-member"],
      ["POST", "/api/auth/organization/accept-invitation"],
      ["POST", "/api/auth/organization/set-active"],
      ["GET", "/api/auth/organization/list"],
    ] as const) {
      const response = await call(path, {
        method,
        headers: { cookie: ada, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, path).toBe(404);
    }
  });

  it("is enforced by the database", async () => {
    const { bob } = await team();
    void bob;
    const members = (await sql("SELECT user_id, organization_id FROM member")).results as Array<{
      user_id: string;
      organization_id: string;
    }>;
    const [first] = members;
    await expect(
      sql(
        "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('dup', ?, ?, 'member', 0)",
        first?.organization_id,
        first?.user_id,
      ),
    ).rejects.toThrow(/UNIQUE/i);
  });
});

describe("a closed instance", () => {
  const closed = { ALLOWED_EMAILS: "ada@example.com" };

  it("lets invited people in, and nobody else", async () => {
    const ada = await googleLogin("ada@example.com", "Ada", closed);
    await call(
      "/api/workspace/invitations",
      json("POST", { email: "bob@example.com" }, ada),
      closed,
    );

    const stranger = await googleCallback({ email: "mallory@example.com" }, closed);
    expect(stranger.headers.get("location")).toContain("/login?error=");

    const invited = await googleCallback({ email: "bob@example.com" }, closed);
    expect(invited.headers.get("location")).toBe("/");
  });

  it("ends the access of someone who is removed, although their session has weeks left", async () => {
    const ada = await googleLogin("ada@example.com", "Ada", closed);
    const invitation = (await (
      await call(
        "/api/workspace/invitations",
        json("POST", { email: "bob@example.com" }, ada),
        closed,
      )
    ).json()) as { id: string };
    const bob = await googleLogin("bob@example.com", "Bob", closed);
    // Invited, not yet in: Bob can look at the invitation and accept it.
    const accepted = await call(
      `/api/invitations/${invitation.id}/accept`,
      { method: "POST", headers: { cookie: bob } },
      closed,
    );
    expect(accepted.status).toBe(200);
    expect((await call("/api/projects", { headers: { cookie: bob } }, closed)).status).toBe(200);

    const workspace = (await (
      await call("/api/workspace", { headers: { cookie: ada } }, closed)
    ).json()) as Workspace;
    const membership = workspace.members.find((member) => member.email === "bob@example.com");
    await call(
      `/api/workspace/members/${membership?.id}`,
      { method: "DELETE", headers: { cookie: ada } },
      closed,
    );

    // On an open instance Bob would now be in a workspace of his own. Here he is out.
    const after = await call("/api/projects", { headers: { cookie: bob } }, closed);
    expect(after.status).toBe(401);
    expect((await sql("SELECT count(*) AS n FROM organization")).results[0]).toEqual({ n: 1 });
  });

  it("ends the access of someone who is taken off the list, token included", async () => {
    const open = { ALLOWED_EMAILS: "ada@example.com, carol@example.com" };
    const carol = await googleLogin("carol@example.com", "Carol", open);
    const made = await call("/api/workspace/tokens", json("POST", { name: "CI" }, carol), open);
    const { token } = (await made.json()) as { token: string };
    const withToken = (bindings: object) =>
      call("/api/projects", { headers: { authorization: `Bearer ${token}` } }, bindings);
    expect((await call("/api/projects", { headers: { cookie: carol } }, open)).status).toBe(200);
    expect((await withToken(open)).status).toBe(200);

    expect((await call("/api/projects", { headers: { cookie: carol } }, closed)).status).toBe(401);
    expect((await withToken(closed)).status).toBe(401);
  });
});

describe("the built-in admin", () => {
  it("has a workspace like everyone else, and can invite", async () => {
    const admin = await login();
    const mine = await workspace(admin);
    expect(mine.role).toBe("owner");
    expect((await invite(admin, "ada@example.com")).link).toContain("/invite/inv_");
  });
});
