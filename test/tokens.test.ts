import { describe, expect, it } from "vitest";
import {
  type ApiProject,
  type ApiToken,
  bearer,
  call,
  callAsProgram,
  createProject,
  createToken,
  googleLogin,
  json,
  publish,
  SPEC,
  serveSpec,
  sql,
} from "./harness";

const withToken = (token: string, path: string, init: RequestInit = {}) =>
  callAsProgram(path, { ...init, headers: { ...bearer(token), ...init.headers } });
const projects = async (response: Response) => (await response.json()) as ApiProject[];

/** Ada with a project and a token, and Bob in a workspace of his own. */
async function setup() {
  const ada = await googleLogin("ada@example.com", "Ada");
  serveSpec();
  const project = await createProject(ada);
  const { token } = await createToken(ada);
  return { ada, project, token };
}

describe("an API token", () => {
  it("is shown once, and reaches what its maker's session reaches", async () => {
    const { ada, project } = await setup();
    const created = await createToken(ada, "Deploy pipeline");
    expect(created.token).toMatch(/^oap_[0-9a-z]{40}$/);
    expect(created.prefix).toBe(created.token.slice(0, 8));
    expect(created).toMatchObject({ name: "Deploy pipeline", createdBy: "Ada", yours: true });

    const listed = await withToken(created.token, "/api/projects");
    expect(listed.status).toBe(200);
    expect((await projects(listed)).map((p) => p.id)).toEqual([project.id]);

    const me = (await (await withToken(created.token, "/api/me")).json()) as {
      user: { email: string };
      role: string;
    };
    expect(me).toMatchObject({ user: { email: "ada@example.com" }, role: "owner" });
  });

  it("reaches nothing of another workspace", async () => {
    const { project } = await setup();
    const bob = await googleLogin("bob@example.com", "Bob");
    const { token } = await createToken(bob);

    expect(await projects(await withToken(token, "/api/projects"))).toEqual([]);
    expect((await withToken(token, `/api/projects/${project.id}`)).status).toBe(404);
    expect(
      (await withToken(token, `/api/projects/${project.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (
        await withToken(
          token,
          "/api/variants",
          json("POST", {
            projectId: project.id,
            name: "Mine now",
            selection: { mode: "exclude", operations: [], tags: [] },
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("works for a script: no cookie, no Origin, no body", async () => {
    const { ada, project, token } = await setup();
    const refresh = { method: "POST" };

    // A browser request like this is refused: without an Origin it could be forged.
    const forged = await callAsProgram(`/api/projects/${project.id}/refresh`, {
      ...refresh,
      headers: { cookie: ada },
    });
    expect(forged.status).toBe(403);

    const checked = await withToken(token, `/api/projects/${project.id}/refresh`, refresh);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ changed: false });

    serveSpec(SPEC, {}, "https://api.example.com/second.json");
    const created = await withToken(
      token,
      "/api/projects",
      json("POST", { url: "https://api.example.com/second.json" }),
    );
    expect(created.status).toBe(201);
  });

  it("stops working when it is revoked", async () => {
    const { ada, token } = await setup();
    const [listed] = (await (
      await call("/api/workspace/tokens", { headers: { cookie: ada } })
    ).json()) as ApiToken[];

    const revoked = await call(`/api/workspace/tokens/${listed?.id}`, {
      method: "DELETE",
      headers: { cookie: ada },
    });
    expect(revoked.status).toBe(200);

    const after = await withToken(token, "/api/projects");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("stops working when its maker is removed from the workspace, or leaves it", async () => {
    const { ada, project } = await setup();
    const invite = async (email: string) => {
      const invitation = (await (
        await call("/api/workspace/invitations", json("POST", { email }, ada))
      ).json()) as { id: string };
      const cookie = await googleLogin(email);
      await call(`/api/invitations/${invitation.id}/accept`, {
        method: "POST",
        headers: { cookie },
      });
      return cookie;
    };
    const members = async () =>
      (
        (await (await call("/api/workspace", { headers: { cookie: ada } })).json()) as {
          members: Array<{ id: string; email: string }>;
        }
      ).members;

    const bob = await invite("bob@example.com");
    const carol = await invite("carol@example.com");
    const bobs = (await createToken(bob)).token;
    const carols = (await createToken(carol)).token;
    for (const token of [bobs, carols]) {
      expect((await projects(await withToken(token, "/api/projects"))).map((p) => p.id)).toEqual([
        project.id,
      ]);
    }

    const id = async (email: string) => (await members()).find((m) => m.email === email)?.id;
    // Ada removes Bob; Carol leaves on her own.
    await call(`/api/workspace/members/${await id("bob@example.com")}`, {
      method: "DELETE",
      headers: { cookie: ada },
    });
    await call(`/api/workspace/members/${await id("carol@example.com")}`, {
      method: "DELETE",
      headers: { cookie: carol },
    });

    expect((await withToken(bobs, "/api/projects")).status).toBe(401);
    expect((await withToken(carols, "/api/projects")).status).toBe(401);
  });

  it("cannot make or revoke tokens", async () => {
    const { ada, token } = await setup();
    const made = await withToken(token, "/api/workspace/tokens", json("POST", { name: "Another" }));
    expect(made.status).toBe(403);

    const [existing] = (await (
      await call("/api/workspace/tokens", { headers: { cookie: ada } })
    ).json()) as ApiToken[];
    const revoked = await withToken(token, `/api/workspace/tokens/${existing?.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(403);
    expect((await withToken(token, "/api/projects")).status).toBe(200);
  });

  it("cannot change who is in the workspace, so revoking it ends what it gave", async () => {
    const { ada, token } = await setup();
    // Bob is a member, so there is someone to remove.
    const invitation = (await (
      await call("/api/workspace/invitations", json("POST", { email: "bob@example.com" }, ada))
    ).json()) as { id: string };
    const bob = await googleLogin("bob@example.com", "Bob");
    await call(`/api/invitations/${invitation.id}/accept`, {
      method: "POST",
      headers: { cookie: bob },
    });
    const workspace = (await (
      await call("/api/workspace", { headers: { cookie: ada } })
    ).json()) as { members: Array<{ id: string; email: string }> };
    const bobsMembership = workspace.members.find((member) => member.email === "bob@example.com");

    // Whoever holds the token cannot invite an address of their own...
    const invited = await withToken(
      token,
      "/api/workspace/invitations",
      json("POST", { email: "mallory@example.com" }),
    );
    // ...or remove people, rename the workspace, accept an invitation, or look at who is in it.
    const removed = await withToken(token, `/api/workspace/members/${bobsMembership?.id}`, {
      method: "DELETE",
    });
    const renamed = await withToken(token, "/api/workspace", json("PATCH", { name: "Taken" }));
    const accepted = await withToken(token, `/api/invitations/${invitation.id}/accept`, {
      method: "POST",
    });
    const listed = await withToken(token, "/api/workspace");
    for (const response of [invited, removed, renamed, accepted, listed]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden" });
    }

    const after = (await (await call("/api/workspace", { headers: { cookie: ada } })).json()) as {
      name: string;
      members: unknown[];
      invitations: unknown[];
    };
    expect(after.name).not.toBe("Taken");
    expect(after.members).toHaveLength(2);
    expect(after.invitations).toEqual([]);
  });

  it("is the only thing looked at when a request carries one", async () => {
    const { ada, token } = await setup();
    // A valid session next to a token that is not: the session does not rescue it.
    for (const credential of [`oap_${"0".repeat(40)}`, "nonsense", ""]) {
      const response = await callAsProgram("/api/projects", {
        headers: { cookie: ada, authorization: `Bearer ${credential}` },
      });
      expect(response.status, credential).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    // And the other way round: a valid token decides, whoever the cookie belongs to.
    const bob = await googleLogin("bob@example.com", "Bob");
    const mixed = await callAsProgram("/api/me", {
      headers: { cookie: bob, ...bearer(token) },
    });
    expect(((await mixed.json()) as { user: { email: string } }).user.email).toBe(
      "ada@example.com",
    );
  });

  it("does not exempt sign-in routes from the cross-site check", async () => {
    const { ada, token } = await setup();
    // better-auth's routes only know cookies. A token header must not switch their protection off.
    const signOut = await callAsProgram("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: ada, ...bearer(token), "content-type": "text/plain" },
      body: "{}",
    });
    expect(signOut.status).toBe(403);
    expect((await call("/api/me", { headers: { cookie: ada } })).status).toBe(200);
  });

  it("is never listed, and neither is its hash", async () => {
    const { ada, token } = await setup();
    const listing = await (
      await call("/api/workspace/tokens", { headers: { cookie: ada } })
    ).text();
    expect(listing).not.toContain(token);
    expect(listing).not.toContain(token.slice(8));

    const [stored] = (await sql("SELECT token_hash, prefix FROM api_tokens")).results as Array<{
      token_hash: string;
      prefix: string;
    }>;
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(listing).not.toContain(stored?.token_hash);
    expect(JSON.parse(listing)).toMatchObject([
      { name: "CI", prefix: stored?.prefix, yours: true },
    ]);
    expect(Object.keys((JSON.parse(listing) as object[])[0] ?? {}).sort()).toEqual(
      ["createdAt", "createdBy", "id", "lastUsedAt", "name", "prefix", "yours"].sort(),
    );
  });

  it("records roughly when it was last used", async () => {
    const { ada, token } = await setup();
    const lastUsed = async () =>
      (
        (await (
          await call("/api/workspace/tokens", { headers: { cookie: ada } })
        ).json()) as ApiToken[]
      )[0]?.lastUsedAt;
    expect(await lastUsed()).toBeNull();

    await withToken(token, "/api/projects");
    const first = await lastUsed();
    expect(first).toBeGreaterThan(0);

    // Not on every request: once a minute is enough to tell a live token from a dead one.
    await withToken(token, "/api/projects");
    expect(await lastUsed()).toBe(first);
    await sql("UPDATE api_tokens SET last_used_at = last_used_at - 61000");
    await withToken(token, "/api/projects");
    expect(await lastUsed()).toBeGreaterThanOrEqual(first as number);
  });
});

describe("managing tokens", () => {
  it("needs a name, and stops at twenty per workspace", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const create = (name: unknown) => call("/api/workspace/tokens", json("POST", { name }, ada));
    expect((await create("")).status).toBe(400);
    expect((await create("x".repeat(61))).status).toBe(400);
    expect((await create(42)).status).toBe(400);

    for (let n = 0; n < 20; n++) expect((await create(`Token ${n}`)).status).toBe(201);
    const full = await create("One too many");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "limit-reached" });
  });

  it("lets the owner revoke anyone's token, and a member only their own", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const invitation = (await (
      await call("/api/workspace/invitations", json("POST", { email: "bob@example.com" }, ada))
    ).json()) as { id: string };
    const bob = await googleLogin("bob@example.com", "Bob");
    await call(`/api/invitations/${invitation.id}/accept`, {
      method: "POST",
      headers: { cookie: bob },
    });

    const adas = await createToken(ada, "Ada's");
    const bobs = await createToken(bob, "Bob's");
    const revoke = (cookie: string, id: string) =>
      call(`/api/workspace/tokens/${id}`, { method: "DELETE", headers: { cookie } });

    // Bob sees both, marked by whose they are.
    const seen = (await (
      await call("/api/workspace/tokens", { headers: { cookie: bob } })
    ).json()) as ApiToken[];
    expect(seen.map((t) => [t.name, t.createdBy, t.yours])).toEqual([
      ["Ada's", "Ada", false],
      ["Bob's", "Bob", true],
    ]);

    expect((await revoke(bob, adas.id)).status).toBe(403);
    expect((await revoke(ada, bobs.id)).status).toBe(200);
    expect((await revoke(ada, "tok_missing")).status).toBe(404);

    // Another workspace cannot see or revoke it.
    const eve = await googleLogin("eve@example.com", "Eve");
    expect(
      await (await call("/api/workspace/tokens", { headers: { cookie: eve } })).json(),
    ).toEqual([]);
    expect((await revoke(eve, adas.id)).status).toBe(404);
  });

  it("goes when the workspace's projects stay: a token is not needed to serve", async () => {
    const { cookie, variant } = await publish();
    const { token, id } = await createToken(cookie);
    await call(`/api/workspace/tokens/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await withToken(token, "/api/projects")).status).toBe(401);
    expect((await call(variant.path)).status).toBe(200);
  });
});
