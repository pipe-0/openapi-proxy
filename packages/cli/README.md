# @pipe0/openapi-proxy

Your backend generates one OpenAPI document for everything it does. Your public docs, your SDK generator and your partners should each get a part of it. This tool keeps the selection for each audience in one file in your repository, serves the filtered documents on localhost while you develop, and deploys them from CI to stable URLs at [openapi-proxy.app](https://openapi-proxy.app) or an instance of your own.

Every filtered document is a valid, self-contained OpenAPI document: the operations you chose and exactly the schemas, parameters, responses and security schemes they reference. It can merge the documents of several services into one API, and serves each result as JSON or YAML, in OpenAPI 3.0 or 3.1.

## Try it in 30 seconds

```sh
npx @pipe0/openapi-proxy init https://petstore3.swagger.io/api/v3/openapi.json
npx @pipe0/openapi-proxy dev
```

The first command writes `openapi-proxy.yaml` for that document, with one variant called `public` that serves nothing yet. The project's slug in it comes from the document's title. The second command prints two addresses:

```
openapi-proxy is serving openapi-proxy.yaml

  http://localhost:7745/v/swagger-petstore-openapi-3-0/public.json

  Edit the file in your browser: http://localhost:7745
```

Open the second one, check the operations the variant should serve, and save. The first address now serves that selection. Point a tool at it:

```sh
npx openapi-typescript http://localhost:7745/v/swagger-petstore-openapi-3-0/public.json -o ./api.types.ts
```

Use your own document in place of the Petstore: a URL, or a file your build writes.

## Is this for you

There are two ways to use openapi-proxy.

**From your repository.** What each audience gets is written in a file next to your code. You serve it on localhost while you work, and deploy it from CI.

**From a URL.** Your OpenAPI document is at a URL. The service reads it, keeps reading it, and you choose in the app what each audience gets.

This package is the first way. For the second you need nothing installed: connect the URL at [openapi-proxy.app](https://openapi-proxy.app). Both make the same thing, and a project that started in the app can be copied into a file later.

## The file

```yaml
# openapi-proxy.yaml
version: 1
project: bookshop # the first part of every URL: /v/bookshop/<variant>

sources:
  - file: ./openapi.json # or url: https://api.example.com/openapi.json

variants:
  public: # served at /v/bookshop/public.json
    include:
      tags: [Books, Orders]
    exclude:
      operations: [GET /orders/export]
  internal: {} # no include: everything, also what the API adds later
```

| Key          | What it says                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`    | The version of this format. Always `1`.                                                                                                                                                                                                                                                     |
| `project`    | The project's slug, and the first part of every URL it serves.                                                                                                                                                                                                                              |
| `name`       | What the project is called in the app.                                                                                                                                                                                                                                                      |
| `instance`   | The address of a self-hosted instance to deploy to. Left out: `https://openapi-proxy.app`.                                                                                                                                                                                                  |
| `visibility` | `public` or `private`, for every variant that does not say itself.                                                                                                                                                                                                                          |
| `overrides`  | `title`, `description` and `servers` for every variant but the original, in place of the document's.                                                                                                                                                                                        |
| `sources`    | The OpenAPI documents. Each has a `url` or a `file`. With several, each has a `name`, one sets `main` to `true`, and a `pathPrefix` mounts one under a path. On a `url`, `follow` set to `true` makes the service keep reading it between deploys.                                          |
| `variants`   | The documents served, by slug. Each can have a `name`, an `icon`, a `visibility`, `include` and `exclude` (each with `tags` and `operations`), and `overrides` of its own. Every project also serves `original`, its documents as they are; the file names it only to set its `visibility`. |

An operation is its method and path, `GET /books/{id}`. A tag stands for every operation that carries it, also for ones your API adds later. `exclude` wins over `include`. A name the documents do not have is a warning, never an error, so a file can be deployed before the API it describes.

Every key, with examples: [the configuration reference](https://openapi-proxy.app/docs/configuration). Editors that read the first line of the file check it as you type:

```yaml
# yaml-language-server: $schema=https://openapi-proxy.app/schema/definition.v1.json
```

The schema of the installed version is also in the package, as `schema.json`.

## Commands

| Command                            | What it does                                                   | Needs a key |
| ---------------------------------- | -------------------------------------------------------------- | ----------- |
| `openapi-proxy init <url or file>` | Writes a first `openapi-proxy.yaml` for a document             | No          |
| `openapi-proxy dev`                | Serves the variants on localhost, with a page to edit the file | No          |
| `openapi-proxy validate`           | Checks the file, and its names against the documents           | No          |
| `openapi-proxy operations`         | Lists the operations and tags of the documents                 | No          |
| `openapi-proxy deploy`             | Sends the file and its documents to the service                | Yes         |

- `--config <file>` names another file than `openapi-proxy.yaml`, on every command.
- `--source [name=]<location>` reads a source from somewhere else for this run, on `dev`, `validate` and `operations`. While you develop, that is your dev server: `openapi-proxy dev --source http://localhost:8080/openapi.json`.
- `--help` after a command shows its options.

Every option: [the CLI reference](https://openapi-proxy.app/docs/cli).

## Deploy from CI

A deploy reads the sources where it runs and uploads them with the file. The project with the file's slug becomes what the file says: it is created if it is not there, and variants the file no longer lists are deleted.

```yaml
# .github/workflows/openapi-proxy.yml
name: OpenAPI documents
on:
  pull_request:
  push:
    branches: [main]

jobs:
  openapi-proxy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npx @pipe0/openapi-proxy validate
      - if: github.event_name == 'push'
        run: npx @pipe0/openapi-proxy deploy
        env:
          OPENAPI_PROXY_DEPLOY_KEY: ${{ secrets.OPENAPI_PROXY_DEPLOY_KEY }}
```

Two things need a person, once: the owner of a workspace creates a deploy API key in the app (Workspace, then Deploy API keys), and stores it as the secret `OPENAPI_PROXY_DEPLOY_KEY` of the pipeline. Such a key can deploy definition files and nothing else.

`openapi-proxy deploy --dry-run` says what a deploy would change, and changes nothing.

The whole setup, step by step: [In your repository](https://openapi-proxy.app/docs/in-your-repository).

## What it does on your machine

- It has no dependencies and no install scripts. Installing it downloads this package and runs nothing.
- It sends nothing anywhere unasked: no telemetry, no update check. `deploy` is the only command that sends your documents somewhere, and it says where.
- `dev` reads the definition file and its sources on every request and keeps nothing in between. A source that cannot be read is an error that names it, never an older copy.
- `dev` writes one file: the definition file, when you save in its editor. A save changes the file where the selection changed and leaves the rest, comments included, as you wrote it. `--no-editor` serves the variants and writes nothing.
- `dev` listens on `127.0.0.1` and answers only requests addressed to this machine by name, so a page on another website cannot read your documents. `--host` and `--allowed-host` open it up for containers and tunnels, and it then says who can reach it.
- The deploy key is read from the environment, never from the file or a flag.

It needs Node 20 or later.

## For agents

Every page of the docs is plain Markdown: [`/docs/in-your-repository.md`](https://openapi-proxy.app/docs/in-your-repository.md) is the guide for setting up a repository, and [`/llms.txt`](https://openapi-proxy.app/llms.txt) lists the rest.

## License

MIT. What it bundles is listed with its licenses in `dist/THIRD-PARTY-NOTICES.txt` and `dist/editor/THIRD-PARTY-NOTICES.txt`. The service it deploys to has its source in [the same repository](https://github.com/pipe-0/openapi-proxy), under FSL-1.1-MIT, and can be self-hosted.
