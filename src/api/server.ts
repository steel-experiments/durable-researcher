// ABOUTME: Bun HTTP server entry point for the durable researcher API.
// ABOUTME: Keeps server boot separate from route handling for testability.

import dotenv from "dotenv";
import { closeDbPool } from "../db-pool.js";
import { createApiHandler } from "./routes.js";

dotenv.config({ override: false });

declare const Bun: {
  serve(opts: { port: number; fetch: (request: Request) => Response | Promise<Response> }): {
    port: number;
    stop(): void;
  };
};

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const handler = createApiHandler();

const server = Bun.serve({
  port,
  fetch: handler,
});

console.log(`Durable Researcher API listening on http://localhost:${server.port}`);

const shutdown = async () => {
  server.stop();
  await closeDbPool();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
