/**
 * The two ways a project comes to be, and which is whose. Said in the same
 * words wherever someone has to choose: the app's connect screen, the first
 * page of the docs, the landing page, the README, and the command line tool
 * when it finds no file.
 */
export const WAYS = {
  url: {
    title: "From a URL",
    when: "Your OpenAPI document is at a URL. The service reads it, keeps reading it, and you choose in the app what each audience gets.",
  },
  repository: {
    title: "From your repository",
    when: "What each audience gets is written in a file next to your code. You serve it on localhost while you work, and deploy it from CI.",
  },
} as const;

/** The npm package the command line tool is published as, and the name it is run by. */
export const CLI_PACKAGE = "@pipe0/openapi-proxy";
/** The hosted service: where a definition is deployed unless it names an instance of its own. */
export const HOSTED_URL = "https://openapi-proxy.app";
/** The environment variable a deploy reads its key from. */
export const DEPLOY_KEY_VARIABLE = "OPENAPI_PROXY_API_KEY";
