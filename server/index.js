import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addAnnotation,
  cancelTask,
  clearApiKey,
  createTask,
  deleteTask,
  exportTask,
  flushState,
  getBlock,
  getBlockPrompt,
  getServiceOverview,
  getSettings,
  getTask,
  getTaskStatus,
  listTasks,
  pauseTask,
  persistApiKeyToDotenv,
  testProviderConnection,
  resumeTask,
  reparseTask,
  retranslateBlock,
  retranslateBlocksBatch,
  SERVICE_INFO,
  startBlockTranslation,
  startTaskTranslation,
  updateBlock,
  updateSettings
} from "./lib/task-service.js";
import { buildApiDocs } from "./lib/api-docs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const openApiFilePath = path.join(rootDir, "docs", "openapi.yaml");
const port = Number(process.env.PORT || 8787);
const startedAt = Date.now();
let nextRequestId = 1;

function formatLogValue(value) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    return value.includes(" ") ? JSON.stringify(value) : value;
  }

  return JSON.stringify(value);
}

function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const details = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");

  console.log(`[${timestamp}] [${level}] ${message}${details ? ` ${details}` : ""}`);
}

function uptimeSeconds() {
  return Math.round((Date.now() - startedAt) / 1000);
}

function originOf(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = typeof forwardedProto === "string" ? forwardedProto.split(",")[0].trim() : "http";
  const host = request.headers.host || `localhost:${port}`;
  return `${proto}://${host}`;
}

function isLoopbackRequest(request) {
  const remoteAddress = request.socket.remoteAddress || "";
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function assertLocalSecretMutation(request) {
  if (!isLoopbackRequest(request)) {
    const error = new Error("Mutating host environment variables is only allowed from loopback requests.");
    error.statusCode = 403;
    error.code = "local_only_operation";
    throw error;
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function writeText(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(payload);
}

function writeBinary(response, statusCode, payload, contentType, filename) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(payload);
}

function sendSuccess(response, statusCode, data) {
  writeJson(response, statusCode, {
    success: true,
    data,
    error: null
  });
}

function sendError(response, statusCode, code, message, details = null) {
  writeJson(response, statusCode, {
    success: false,
    data: null,
    error: {
      code,
      message,
      details
    }
  });
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body is not valid JSON.");
    error.statusCode = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function normalizeError(error) {
  return {
    statusCode: error?.statusCode || 500,
    code: error?.code || "internal_error",
    message: error instanceof Error ? error.message : String(error),
    details: error?.details || null
  };
}

function wantsRawDownload(url) {
  const value = url.searchParams.get("download");
  return value === "1" || value === "true";
}

function bufferFromArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") {
    return Buffer.alloc(0);
  }

  if (artifact.encoding === "base64") {
    return Buffer.from(artifact.content || "", "base64");
  }

  if (artifact.encoding === "json") {
    return Buffer.from(JSON.stringify(artifact.content, null, 2), "utf8");
  }

  return Buffer.from(String(artifact.content ?? ""), "utf8");
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  const url = new URL(request.url, originOf(request));
  const requestId = nextRequestId++;
  const requestStartedAt = Date.now();

  log("INFO", "request:start", {
    id: requestId,
    method: request.method,
    path: url.pathname
  });

  response.on("finish", () => {
    log("INFO", "request:end", {
      id: requestId,
      method: request.method,
      path: url.pathname,
      status: response.statusCode,
      durationMs: Date.now() - requestStartedAt
    });
  });

  try {
    if (url.pathname === "/" && request.method === "GET") {
      sendSuccess(response, 200, {
        ...getServiceOverview(originOf(request)),
        health: {
          status: "ok",
          uptimeSec: uptimeSeconds()
        }
      });
      return;
    }

    if (url.pathname === "/health" && request.method === "GET") {
      sendSuccess(response, 200, {
        status: "ok",
        service: SERVICE_INFO.name,
        version: SERVICE_INFO.version,
        uptimeSec: uptimeSeconds(),
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (url.pathname === "/api" && request.method === "GET") {
      sendSuccess(response, 200, getServiceOverview(originOf(request)));
      return;
    }

    if (url.pathname === "/api/docs" && request.method === "GET") {
      sendSuccess(response, 200, buildApiDocs(originOf(request)));
      return;
    }

    if ((url.pathname === "/openapi.yaml" || url.pathname === "/api/openapi.yaml") && request.method === "GET") {
      const content = await readFile(openApiFilePath, "utf8");
      writeText(response, 200, content, "application/yaml; charset=utf-8");
      return;
    }

    if (url.pathname === "/api/settings" && request.method === "GET") {
      sendSuccess(response, 200, getSettings());
      return;
    }

    if (url.pathname === "/api/settings" && request.method === "PUT") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, updateSettings(body));
      return;
    }

    if (url.pathname === "/api/settings/test-connection" && request.method === "POST") {
      sendSuccess(response, 200, await testProviderConnection());
      return;
    }

    if ((url.pathname === "/api/settings/api-key/dotenv" || url.pathname === "/api/settings/api-key/env") && request.method === "POST") {
      assertLocalSecretMutation(request);
      const body = await readJsonBody(request);
      sendSuccess(response, 200, persistApiKeyToDotenv(body));
      return;
    }

    if (url.pathname === "/api/settings/api-key" && request.method === "DELETE") {
      assertLocalSecretMutation(request);
      const scope = url.searchParams.get("scope") || "all";
      const envVarName = url.searchParams.get("envVarName") || undefined;
      sendSuccess(response, 200, clearApiKey({ scope, envVarName }));
      return;
    }

    if (url.pathname === "/api/tasks" && request.method === "GET") {
      sendSuccess(response, 200, listTasks());
      return;
    }

    if (url.pathname === "/api/tasks" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 201, await createTask(body));
      return;
    }

    const taskDetailMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskDetailMatch && request.method === "GET") {
      sendSuccess(response, 200, getTask(taskDetailMatch[1]));
      return;
    }

    if (taskDetailMatch && request.method === "DELETE") {
      sendSuccess(response, 200, await deleteTask(taskDetailMatch[1]));
      return;
    }

    const taskParseMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/parse$/);
    if (taskParseMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, await reparseTask(taskParseMatch[1], body));
      return;
    }

    const taskStatusMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (taskStatusMatch && request.method === "GET") {
      const pageSizeParam = url.searchParams.get("pageSize") || undefined;
      const normalizedPageSize = pageSizeParam === "all" ? "all" : (pageSizeParam === undefined ? undefined : Number(pageSizeParam));
      const pageParam = url.searchParams.get("page") || undefined;
      const normalizedPage = pageParam === undefined ? undefined : Number(pageParam);
      sendSuccess(response, 200, getTaskStatus(taskStatusMatch[1], {
        page: normalizedPage,
        pageSize: normalizedPageSize
      }));
      return;
    }

    const taskPauseMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    if (taskPauseMatch && request.method === "POST") {
      sendSuccess(response, 200, pauseTask(taskPauseMatch[1]));
      return;
    }

    const taskResumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (taskResumeMatch && request.method === "POST") {
      sendSuccess(response, 200, resumeTask(taskResumeMatch[1]));
      return;
    }

    const taskCancelMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (taskCancelMatch && request.method === "POST") {
      sendSuccess(response, 200, cancelTask(taskCancelMatch[1]));
      return;
    }

    const taskTranslateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/translate$/);
    if (taskTranslateMatch && request.method === "POST") {
      sendSuccess(response, 200, startTaskTranslation(taskTranslateMatch[1]));
      return;
    }

    const blockDetailMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)$/);
    if (blockDetailMatch && request.method === "GET") {
      sendSuccess(response, 200, getBlock(blockDetailMatch[1], blockDetailMatch[2]));
      return;
    }

    const blockPromptMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)\/prompt$/);
    if (blockPromptMatch && request.method === "GET") {
      sendSuccess(response, 200, getBlockPrompt(blockPromptMatch[1], blockPromptMatch[2]));
      return;
    }

    const blockTranslateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)\/translate$/);
    if (blockTranslateMatch && request.method === "POST") {
      sendSuccess(response, 200, startBlockTranslation(blockTranslateMatch[1], blockTranslateMatch[2]));
      return;
    }

    const blockRetranslateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)\/retranslate$/);
    if (blockRetranslateMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, retranslateBlock(blockRetranslateMatch[1], blockRetranslateMatch[2], body));
      return;
    }

    const blockBatchRetranslateMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/retranslate-batch$/);
    if (blockBatchRetranslateMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, retranslateBlocksBatch(blockBatchRetranslateMatch[1], body));
      return;
    }

    if (blockDetailMatch && request.method === "PATCH") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, await updateBlock(blockDetailMatch[1], blockDetailMatch[2], body));
      return;
    }

    const annotationMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/annotations$/);
    if (annotationMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, addAnnotation(annotationMatch[1], body.blockId, body.annotation));
      return;
    }

    const exportMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/exports\/([^/]+)$/);
    if (exportMatch && request.method === "GET") {
      const result = await exportTask(exportMatch[1], exportMatch[2], {
        layout: url.searchParams.get("layout") || undefined
      });

      if (wantsRawDownload(url)) {
        writeBinary(response, 200, bufferFromArtifact(result.export), result.export.mimeType, result.export.filename);
        return;
      }

      sendSuccess(response, 200, result);
      return;
    }

    sendError(response, 404, "not_found", `Route ${request.method} ${url.pathname} was not found.`);
  } catch (error) {
    const normalized = normalizeError(error);
    log("ERROR", "request:failed", {
      id: requestId,
      method: request.method,
      path: url.pathname,
      status: normalized.statusCode,
      code: normalized.code,
      error: normalized.message
    });
    sendError(response, normalized.statusCode, normalized.code, normalized.message, normalized.details);
  }
});

