import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addAnnotation,
  cancelTask,
  clearApiKey,
  clearAccessToken,
  createExportJob,
  createTask,
  deleteTask,
  exportTask,
  flushState,
  getBlock,
  getExportJob,
  getBlockPrompt,
  getServiceOverview,
  getSettings,
  getResolvedAccessTokenState,
  getAdminAuthState,
  getTask,
  getTaskStatus,
  isAdminAuthConfigured,
  listTasks,
  loginAdminAccount,
  logoutAdminSession,
  pauseTask,
  persistApiKeyToDotenv,
  persistAccessTokenToDotenv,
  readExportJobArtifact,
  registerAdminAccount,
  testProviderConnection,
  resumeTask,
  reparseTask,
  retranslateBlock,
  retranslateBlocksBatch,
  searchTaskBlocks,
  SERVICE_INFO,
  startBlockTranslation,
  startTaskTranslation,
  updateBlock,
  updateAdminAccount,
  updateSettings,
  verifyAdminAuthSession
} from "./lib/task-service.js";
import { buildApiDocs } from "./lib/api-docs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const openApiFilePath = path.join(rootDir, "docs", "openapi.yaml");
const webDistDir = path.join(rootDir, "web", "dist");
const webIndexFilePath = path.join(webDistDir, "index.html");
const port = Number(process.env.PORT || 8787);
const startedAt = Date.now();
let nextRequestId = 1;
const FRONTEND_MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".map", "application/json; charset=utf-8"]
]);
const CORS_ALLOW_HEADERS = "Content-Type, Authorization, X-Access-Token";
const CORS_ALLOW_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const CORS_EXPOSE_HEADERS = "Content-Disposition";

function buildContentDisposition(filename = "download.bin") {
  const raw = String(filename || "download.bin");
  const asciiFallback = raw
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_")
    .trim() || "download.bin";
  const encoded = encodeURIComponent(raw);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

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

function requestOrigin(request) {
  const proto = request.socket.encrypted ? "https" : "http";
  const host = request.headers.host || `localhost:${port}`;
  return `${proto}://${host}`;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }

  if (typeof value !== "string") {
    return "";
  }

  return value.split(",")[0].trim();
}

function normalizeBasePath(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return "";
  }

  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return normalized.replace(/\/+$/, "") || "";
}

function normalizePublicBaseUrl(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    const basePath = normalizeBasePath(parsed.pathname);
    parsed.pathname = basePath || "/";
    return basePath ? `${parsed.origin}${basePath}` : parsed.origin;
  } catch {
    return "";
  }
}

function extractBasePath(publicBaseUrl = "") {
  if (!publicBaseUrl) {
    return "";
  }

  try {
    return normalizeBasePath(new URL(publicBaseUrl).pathname);
  } catch {
    return "";
  }
}

function stripBasePath(pathname, basePath) {
  if (!basePath) {
    return pathname || "/";
  }

  if (pathname === basePath) {
    return "/";
  }

  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length) || "/";
  }

  return pathname || "/";
}

function resolveRuntimeConfig(request) {
  const settings = getSettings();
  const configuredPublicBaseUrl = normalizePublicBaseUrl(settings.publicBaseUrl);

  if (configuredPublicBaseUrl) {
    const basePath = extractBasePath(configuredPublicBaseUrl);
    return {
      trustProxyHeaders: Boolean(settings.trustProxyHeaders),
      publicBaseUrl: configuredPublicBaseUrl,
      basePath,
      apiBasePath: `${basePath}/api` || "/api"
    };
  }

  const trustProxyHeaders = Boolean(settings.trustProxyHeaders);
  const forwardedProto = trustProxyHeaders ? firstHeaderValue(request.headers["x-forwarded-proto"]) : "";
  const forwardedHost = trustProxyHeaders ? firstHeaderValue(request.headers["x-forwarded-host"]) : "";
  const forwardedPrefix = trustProxyHeaders ? normalizeBasePath(firstHeaderValue(request.headers["x-forwarded-prefix"])) : "";

  const proto = forwardedProto || (request.socket.encrypted ? "https" : "http");
  const host = forwardedHost || request.headers.host || `localhost:${port}`;
  const publicBaseUrl = `${proto}://${host}${forwardedPrefix}`;

  return {
    trustProxyHeaders,
    publicBaseUrl,
    basePath: forwardedPrefix,
    apiBasePath: `${forwardedPrefix}/api` || "/api"
  };
}

