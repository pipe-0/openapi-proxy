import { serve } from "@hono/node-server";
import { isLoopback } from "@openapi-proxy/core";
import { loadConfig } from "../config.js";
import { bold, dim, note, print, warn } from "../output.js";
import { createServer } from "../server.js";
import { readSourceFlags } from "../sources.js";

export const DEFAULT_PORT = 7745;

/**
 * Serve the variants of a definition file on this machine, at the paths the
 * service has. Runs until it is stopped.
 */
export async function dev(options: {
  config: string;
  sources: string[];
  port: number;
  host: string;
  allowedHosts: string[];
}): Promise<number> {
  // Found out now, not on the first request: a file that cannot be read, a flag that names no source.
  const config = loadConfig(options.config);
  readSourceFlags(options.sources, config.definition);

  const app = createServer({
    config: options.config,
    sources: options.sources,
    allowedHosts: options.allowedHosts,
  });
  await new Promise<void>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: options.port, hostname: options.host }, () =>
      resolve(),
    );
    server.on("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${options.port} is in use. Stop what is using it, or pick another: --port <number>.`,
            )
          : error,
      ),
    );
    const stop = () => server.close(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

  const shown =
    isLoopback(options.host) || options.host === "127.0.0.1" ? "localhost" : options.host;
  const origin = `http://${shown}:${options.port}`;
  const { definition } = config;
  const slugs = Object.keys(definition.variants);
  print(`${bold("openapi-proxy")} is serving ${options.config}`);
  print();
  for (const slug of slugs) print(`  ${origin}/v/${definition.project}/${slug}.json`);
  if (slugs.length === 0) print(dim("  The file has no variants yet."));
  print();
  note(dim("Also as .yaml, and as OpenAPI 3.0 or 3.1 at /3.0.json and /3.1.json."));
  note(dim("The file and its sources are read on every request. Stop with Ctrl+C."));
  if (!isLoopback(options.host) || options.allowedHosts.length > 0) {
    warn(
      "This server can be reached from beyond this machine. Whoever reaches it can read every variant, private ones too.",
    );
  }
  // Keeps running: the server holds the process open.
  return new Promise<number>(() => {});
}
