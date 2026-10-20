import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export interface RunningServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

/** Starts the HTTP server and resolves once it listens; port 0 picks a free port. */
export function startServer(app: Hono, host: string, port: number): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      server.off("error", reject);
      resolve({
        host,
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
            // Idle keep-alive sockets would otherwise hold the shutdown open.
            (server as Server).closeAllConnections?.();
          }),
      });
    });
    server.once("error", reject);
  });
}

/** Resolves on the first SIGINT or SIGTERM. */
export function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
