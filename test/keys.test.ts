import { describe, expect, it } from "vitest";
import { GUARDS } from "../src/shared/plans";
import {
  type ApiKey,
  type ApiProject,
  type ApiVariant,
  bearer,
  call,
  callAsProgram,
  createKey,
  createProject,
  createVariant,
  googleLogin,
  json,
  publish,
  SPEC,
  serveSpec,
  sql,
} from "./harness";

const withKey = (key: string, path: string, init: RequestInit = {}) =>
  callAsProgram(path, { ...init, headers: { ...bearer(key), ...init.headers } });
const projects = async (response: Response) => (await response.json()) as ApiProject[];

/** Ada with a project and a key, and Bob in a workspace of his own. */
async function setup() {
  const ada = await googleLogin("ada@example.com", "Ada");
  serveSpec();
  const project = await createProject(ada);
  const { key } = await createKey(ada);
  return { ada, project, key };
}

describe("an API key", () => {
  it("is shown once, and reaches what its maker's session reaches", async () => {
    const { ada, project } = await setup();
    const created = await createKey(ada, "Deploy pipeline");
    expect(created.key).toMatch(/^oap_[0-9a-z]{40}$/);
    expect(created.prefix).toBe(created.key.slice(0, 8));
    expect(created).toMatchObject({ name: "Deploy pipeline", createdBy: "Ada", yours: true });

    const listed = await withKey(created.key, "/api/projects");
    expect(listed.status).toBe(200);
    expect((await projects(listed)).map((p) => p.id)).toEqual([project.id]);

    const me = (await (await withKey(created.key, "/api/me")).json()) as {
      user: { email: string };
      role: string;
    };
    expect(me).toMatchObject({ user: { email: "ada@example.com" }, role: "owner" });
  });

  it("reaches nothing of another workspace", async () => {
    const { project } = await setup();
    const bob = await googleLogin("bob@example.com", "Bob");
    const { key } = await createKey(bob);

    expect(await projects(await withKey(key, "/api/projects"))).toEqual([]);
    expect((await withKey(key, `/api/projects/${project.id}`)).status).toBe(404);
    expect((await withKey(key, `/api/projects/${project.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
    expect(
      (
        await withKey(
          key,
          "/api/variants",
          json("POST", {
            projectId: project.id,
            name: "Mine now",
            selection: {},
          }),
        )
      ).status,
    ).toBe(404);
  });

  it("works for a script: no cookie, no Origin, no body", async () => {
    const { ada, project, key } = await setup();
    const refresh = { method: "POST" };

    // A browser request like this is refused: without an Origin it could be forged.
    const forged = await callAsProgram(`/api/projects/${project.id}/check`, {
      ...refresh,
      headers: { cookie: ada },
    });
    expect(forged.status).toBe(403);

    const checked = await withKey(key, `/api/projects/${project.id}/check`, refresh);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ changed: false });

    // There is one way to present it: `Authorization: Bearer`. Not `X-API-Key`, not a query.
    for (const attempt of [
      callAsProgram("/api/projects", { headers: { "x-api-key": key } }),
      callAsProgram("/api/projects", { headers: { authorization: key } }),
      callAsProgram(`/api/projects?api_key=${key}`),
    ]) {
      expect((await attempt).status).toBe(401);
    }

    serveSpec(SPEC, {}, "https://api.example.com/second.json");
    const created = await withKey(
      key,
      "/api/projects",
      json("POST", { url: "https://api.example.com/second.json" }),
    );
    expect(created.status).toBe(201);
  });

  it("stops working when it is revoked", async () => {
    const { ada, key } = await setup();
    const [listed] = (await (
      await call("/api/workspace/keys", { headers: { cookie: ada } })
    ).json()) as ApiKey[];

    const revoked = await call(`/api/workspace/keys/${listed?.id}`, {
      method: "DELETE",
      headers: { cookie: ada },
    });
    expect(revoked.status).toBe(200);

    const after = await withKey(key, "/api/projects");
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
    const bobs = (await createKey(bob)).key;
    const carols = (await createKey(carol)).key;
    for (const key of [bobs, carols]) {
      expect((await projects(await withKey(key, "/api/projects"))).map((p) => p.id)).toEqual([
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

    expect((await withKey(bobs, "/api/projects")).status).toBe(401);
    expect((await withKey(carols, "/api/projects")).status).toBe(401);
  });

  it("cannot make or revoke keys", async () => {
    const { ada, key } = await setup();
    const made = await withKey(key, "/api/workspace/keys", json("POST", { name: "Another" }));
    expect(made.status).toBe(403);

    const [existing] = (await (
      await call("/api/workspace/keys", { headers: { cookie: ada } })
    ).json()) as ApiKey[];
    const revoked = await withKey(key, `/api/workspace/keys/${existing?.id}`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(403);
    expect((await withKey(key, "/api/projects")).status).toBe(200);
  });

  it("cannot change who is in the workspace, so revoking it ends what it gave", async () => {
    const { ada, key } = await setup();
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

    // Whoever holds the key cannot invite an address of their own...
    const invited = await withKey(
      key,
      "/api/workspace/invitations",
      json("POST", { email: "mallory@example.com" }),
    );
    // ...or remove people, rename the workspace, accept an invitation, or look at who is in it.
    const removed = await withKey(key, `/api/workspace/members/${bobsMembership?.id}`, {
      method: "DELETE",
    });
    const renamed = await withKey(key, "/api/workspace", json("PATCH", { name: "Taken" }));
    const accepted = await withKey(key, `/api/invitations/${invitation.id}/accept`, {
      method: "POST",
    });
    const listed = await withKey(key, "/api/workspace");
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
    const { ada, key } = await setup();
    // A valid session next to a key that is not: the session does not rescue it.
    for (const credential of [`oap_${"0".repeat(40)}`, "nonsense", ""]) {
      const response = await callAsProgram("/api/projects", {
        headers: { cookie: ada, authorization: `Bearer ${credential}` },
      });
      expect(response.status, credential).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    // And the other way round: a valid key decides, whoever the cookie belongs to.
    const bob = await googleLogin("bob@example.com", "Bob");
    const mixed = await callAsProgram("/api/me", {
      headers: { cookie: bob, ...bearer(key) },
    });
    expect(((await mixed.json()) as { user: { email: string } }).user.email).toBe(
      "ada@example.com",
    );
  });

  it("does not exempt sign-in routes from the cross-site check", async () => {
    const { ada, key } = await setup();
    // better-auth's routes only know cookies. A key header must not switch their protection off.
    const signOut = await callAsProgram("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: ada, ...bearer(key), "content-type": "text/plain" },
      body: "{}",
    });
    expect(signOut.status).toBe(403);
    expect((await call("/api/me", { headers: { cookie: ada } })).status).toBe(200);
  });

  it("is never listed, and neither is its hash", async () => {
    const { ada, key } = await setup();
    const listing = await (await call("/api/workspace/keys", { headers: { cookie: ada } })).text();
    expect(listing).not.toContain(key);
    expect(listing).not.toContain(key.slice(8));

    const [stored] = (await sql("SELECT key_hash, prefix FROM api_keys")).results as Array<{
      key_hash: string;
      prefix: string;
    }>;
    expect(stored?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(listing).not.toContain(stored?.key_hash);
    expect(JSON.parse(listing)).toMatchObject([
      { name: "CI", prefix: stored?.prefix, yours: true },
    ]);
    expect(Object.keys((JSON.parse(listing) as object[])[0] ?? {}).sort()).toEqual(
      [
        "access",
        "createdAt",
        "createdBy",
        "id",
        "lastUsedAt",
        "name",
        "prefix",
        "variantId",
        "yours",
      ].sort(),
    );
  });

  it("records roughly when it was last used", async () => {
    const { ada, key } = await setup();
    const lastUsed = async () =>
      (
        (await (await call("/api/workspace/keys", { headers: { cookie: ada } })).json()) as ApiKey[]
      )[0]?.lastUsedAt;
    expect(await lastUsed()).toBeNull();

    await withKey(key, "/api/projects");
    const first = await lastUsed();
    expect(first).toBeGreaterThan(0);

    // Not on every request: once a minute is enough to tell a live key from a dead one.
    await withKey(key, "/api/projects");
    expect(await lastUsed()).toBe(first);
    await sql("UPDATE api_keys SET last_used_at = last_used_at - 61000");
    await withKey(key, "/api/projects");
    expect(await lastUsed()).toBeGreaterThanOrEqual(first as number);
  });
});

describe("managing keys", () => {
  it("needs a name, and stops at a hundred per workspace", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const create = (name: unknown) => call("/api/workspace/keys", json("POST", { name }, ada));
    expect((await create("")).status).toBe(400);
    expect((await create("x".repeat(61))).status).toBe(400);
    expect((await create(42)).status).toBe(400);

    for (let n = 0; n < GUARDS.apiKeys; n++) expect((await create(`Key ${n}`)).status).toBe(201);
    const full = await create("One too many");
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ code: "limit-reached" });
  });

  it("lets the owner revoke anyone's key, and a member only their own", async () => {
    const ada = await googleLogin("ada@example.com", "Ada");
    const invitation = (await (
      await call("/api/workspace/invitations", json("POST", { email: "bob@example.com" }, ada))
    ).json()) as { id: string };
    const bob = await googleLogin("bob@example.com", "Bob");
    await call(`/api/invitations/${invitation.id}/accept`, {
      method: "POST",
      headers: { cookie: bob },
    });

    const adas = await createKey(ada, "Ada's");
    const bobs = await createKey(bob, "Bob's");
    const revoke = (cookie: string, id: string) =>
      call(`/api/workspace/keys/${id}`, { method: "DELETE", headers: { cookie } });

    // Bob sees both, marked by whose they are.
    const seen = (await (
      await call("/api/workspace/keys", { headers: { cookie: bob } })
    ).json()) as ApiKey[];
    expect(seen.map((t) => [t.name, t.createdBy, t.yours])).toEqual([
      ["Ada's", "Ada", false],
      ["Bob's", "Bob", true],
    ]);

    expect((await revoke(bob, adas.id)).status).toBe(403);
    expect((await revoke(ada, bobs.id)).status).toBe(200);
    expect((await revoke(ada, "tok_missing")).status).toBe(404);

    // Another workspace cannot see or revoke it.
    const eve = await googleLogin("eve@example.com", "Eve");
    expect(await (await call("/api/workspace/keys", { headers: { cookie: eve } })).json()).toEqual(
      [],
    );
    expect((await revoke(eve, adas.id)).status).toBe(404);
  });

  it("goes when the workspace's projects stay: a key is not needed to serve", async () => {
    const { cookie, variant } = await publish();
    const { key, id } = await createKey(cookie);
    await call(`/api/workspace/keys/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await withKey(key, "/api/projects")).status).toBe(401);
    expect((await call(variant.path)).status).toBe(200);
  });
});

describe("a private variant", () => {
  const made = async (cookie: string, projectId: string, more: Record<string, unknown> = {}) =>
    (await createVariant(cookie, projectId, { visibility: "private", ...more })) as ApiVariant & {
      visibility: string;
    };
  const statusOf = async (key: string | undefined, path: string) =>
    (key === undefined ? await callAsProgram(path) : await withKey(key, path)).status;

  it("is read with an API key of its workspace, and by no one else", async () => {
    const { ada, project, key } = await setup();
    const variant = await made(ada, project.id);
    expect(variant.visibility).toBe("private");
    const path = `${variant.path}.json`;

    // Nobody in particular is told that it is private, and how it is read.
    const anonymous = await callAsProgram(path);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    expect(((await anonymous.json()) as { error: string }).error).toContain(
      "Authorization: Bearer",
    );
    expect(await statusOf(`oap_${"0".repeat(40)}`, path)).toBe(401);
    // Being signed in is not a key.
    expect((await call(path, { headers: { cookie: ada } })).status).toBe(401);

    const read = await withKey(key, path);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { openapi: string }).openapi).toBe("3.1.0");
    // For this reader alone, and asked for again each time.
    expect(read.headers.get("cache-control")).toBe("private, no-cache");
    expect(read.headers.get("vary")).toBe("Authorization");
    const etag = read.headers.get("etag") as string;
    expect((await withKey(key, path, { headers: { "if-none-match": etag } })).status).toBe(304);
    // Knowing its validator opens nothing.
    expect((await callAsProgram(path, { headers: { "if-none-match": etag } })).status).toBe(401);
    // Every representation is behind the same door.
    for (const other of [variant.path, `${variant.path}.yaml`, `${variant.path}/3.0.json`]) {
      expect(await statusOf(undefined, other)).toBe(401);
      expect(await statusOf(key, other)).toBe(200);
    }
    expect((await callAsProgram(path, { method: "HEAD" })).status).toBe(401);

    // A key of another workspace is a key, and not one for this.
    const bob = await googleLogin("bob@example.com", "Bob");
    expect(await statusOf((await createKey(bob)).key, path)).toBe(403);
    // A revoked key reads nothing.
    const once = await createKey(ada, "Once");
    expect(await statusOf(once.key, path)).toBe(200);
    await call(`/api/workspace/keys/${once.id}`, { method: "DELETE", headers: { cookie: ada } });
    expect(await statusOf(once.key, path)).toBe(401);

    // Made public, it is anyone's again, and says so to caches.
    const opened = await call(
      `/api/variants/${variant.id}`,
      json("PATCH", { visibility: "public" }, ada),
    );
    expect(await opened.json()).toMatchObject({ visibility: "public" });
    const open = await callAsProgram(path);
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toContain("public");
    // The document did not change, so neither did its validator.
    expect(open.headers.get("etag")).toBe(etag);
    expect(
      (await call(`/api/variants/${variant.id}`, json("PATCH", { visibility: "secret" }, ada)))
        .status,
    ).toBe(400);
  });

  it("has keys that only read: every private variant, or one", async () => {
    const { ada, project } = await setup();
    const internal = await made(ada, project.id, { name: "Internal" });
    const partner = await made(ada, project.id, { name: "Partner" });
    const all = await createKey(ada, "Docs build", { access: "read", variantId: null });
    const one = await createKey(ada, "Partner", { access: "read", variantId: partner.id });
    expect(all).toMatchObject({ access: "read", variantId: null });
    expect(one).toMatchObject({ access: "read", variantId: partner.id });

    expect(await statusOf(all.key, `${internal.path}.json`)).toBe(200);
    expect(await statusOf(all.key, `${partner.path}.json`)).toBe(200);
    expect(await statusOf(one.key, `${partner.path}.json`)).toBe(200);
    // The partner's key opens the partner's document and no other.
    const other = await withKey(one.key, `${internal.path}.json`);
    expect(other.status).toBe(403);
    expect(((await other.json()) as { error: string }).error).toContain("does not read");

    // Reading is all they do.
    const api = await withKey(all.key, "/api/projects");
    expect(api.status).toBe(403);
    expect(((await api.json()) as { error: string }).error).toContain("full access");
    expect(
      (await withKey(one.key, `/api/variants/${partner.id}`, { method: "DELETE" })).status,
    ).toBe(403);
    // The list says what each key is for.
    const listed = (await (
      await call("/api/workspace/keys", { headers: { cookie: ada } })
    ).json()) as ApiKey[];
    expect(listed.map(({ name, access, variantId }) => ({ name, access, variantId }))).toEqual([
      { name: "CI", access: "full", variantId: null },
      { name: "Docs build", access: "read", variantId: null },
      { name: "Partner", access: "read", variantId: partner.id },
    ]);

    // Only a key that reads is for one variant, and only for a variant of this workspace.
    const refuse = async (cookie: string, body: object) =>
      (await call("/api/workspace/keys", json("POST", { name: "No", ...body }, cookie))).status;
    expect(await refuse(ada, { access: "full", variantId: partner.id })).toBe(400);
    expect(await refuse(ada, { access: "everything" })).toBe(400);
    // What a key reads is said, never assumed: left out or misspelled, it is not "all".
    expect(await refuse(ada, { access: "read" })).toBe(400);
    expect(await refuse(ada, { access: "read", variant_id: partner.id })).toBe(400);
    const bob = await googleLogin("bob@example.com", "Bob");
    expect(await refuse(bob, { access: "read", variantId: partner.id })).toBe(404);

    // The key goes with its variant: it never comes to read more than it was made for.
    await call(`/api/variants/${partner.id}`, { method: "DELETE", headers: { cookie: ada } });
    expect(await statusOf(one.key, `${internal.path}.json`)).toBe(401);
    expect((await sql("SELECT name FROM api_keys ORDER BY created_at")).results).toEqual([
      { name: "CI" },
      { name: "Docs build" },
    ]);
  });

  it("is what a new variant is, in a workspace that says so", async () => {
    const { ada, project, key } = await setup();
    const workspace = async () =>
      (await (await call("/api/workspace", { headers: { cookie: ada } })).json()) as {
        defaultVisibility: string;
      };
    expect((await workspace()).defaultVisibility).toBe("public");
    expect(await createVariant(ada, project.id, { name: "First" })).toMatchObject({
      visibility: "public",
    });

    const patched = await call(
      "/api/workspace",
      json("PATCH", { defaultVisibility: "private" }, ada),
    );
    expect(patched.status).toBe(200);
    expect((await workspace()).defaultVisibility).toBe("private");
    // From the app, and from a script or an agent alike.
    expect(await createVariant(ada, project.id, { name: "Second" })).toMatchObject({
      visibility: "private",
    });
    const scripted = await withKey(key, "/api/variants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        name: "Third",
        selection: { include: { tags: ["pets"] } },
      }),
    });
    expect(await scripted.json()).toMatchObject({ visibility: "private" });
    // Whoever says what they want gets that.
    expect(
      await createVariant(ada, project.id, { name: "Fourth", visibility: "public" }),
    ).toMatchObject({ visibility: "public" });
    // What exists stays as it is.
    const first = (await (
      await call("/api/variants", { headers: { cookie: ada } })
    ).json()) as Array<{ name: string; visibility: string }>;
    expect(first.find((variant) => variant.name === "First")?.visibility).toBe("public");

    expect(
      (await call("/api/workspace", json("PATCH", { defaultVisibility: "hidden" }, ada))).status,
    ).toBe(400);
  });
});
