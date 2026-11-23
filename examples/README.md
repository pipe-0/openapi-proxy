# Examples

Three definition files, one for each way openapi-proxy is used. Each folder runs as it is:

```sh
cd examples/several-audiences
npx @pipe0/openapi-proxy validate
npx @pipe0/openapi-proxy dev
```

| Folder                                     | What it shows                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`from-a-url`](from-a-url)                 | One document at a URL that the service keeps reading, a public variant and a private one. Try it locally with `--source ./openapi.json`.               |
| [`several-audiences`](several-audiences)   | Two documents merged into one API, project defaults, and a variant each for docs, an SDK, a partner and internal tools.                                |
| [`in-your-repository`](in-your-repository) | The document as a file the build writes, scripts for local development, and a workflow that checks the file on pull requests and deploys it from main. |

The format is described in the [configuration reference](https://openapi-proxy.app/docs/configuration).