server.on("error", (error) => {
  log("ERROR", "server:error", {
    code: error.code,
    message: error.message,
    port
  });

  if (error.code === "EADDRINUSE") {
    process.exit(1);
  }
});

server.listen(port, () => {
  log("INFO", "server:listening", {
    url: `http://localhost:${port}`,
    mode: "backend-only"
  });
  log("INFO", "server:usage", {
    root: `http://localhost:${port}/`,
    docs: `http://localhost:${port}/api/docs`,
    openapi: `http://localhost:${port}/openapi.yaml`,
    health: `http://localhost:${port}/health`
  });
});

setInterval(() => {
  const memoryMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  log("DEBUG", "server:heartbeat", {
    uptimeSec: uptimeSeconds(),
    rssMb: memoryMb
  });
}, 15000).unref();

let shuttingDown = false;

function closeGracefully(signal, exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log("INFO", "server:shutdown", {
    signal,
    uptimeSec: uptimeSeconds()
  });

  try {
    flushState();
    log("INFO", "state:flushed", { trigger: signal });
  } catch (error) {
    log("ERROR", "state:flush_failed", {
      trigger: signal,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode || 1), 5000).unref();
}

process.on("SIGINT", () => {
  closeGracefully("SIGINT");
});

process.on("SIGTERM", () => {
  closeGracefully("SIGTERM");
});

process.on("unhandledRejection", (error) => {
  log("ERROR", "process:unhandledRejection", {
    error: error instanceof Error ? error.message : String(error)
  });
});

process.on("uncaughtException", (error) => {
  log("ERROR", "process:uncaughtException", {
    error: error.message
  });
});



