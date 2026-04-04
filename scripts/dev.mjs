import { spawn } from "node:child_process";
import process from "node:process";

const children = [];
let shuttingDown = false;

function start(name, command) {
  const child = spawn(command, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: true
  });

  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      shutdown(code ?? 1);
    }
  });

  child.on("error", (error) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} failed: ${error.message}`);
      shutdown(1);
    }
  });

  children.push(child);
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => process.exit(exitCode), 120).unref();
}

start("api", "node server/index.js");
start("web", process.platform === "win32" ? "npm.cmd run dev --prefix web" : "npm run dev --prefix web");

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