function buildRequestContext(request) {
  const rawUrl = new URL(request.url, requestOrigin(request));
  const runtime = resolveRuntimeConfig(request);
  const pathname = stripBasePath(rawUrl.pathname, runtime.basePath);

  return {
    rawUrl,
    pathname,
    runtime
  };
}

function normalizeClientAddress(value = "") {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

function isLoopbackAddress(value = "") {
  const address = normalizeClientAddress(value);
  return address === "127.0.0.1" || address === "::1";
}

function clientAddressOf(request) {
  const settings = getSettings();
  if (settings.trustProxyHeaders) {
    const forwardedFor = firstHeaderValue(request.headers["x-forwarded-for"]);
    if (forwardedFor) {
      return normalizeClientAddress(forwardedFor);
    }
  }

  return normalizeClientAddress(request.socket.remoteAddress || "");
}

function isLoopbackRequest(request) {
  return isLoopbackAddress(clientAddressOf(request));
}

function assertLocalSecretMutation(request, options = {}) {
  if (isLoopbackRequest(request)) {
    return;
  }

  if (options.allowAuthenticatedApi && isAuthenticatedApiRequest(request, options.pathname || "/api")) {
    return;
  }

  const error = new Error(
    options.allowAuthenticatedApi
      ? "Persisting the API key is only allowed from loopback requests or authenticated API sessions protected by an access token. Open the app from the server's local localhost address, enable API access protection, or edit the .env file manually."
      : "Mutating host environment variables is only allowed from loopback requests. Open the app from the server's local localhost address or edit the .env file manually."
  );
  error.statusCode = 403;
  error.code = "local_only_operation";
  throw error;
}

function presentedAccessTokenOf(request) {
  const authorization = firstHeaderValue(request.headers.authorization);
  if (authorization && /^bearer\s+/i.test(authorization)) {
    return authorization.replace(/^bearer\s+/i, "").trim();
  }

  const tokenHeader = firstHeaderValue(request.headers["x-access-token"]);
  return tokenHeader || "";
}

function requiresApiAuthorization(pathname) {
  if (!pathname.startsWith("/api")) {
    return false;
  }

  return ![
    "/api",
    "/api/docs",
    "/api/openapi.yaml",
    "/api/auth/status",
    "/api/auth/register",
    "/api/auth/login"
  ].includes(pathname);
}

function isAuthenticatedApiRequest(request, pathname) {
  if (!requiresApiAuthorization(pathname)) {
    return false;
  }

  const presentedToken = presentedAccessTokenOf(request);
  if (verifyAdminAuthSession(presentedToken)) {
    return true;
  }

  const expectedToken = getResolvedAccessTokenState().value;
  return Boolean(expectedToken) && presentedToken === expectedToken;
}

function assertAuthorizedApiRequest(request, pathname) {
  if (isAuthenticatedApiRequest(request, pathname)) {
    return;
  }

  const expectedToken = getResolvedAccessTokenState().value;
  const authRequired = Boolean(expectedToken) || isAdminAuthConfigured();
  if (!authRequired || !requiresApiAuthorization(pathname)) {
    return;
  }

  const error = new Error("Login is required for this API.");
  error.statusCode = 401;
  error.code = "unauthorized";
  throw error;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS
  });
  response.end(JSON.stringify(payload, null, 2));
}

function writeText(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS
  });
  response.end(payload);
}

function writeBinary(response, statusCode, payload, contentType, filename) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Content-Disposition": buildContentDisposition(filename),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS
  });
  response.end(payload);
}

