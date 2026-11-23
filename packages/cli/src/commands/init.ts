import { existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  isLoopback,
  isValidSlug,
  type ProjectDefinition,
  parseSpec,
  SCHEMA_URL,
  slugify,
} from "@openapi-proxy/core";
import type { Config } from "../config.js";
import { bold, dim, plural, print, RUN, warn } from "../output.js";
import { describe } from "../project.js";
import { readSources } from "../sources.js";

const isAddress = (location: string) => /^https?:\/\//i.test(location);

/** A slug for a project, from what its document is called or where it lives. */
function slugFor(title: string | undefined, location: string): string {
  const fromTitle = slugify((title ?? "").replace(/\bapi\b/gi, " "));
  if (isValidSlug(fromTitle)) return fromTitle;
  const fromPlace = slugify(
    isAddress(location)
      ? (new URL(location).hostname.split(".").find((label) => !["api", "www"].includes(label)) ??
          "")
      : (location.split(/[\\/]/).at(-1) ?? "").replace(/\.(json|ya?ml)$/i, ""),
  );
  return isValidSlug(fromPlace) ? fromPlace : "my-api";
}

/** Text as comment lines of a readable width. */
function commentLines(prefix: string, text: string, width = 78): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    if (line !== "" && prefix.length + line.length + 1 + word.length > width) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(prefix + line);
  return lines;
}

/** YAML for a value that is one line of text. */
const yaml = (value: string) => (/^[\w./:@-]+$/.test(value) ? value : JSON.stringify(value));

/**
 * Write a first definition file for a document at an address or in a file.
 * The file holds one variant that serves nothing yet: what it serves is
 * picked in the editor of `dev`, or written by hand from the list of tags
 * that is left in the file as a comment.
 */
export async function init(options: {
  config: string;
  location: string;
  force: boolean;
}): Promise<number> {
  const target = resolve(options.config);
  if (existsSync(target) && !options.force) {
    throw new Error(`${options.config} exists already. Pass --force to write over it.`);
  }

  // The document is read once, to name the project after it and to list its tags.
  const remote = isAddress(options.location);
  // A dev server's address: fine for reading the document now, and nothing a pipeline can reach.
  const local = remote && isLoopback(new URL(options.location).hostname);
  const absolute = remote ? options.location : resolve(options.location);
  const draft: ProjectDefinition = {
    version: 1,
    project: "draft",
    sources: [remote ? { url: options.location } : { file: absolute }],
    variants: {},
  };
  const config: Config = { path: target, dir: dirname(target), text: "", definition: draft };
  const sources = await readSources(config);
  const { index } = describe({ config, sources });
  const info = parseSpec(sources[0]?.text ?? "").doc.info as { title?: unknown } | undefined;
  const title = typeof info?.title === "string" ? info.title : undefined;

  const project = slugFor(title, options.location);
  const fromFile = relative(dirname(target), absolute);
  const file = fromFile.startsWith(".") || isAbsolute(fromFile) ? fromFile : `./${fromFile}`;
  const tags = index.tags.filter((tag) => tag.count > 0);
  const lines = [
    `# yaml-language-server: $schema=${SCHEMA_URL}`,
    "# Every key this file can have: https://openapi-proxy.app/docs/configuration",
    "version: 1",
    `project: ${project}`,
    "",
    "sources:",
    remote ? `  - url: ${yaml(options.location)}` : `  - file: ${yaml(file)}`,
    ...(local
      ? [
          "    # This address is on your machine, so a deploy from a pipeline cannot read",
          "    # it. Put the file or the address the pipeline reads here, and read this",
          `    # one while you work: ${RUN} dev --source ${options.location}`,
        ]
      : remote
        ? [
            "    # A deploy uploads the document it reads from this address. With the next",
            "    # line, the service also keeps reading the address between deploys.",
            "    # follow: true",
          ]
        : []),
    "",
    "variants:",
    "  public:",
    "    # What this variant serves. Nothing yet: pick operations in the editor that",
    "    # `openapi-proxy dev` serves, or name whole tags and single operations here.",
    ...commentLines(
      "    # ",
      tags.length > 0
        ? `Tags in this document: ${tags.map((tag) => `${tag.name} (${tag.count})`).join(", ")}`
        : "",
    ),
    "    include:",
    "      tags: []",
    "",
  ];
  writeFileSync(target, lines.join("\n"));

  print(`Wrote ${bold(options.config)} for ${plural(index.totalOperations, "operation")}.`);
  print();
  print("Next:");
  print(`  ${RUN} dev          ${dim("serve it on localhost and pick what it serves")}`);
  print(`  ${RUN} operations   ${dim("list the operations and tags to pick from")}`);
  print(`  ${RUN} deploy       ${dim("publish it")}`);
  if (local) {
    print();
    warn(
      `${options.location} is on this machine. Before you deploy from a pipeline, put the file or the address it reads into ${options.config}, and read this one with: ${RUN} dev --source ${options.location}`,
    );
  }
  return 0;
}
