import { parseArgs } from "node:util";
import { deploy, HOSTED, KEY_VARIABLE } from "./commands/deploy.js";
import { DEFAULT_PORT, dev } from "./commands/dev.js";
import { init } from "./commands/init.js";
import { operations } from "./commands/operations.js";
import { problemLine, validate } from "./commands/validate.js";
import { ConfigError, DEFAULT_CONFIG, NoConfigError } from "./config.js";
import { fail, note, print } from "./output.js";
import { SourceError } from "./sources.js";

const VERSION = "0.1.0";

const HELP = `openapi-proxy: one OpenAPI document in, a document for each audience out.

A definition file in your repository says which documents a project is made
of and which variants are served from them.

Usage
  openapi-proxy <command> [options]

Commands
  init <url or file>   Write a first openapi-proxy.yaml for a document
  dev                  Serve the variants on localhost, with a page to edit the file
  validate             Check the file, and its names against the documents
  operations           List the operations and tags of the documents
  deploy               Send the file and its documents to the service

Options for every command
  --config <file>      The definition file (default: ${DEFAULT_CONFIG})
  --help               Show this, or the help of a command

Start
  npx @pipe0/openapi-proxy init https://api.example.com/openapi.json
  npx @pipe0/openapi-proxy dev
  npx @pipe0/openapi-proxy deploy

Docs: https://openapi-proxy.app/docs
`;

const COMMAND_HELP: Record<string, string> = {
  init: `openapi-proxy init <url or file>

Write a first definition file for the OpenAPI document at an address or in a
file. It gets one variant that serves nothing yet.

Options
  --config <file>   Where to write it (default: ${DEFAULT_CONFIG})
  --force           Write over a file that exists

Example
  openapi-proxy init ./openapi.json
`,
  dev: `openapi-proxy dev

Serve the variants of the definition file on this machine, at the paths the
service has: /v/<project>/<variant>.json. The file and its sources are read on
every request.

The same address in a browser is an editor for the file: pick operations,
see the document they produce, and save. A save changes the file where the
selection changed and leaves the rest, comments included, as you wrote it.

Options
  --config <file>            The definition file (default: ${DEFAULT_CONFIG})
  --source [name=]<location> Read a source from another address or file on this
                             machine. With several sources, name the one meant.
  --port <number>            The port (default: ${DEFAULT_PORT})
  --host <address>           The address to listen on (default: 127.0.0.1)
  --allowed-host <host>      A host, besides localhost, that requests may be
                             addressed to. Repeat for several; ".example.com"
                             allows every host under it.
  --no-editor                Serve the variants only, and nothing that writes

Example
  openapi-proxy dev --source http://localhost:8080/openapi.json
`,
  validate: `openapi-proxy validate

Check the definition file against the format, and the operations and tags it
names against the documents. Exits with 1 if the file is not valid. A name the
documents do not have is a warning: the API may not have it yet.

Options
  --config <file>            The definition file (default: ${DEFAULT_CONFIG})
  --source [name=]<location> Read a source from another address or file

Example
  openapi-proxy validate --source ./openapi.json
`,
  operations: `openapi-proxy operations

List every operation of the project's documents with its tags, and the tags
with how many operations each has. This is what include and exclude name.

Options
  --config <file>            The definition file (default: ${DEFAULT_CONFIG})
  --source [name=]<location> Read a source from another address or file
  --tag <tag>                Only operations with this tag
  --variant <slug>           Say for each operation whether this variant serves it
  --json                     As JSON

Example
  openapi-proxy operations --tag Billing --variant public
`,
  deploy: `openapi-proxy deploy

Read the documents the definition file names, here, and send them with the
file to the service. The project with the file's slug becomes what the file
says: it is created if it is not there, variants the file does not list are
deleted, and from then on it is changed by deploying, not in the app.

A source with follow: true is also kept current by the service. Every other
document stays as deployed until the next deploy.

Needs a deploy API key in ${KEY_VARIABLE}. The owner of the workspace creates
one in the app, under Workspace.

Options
  --config <file>   The definition file (default: ${DEFAULT_CONFIG})
  --dry-run         Say what would change, and change nothing

Deploys to ${HOSTED}, or to the instance the file names.

Example
  ${KEY_VARIABLE}=oap_... openapi-proxy deploy --dry-run
`,
};

/** What to say when there is no definition file: where to start. */
function noConfig(path: string): void {
  fail(`There is no ${path} here.`);
  note("");
  note("A definition file says which OpenAPI documents a project is made of and");
  note("which variants are served from them. To write a first one:");
  note("");
  note("  openapi-proxy init <url or file of your OpenAPI document>");
  note("");
  note("If your document is at a URL and you want variants without a file in a");
  note("repository, connect the URL at https://openapi-proxy.app instead.");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    print(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    print(VERSION);
    return 0;
  }
  if (!(command in COMMAND_HELP)) {
    fail(`"${command}" is not a command.`);
    note("");
    note(HELP);
    return 1;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string", default: DEFAULT_CONFIG },
      source: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", short: "h", default: false },
      force: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      "allowed-host": { type: "string", multiple: true, default: [] },
      tag: { type: "string" },
      variant: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "no-editor": { type: "boolean", default: false },
    },
  });
  if (values.help) {
    print(COMMAND_HELP[command] as string);
    return 0;
  }

  const common = { config: values.config, sources: values.source };
  switch (command) {
    case "init": {
      const [location] = positionals;
      if (!location) {
        throw new Error("Say where the OpenAPI document is: openapi-proxy init <url or file>.");
      }
      return init({ config: values.config, location, force: values.force });
    }
    case "dev": {
      const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`--port ${values.port} is not a port number.`);
      }
      return dev({
        ...common,
        port,
        host: values.host,
        allowedHosts: values["allowed-host"],
        editor: !values["no-editor"],
      });
    }
    case "validate":
      return validate(common);
    case "deploy":
      if (values.source.length > 0) {
        throw new Error(
          "deploy takes no --source: it reads what the file says, so that what is deployed is what is in the repository.",
        );
      }
      return deploy({ config: values.config, dryRun: values["dry-run"] });
    default:
      return operations({
        ...common,
        tag: values.tag,
        variant: values.variant,
        json: values.json,
      });
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof NoConfigError) {
      noConfig(error.path);
    } else if (error instanceof ConfigError) {
      for (const problem of error.problems) fail(problemLine(error.path, problem));
    } else if (error instanceof SourceError) {
      fail(error.message);
    } else {
      fail(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  },
);
