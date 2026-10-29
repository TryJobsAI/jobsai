import { config } from "./config.js";
import { startWorker, workerStatus } from "./worker.js";

const server = Bun.serve({
  port: config.port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "ok", service: "jobsai-exec-x1", gitSha: process.env.GIT_SHA ?? "unknown", agents: config.runtimeProfiles.map((profile) => profile.key), worker: workerStatus() });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.info(`JobsAI Exec X1 listening on :${server.port}`);
startWorker();
