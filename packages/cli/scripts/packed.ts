/**
 * The package as people get it: packed the way a release packs it (`pnpm
 * pack`, which is what Changesets runs), installed with npm into an empty
 * folder outside this repository, and used there. Nothing of the workspace is
 * around it, so a file that is missing from the package, or a dependency that
 * was not bundled, fails here and not on someone's machine.
 *
 *   pnpm --filter @pipe0/openapi-proxy test:packed
 *
 * With PACKED_NODE set to the path of another Node, the installed tool is run
 * by that one: CI does this with the oldest version the package says it supports.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const example = join(root, "../../examples/in-your-repository/openapi.json");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};

const step = (line: string) => process.stdout.write(`ok ${line}\n`);
function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const { stderr = "" } = error as { stderr?: string };
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${stderr.trim().split("\n").slice(-15).join("\n")}`,
    );
  }
}

/** A port nothing listens on. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

/** Ask until the server answers. */
async function answering(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${url} did not answer within 10 seconds.`);
}

const work = mkdtempSync(join(tmpdir(), "openapi-proxy-packed-"));
let server: ChildProcess | undefined;
try {
  // 1. Pack it. This runs the build, as a release does.
  const packed = join(work, "packed");
  mkdirSync(packed);
  const tarball = `pipe0-openapi-proxy-${version}.tgz`;
  run("pnpm", ["pack", "--out", join(packed, tarball)], root);
  assert(readdirSync(packed).includes(tarball), "pnpm pack wrote a tarball");
  const files = run("tar", ["-tzf", join(packed, tarball)], work)
    .trim()
    .split("\n");
  const allowed = [
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    "package/schema.json",
  ];
  const stray = files.filter(
    (file) => !file.startsWith("package/dist/") && !allowed.includes(file),
  );
  assert.deepEqual(
    stray,
    [],
    "only the built files, the schema, the README and the license are published",
  );
  for (const needed of [
    ...allowed,
    "package/dist/cli.js",
    "package/dist/editor/index.html",
    // The licenses of what each bundle includes.
    "package/dist/THIRD-PARTY-NOTICES.txt",
    "package/dist/editor/THIRD-PARTY-NOTICES.txt",
  ]) {
    assert(files.includes(needed), `${needed} is in the package`);
  }
  step(`packed ${tarball}: ${files.length} files`);

  // 2. Install it where there is nothing else, without the network: there is nothing to fetch.
  const project = join(work, "project");
  cpSync(example, join(project, "openapi.json"), { recursive: true });
  writeFileSync(join(project, "package.json"), '{ "name": "somewhere-else", "private": true }\n');
  run("npm", ["install", "--offline", "--no-audit", "--no-fund", join(packed, tarball)], project);
  const installed = join(project, "node_modules/@pipe0/openapi-proxy");
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as {
    dependencies?: object;
    scripts?: Record<string, string>;
  };
  assert.equal(manifest.dependencies, undefined, "it has no dependencies");
  for (const script of ["preinstall", "install", "postinstall"]) {
    assert.equal(manifest.scripts?.[script], undefined, `it has no ${script} script`);
  }
  assert.deepEqual(readdirSync(join(project, "node_modules")).sort(), [
    ".bin",
    ".package-lock.json",
    "@pipe0",
  ]);
  // What it bundles is named, each with its license.
  const noticed = (file: string) => readFileSync(join(installed, "dist", file), "utf8");
  for (const name of ["hono", "@hono/node-server", "yaml"]) {
    assert.match(noticed("THIRD-PARTY-NOTICES.txt"), new RegExp(`^  ${name} \\d`, "m"), name);
  }
  for (const name of [
    "react",
    "react-dom",
    "@base-ui/react",
    "lucide-react",
    "@fontsource-variable/inter",
  ]) {
    assert.match(
      noticed("editor/THIRD-PARTY-NOTICES.txt"),
      new RegExp(`^  ${name} \\d`, "m"),
      name,
    );
  }
  step("installed offline, alone in node_modules, with the notices of what it bundles");

  // 3. Use it by the name it is installed under, or with the Node that was asked for.
  const other = process.env.PACKED_NODE;
  const bin = other ?? join(project, "node_modules/.bin/openapi-proxy");
  const tool = (...args: string[]) => (other ? [join(installed, "dist/cli.js"), ...args] : args);
  if (other) step(`running the tool with Node ${run(other, ["--version"], project).trim()}`);
  assert.equal(run(bin, tool("--version"), project).trim(), version);
  assert.match(
    run(bin, tool("init", "./openapi.json"), project),
    /Wrote openapi-proxy.yaml for 8 operations/,
  );
  run(bin, tool("validate"), project);
  const listed = JSON.parse(run(bin, tool("operations", "--json"), project)) as {
    operations: unknown[];
  };
  assert.equal(listed.operations.length, 8);
  step("init, validate and operations");

  // 4. Serve it. The variant `init` wrote serves nothing yet, so give it a tag.
  const config = join(project, "openapi-proxy.yaml");
  const text = readFileSync(config, "utf8");
  assert(text.includes("tags: []"), "init left the selection to be made");
  writeFileSync(config, text.replace("tags: []", "tags: [Books]"));
  const port = await freePort();
  const here = `http://127.0.0.1:${port}`;
  server = spawn(bin, tool("dev", "--port", String(port)), { cwd: project, stdio: "ignore" });
  await answering(here);

  const variant = await fetch(`${here}/v/bookshop/public.json`);
  assert.equal(variant.status, 200);
  const document = (await variant.json()) as { openapi: string; paths: Record<string, object> };
  assert.match(document.openapi, /^3\./);
  assert.deepEqual(Object.keys(document.paths).sort(), ["/books", "/books/{id}"]);
  const older = await fetch(`${here}/v/bookshop/public/3.0.yaml`);
  assert.equal(older.status, 200);
  assert.match(await older.text(), /^openapi: "?3\.0/m);
  step("dev serves the variant, as JSON and as OpenAPI 3.0 in YAML");

  // 5. The editor is in the package too: its page, what the page loads, and what it talks to.
  const page = await fetch(here);
  assert.equal(page.status, 200);
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="\.?(\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(
    assets.some((asset) => asset?.endsWith(".js")),
    "the page loads its script",
  );
  for (const asset of assets) assert.equal((await fetch(`${here}${asset}`)).status, 200, asset);
  const projects = (await (await fetch(`${here}/api/projects`)).json()) as unknown[];
  assert.equal(projects.length, 1);
  step("dev serves the editor");
} finally {
  server?.kill();
  rmSync(work, { recursive: true, force: true });
}
process.stdout.write(
  `\nThe packed @pipe0/openapi-proxy ${version} works outside the repository.\n`,
);