function writeBuffer(response, statusCode, payload, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": payload.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
    "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS
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

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function isJsonRequest(request) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  return !contentType || contentType.includes("application/json");
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

function hasBuiltFrontend() {
  return existsSync(webIndexFilePath);
}

function getFrontendContentType(filePath) {
  return FRONTEND_MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function resolveFrontendPath(urlPathname) {
  if (!hasBuiltFrontend()) {
    return null;
  }

  let decodedPath = "/";
  try {
    decodedPath = decodeURIComponent(urlPathname || "/");
  } catch {
    return null;
  }

  const normalizedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const candidatePath = path.resolve(webDistDir, `.${normalizedPath}`);
  if (!candidatePath.startsWith(webDistDir + path.sep) && candidatePath !== webIndexFilePath) {
    return null;
  }

  if (existsSync(candidatePath)) {
    return candidatePath;
  }

  if (!path.extname(normalizedPath)) {
    return webIndexFilePath;
  }

  return null;
}

function rewriteFrontendHtml(html, runtime) {
  const prefix = runtime.basePath || "";
  const runtimeScript = `<script>window.__TRANSLATE_BOOK_RUNTIME__=${JSON.stringify({
    basePath: runtime.basePath,
    apiBasePath: runtime.apiBasePath,
    publicBaseUrl: runtime.publicBaseUrl
  })};</script>`;

  let nextHtml = String(html);
  nextHtml = nextHtml
    .replace(/(src|href)=["']\.\/assets\//g, `$1="${prefix}/assets/`)
    .replace(/(src|href)=["']\/assets\//g, `$1="${prefix}/assets/`)
    .replace(/(src|href)=["']\.\/vite\.svg["']/g, `$1="${prefix}/vite.svg"`)
    .replace(/(src|href)=["']\/vite\.svg["']/g, `$1="${prefix}/vite.svg"`)
    .replace(/(src|href)=["']\.\/favicon\.svg["']/g, `$1="${prefix}/favicon.svg"`)
    .replace(/(src|href)=["']\/favicon\.svg["']/g, `$1="${prefix}/favicon.svg"`);

  if (nextHtml.includes("</head>")) {
    return nextHtml.replace("</head>", `${runtimeScript}</head>`);
  }

  return `${runtimeScript}${nextHtml}`;
}

async function serveFrontend(response, urlPathname, runtime) {
  const frontendPath = resolveFrontendPath(urlPathname);
  if (!frontendPath) {
    return false;
  }

  if (path.extname(frontendPath).toLowerCase() === ".html") {
    const content = await readFile(frontendPath, "utf8");
    writeText(response, 200, rewriteFrontendHtml(content, runtime), getFrontendContentType(frontendPath));
    return true;
  }

  const content = await readFile(frontendPath);
  writeBuffer(response, 200, content, getFrontendContentType(frontendPath));
  return true;
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": CORS_ALLOW_METHODS,
      "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
      "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS
    });
    response.end();
    return;
  }

  const { rawUrl: url, pathname, runtime } = buildRequestContext(request);
  const requestId = nextRequestId++;
  const requestStartedAt = Date.now();

  log("INFO", "request:start", {
    id: requestId,
    method: request.method,
    path: url.pathname,
    resolvedPath: pathname
  });

  response.on("finish", () => {
    log("INFO", "request:end", {
      id: requestId,
      method: request.method,
      path: url.pathname,
      resolvedPath: pathname,
      status: response.statusCode,
      durationMs: Date.now() - requestStartedAt
    });
  });

  try {
    assertAuthorizedApiRequest(request, pathname);

    if (pathname === "/" && request.method === "GET") {
      if (await serveFrontend(response, pathname, runtime)) {
        return;
      }
      sendSuccess(response, 200, {
        ...getServiceOverview({
          publicBaseUrl: runtime.publicBaseUrl,
          basePath: runtime.basePath
        }),
        health: {
          status: "ok",
          uptimeSec: uptimeSeconds()
        }
      });
      return;
    }

    if (pathname === "/health" && request.method === "GET") {
      sendSuccess(response, 200, {
        status: "ok",
        service: SERVICE_INFO.name,
        version: SERVICE_INFO.version,
        uptimeSec: uptimeSeconds(),
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (pathname === "/api" && request.method === "GET") {
      sendSuccess(response, 200, getServiceOverview({
        publicBaseUrl: runtime.publicBaseUrl,
        basePath: runtime.basePath
      }));
      return;
    }

    if (pathname === "/api/docs" && request.method === "GET") {
      sendSuccess(response, 200, buildApiDocs(runtime.publicBaseUrl));
      return;
    }

    if (pathname === "/api/auth/status" && request.method === "GET") {
      sendSuccess(response, 200, getAdminAuthState());
      return;
    }

    if (pathname === "/api/auth/register" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 201, registerAdminAccount(body));
      return;
    }

    if (pathname === "/api/auth/login" && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, loginAdminAccount(body));
      return;
    }

    if (pathname === "/api/auth/logout" && request.method === "POST") {
      sendSuccess(response, 200, logoutAdminSession(presentedAccessTokenOf(request)));
      return;
    }

    if (pathname === "/api/auth/account" && request.method === "PUT") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, updateAdminAccount(body));
      return;
    }

    if ((pathname === "/openapi.yaml" || pathname === "/api/openapi.yaml") && request.method === "GET") {
      const content = await readFile(openApiFilePath, "utf8");
      writeText(response, 200, content, "application/yaml; charset=utf-8");
      return;
    }

    if (pathname === "/api/settings" && request.method === "GET") {
      sendSuccess(response, 200, getSettings());
      return;
    }

    if (pathname === "/api/settings" && request.method === "PUT") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, updateSettings(body));
      return;
    }

    if (pathname === "/api/settings/test-connection" && request.method === "POST") {
      sendSuccess(response, 200, await testProviderConnection());
      return;
    }

    if ((pathname === "/api/settings/api-key/dotenv" || pathname === "/api/settings/api-key/env") && request.method === "POST") {
      assertLocalSecretMutation(request, { allowAuthenticatedApi: true, pathname });
      const body = await readJsonBody(request);
      sendSuccess(response, 200, persistApiKeyToDotenv(body));
      return;
    }

    if ((pathname === "/api/settings/access-token/dotenv" || pathname === "/api/settings/access-token/env") && request.method === "POST") {
      assertLocalSecretMutation(request);
      const body = await readJsonBody(request);
      sendSuccess(response, 200, persistAccessTokenToDotenv(body));
      return;
    }

    if (pathname === "/api/settings/api-key" && request.method === "DELETE") {
      const scope = url.searchParams.get("scope") || "all";
      if (scope !== "session") {
        assertLocalSecretMutation(request, { allowAuthenticatedApi: true, pathname });
      }
      const envVarName = url.searchParams.get("envVarName") || undefined;
      sendSuccess(response, 200, clearApiKey({ scope, envVarName }));
      return;
    }

    if (pathname === "/api/settings/access-token" && request.method === "DELETE") {
      const scope = url.searchParams.get("scope") || "all";
      if (scope !== "session") {
        assertLocalSecretMutation(request);
      }
      sendSuccess(response, 200, clearAccessToken({ scope }));
      return;
    }

    if (pathname === "/api/tasks" && request.method === "GET") {
      sendSuccess(response, 200, listTasks());
      return;
    }

    if (pathname === "/api/tasks" && request.method === "POST") {
      if (isJsonRequest(request)) {
        const body = await readJsonBody(request);
        sendSuccess(response, 201, await createTask(body));
        return;
      }

      const rawBody = await readRawBody(request);
      const filename = url.searchParams.get("filename") || "untitled.epub";
      const documentFormat = url.searchParams.get("documentFormat") || "epub";
      sendSuccess(response, 201, await createTask(
        documentFormat === "epub"
          ? {
              filename,
              documentFormat,
              contentBuffer: rawBody
            }
          : {
              filename,
              documentFormat,
              content: rawBody.toString("utf8")
            }
      ));
      return;
    }

    const taskDetailMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (taskDetailMatch && request.method === "GET") {
      sendSuccess(response, 200, getTask(taskDetailMatch[1]));
      return;
    }

    if (taskDetailMatch && request.method === "DELETE") {
      sendSuccess(response, 200, await deleteTask(taskDetailMatch[1]));
      return;
    }

    const taskParseMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/parse$/);
    if (taskParseMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, await reparseTask(taskParseMatch[1], body));
      return;
    }

    const taskStatusMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (taskStatusMatch && request.method === "GET") {
      const pageSizeParam = url.searchParams.get("pageSize") || undefined;
      const normalizedPageSize = pageSizeParam === "all" ? "all" : (pageSizeParam === undefined ? undefined : Number(pageSizeParam));
      const pageParam = url.searchParams.get("page") || undefined;
      const normalizedPage = pageParam === undefined ? undefined : Number(pageParam);
      const includeBlocksParam = url.searchParams.get("includeBlocks");
      sendSuccess(response, 200, getTaskStatus(taskStatusMatch[1], {
        page: normalizedPage,
        pageSize: normalizedPageSize,
        includeBlocks: includeBlocksParam === "1" || includeBlocksParam === "true"
      }));
      return;
    }

    const taskSearchMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/search$/);
    if (taskSearchMatch && request.method === "GET") {
      sendSuccess(response, 200, searchTaskBlocks(taskSearchMatch[1], {
        query: url.searchParams.get("q") || "",
        pageSize: Number(url.searchParams.get("pageSize") || 20),
        limit: Number(url.searchParams.get("limit") || 50)
      }));
      return;
    }

    const taskPauseMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    if (taskPauseMatch && request.method === "POST") {
      sendSuccess(response, 200, pauseTask(taskPauseMatch[1]));
      return;
    }

    const taskResumeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (taskResumeMatch && request.method === "POST") {
      sendSuccess(response, 200, resumeTask(taskResumeMatch[1]));
      return;
    }

    const taskCancelMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (taskCancelMatch && request.method === "POST") {
      sendSuccess(response, 200, cancelTask(taskCancelMatch[1]));
      return;
    }

    const taskTranslateMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/translate$/);
    if (taskTranslateMatch && request.method === "POST") {
      sendSuccess(response, 200, startTaskTranslation(taskTranslateMatch[1]));
      return;
    }

    const blockDetailMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)$/);
    if (blockDetailMatch && request.method === "GET") {
      sendSuccess(response, 200, getBlock(blockDetailMatch[1], blockDetailMatch[2]));
      return;
    }

    const blockPromptMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)\/prompt$/);
    if (blockPromptMatch && request.method === "GET") {
      sendSuccess(response, 200, getBlockPrompt(blockPromptMatch[1], blockPromptMatch[2]));
      return;
    }

    const blockTranslateMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)\/translate$/);
    if (blockTranslateMatch && request.method === "POST") {
      sendSuccess(response, 200, startBlockTranslation(blockTranslateMatch[1], blockTranslateMatch[2]));
      return;
    }

    const blockRetranslateMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/([^/]+)\/retranslate$/);
    if (blockRetranslateMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, retranslateBlock(blockRetranslateMatch[1], blockRetranslateMatch[2], body));
      return;
    }

    const blockBatchRetranslateMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/blocks\/retranslate-batch$/);
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

    const annotationMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/annotations$/);
    if (annotationMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 200, addAnnotation(annotationMatch[1], body.blockId, body.annotation));
      return;
    }

    const exportJobsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/exports\/jobs$/);
    if (exportJobsMatch && request.method === "POST") {
      const body = await readJsonBody(request);
      sendSuccess(response, 202, createExportJob(exportJobsMatch[1], body));
      return;
    }

    const exportJobDetailMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/exports\/jobs\/([^/]+)$/);
    if (exportJobDetailMatch && request.method === "GET") {
      sendSuccess(response, 200, getExportJob(exportJobDetailMatch[1], exportJobDetailMatch[2]));
      return;
    }

    const exportJobDownloadMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/exports\/jobs\/([^/]+)\/download$/);
    if (exportJobDownloadMatch && request.method === "GET") {
      const result = await readExportJobArtifact(exportJobDownloadMatch[1], exportJobDownloadMatch[2]);
      writeBinary(response, 200, result.payload, result.mimeType, result.filename);
      return;
    }

    const exportMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/exports\/([^/]+)$/);
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

    if (request.method === "GET" && !pathname.startsWith("/api") && pathname !== "/health" && pathname !== "/openapi.yaml") {
      if (await serveFrontend(response, pathname, runtime)) {
        return;
      }
    }

    sendError(response, 404, "not_found", `Route ${request.method} ${pathname} was not found.`);
  } catch (error) {
    const normalized = normalizeError(error);
    log("ERROR", "request:failed", {
      id: requestId,
      method: request.method,
      path: pathname,
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
