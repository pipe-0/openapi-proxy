# Changesets

This folder is where a change says how it should be released. One package is published from this repository: the command line tool, `@pipe0/openapi-proxy`. The app and the service are deployed by a push to `main` and have no versions.

A change that users of the tool will notice comes with a changeset:

```sh
pnpm changeset
```

or, without the questions:

```sh
pnpm changeset --patch @pipe0/openapi-proxy -m "What changed, for someone who uses the tool"
```

That writes a small file here. Commit it with the change. `--patch` is for a fix, `--minor` for something new and, before 1.0, for a change that breaks something.

What happens then, and how a release is made, is in [CONTRIBUTING.md](../CONTRIBUTING.md#releasing-the-command-line-tool). The tool itself is documented at https://changesets.dev.
