import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { readFile as readFileAsync, rm as rmAsync, writeFile as writeFileAsync } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_PROMPT_TEMPLATE,
  DEFAULT_SETTINGS,
  RETRANSLATION_PROMPT_TEMPLATE,
  SYSTEM_PROMPT
} from "../data/default-prompts.js";
import { resolveExportLanguage } from "./export-language.js";
import { mergeMarkdown, parseMarkdownDocument } from "./markdown.js";
import { buildPdfExport } from "./pdf-export.js";
import { buildEpubExport, parseEpubArchive, removeTaskArtifacts, reparseEpubArchive } from "./epub-service.js";
import { applyEpubPlaceholderBestEffortTranslation, applyEpubPlaceholderTranslation, applyEpubTranslationUnit, buildEpubPlaceholderPlan, buildEpubPreviewFromNormalizedFragment } from "./epub-hotpath.js";
import { testChatCompletionsConnection, translateWithDeepSeek } from "./translation-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const DEFAULT_DB_PATH = path.join(__dirname, "../data/db.json");
const DB_PATH = process.env.MARKDOWN_TRANSLATOR_DB_PATH
  ? path.resolve(process.env.MARKDOWN_TRANSLATOR_DB_PATH)
  : DEFAULT_DB_PATH;
const DOTENV_PATH = path.join(ROOT_DIR, ".env");
const DEFAULT_EXPORT_CACHE_DIR = path.join(__dirname, "../data/export-cache");
const CONFIGURED_EXPORT_CACHE_DIR = process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR
  ? path.resolve(process.env.MARKDOWN_TRANSLATOR_EXPORT_CACHE_DIR)
  : DEFAULT_EXPORT_CACHE_DIR;
const FALLBACK_EXPORT_CACHE_DIR = path.join(os.tmpdir(), "translate-book-export-cache");
let resolvedExportCacheDir = "";

export const SERVICE_INFO = {
  name: "Markdown and EPUB Translator Backend",
  version: "1.5.0",
  description: "A pure REST backend for block-safe Markdown and EPUB translation workflows."
};

export const EXPORT_FORMATS = ["markdown", "markdown_bilingual", "records", "annotations", "mapping", "pdf", "pdf_bilingual", "epub", "epub_bilingual"];
const EXPORT_JOB_STATUSES = ["queued", "running", "completed", "failed"];
export const BLOCK_STATUSES = [
  "idle",
  "queued",
  "translating",
  "paused",
  "translated",
  "failed",
  "edited",
  "retranslated",
  "skipped",
  "cancelled"
];
export const TASK_STAGES = ["parsed", "translating", "paused", "cancelled", "needs_review", "review_ready"];
export const DOCUMENT_FORMATS = ["markdown", "epub"];

const EPUB_SYSTEM_PROMPT = `You are an EPUB translation engine. Translate XHTML fragments into professional Simplified Chinese while keeping the exact root tag, child tag structure, and non-text attributes unchanged. Translate only visible text and translatable alt/title text. Do not translate code, URLs, file paths, CLI commands, API names, CSS class names, or identifiers. Return only one valid XHTML fragment.`;

const tasks = new Map();
const taskTimers = new Map();
const taskAbortControllers = new Map();
const MANAGED_API_KEY_DOTENV_KEY = "MARKDOWN_TRANSLATOR_API_KEY";
const LEGACY_API_KEY_DOTENV_KEYS = ["DEEPSEEK_API_KEY", "TRANSLATOR_API_KEY"];
const DOTENV_API_KEY_KEYS = [MANAGED_API_KEY_DOTENV_KEY, ...LEGACY_API_KEY_DOTENV_KEYS];
const MANAGED_ACCESS_TOKEN_DOTENV_KEY = "MARKDOWN_TRANSLATOR_ACCESS_TOKEN";
const DOTENV_ACCESS_TOKEN_KEYS = [MANAGED_ACCESS_TOKEN_DOTENV_KEY];
const runtimeSecrets = {
  apiKey: "",
  accessToken: ""
};
let appSettings = structuredClone(DEFAULT_SETTINGS);
const PROMPT_CONFIG_FIELDS = [
  "style",
  "glossary",
  "notes",
  "systemPrompt",
  "blockPromptTemplate",
  "retranslationPromptTemplate"
];
const MOJIBAKE_MARKERS = ["?", "?", "?", "?", "?", "?", "?"];
let pendingStateSanitize = false;

function isLikelyMojibake(value = "") {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  return MOJIBAKE_MARKERS.some((marker) => value.includes(marker));
}

function stripSecretFields(settings = {}) {
  const next = { ...settings };
  next.apiKey = "";
  next.accessToken = "";
  delete next.hasApiKey;
  delete next.maskedApiKey;
  delete next.apiKeySource;
  delete next.apiKeyStorageKey;
  delete next.apiKeyPersistence;
  delete next.apiKeyDotenvPath;
  delete next.apiKeyMutationGuard;
  delete next.hasAccessToken;
  delete next.maskedAccessToken;
  delete next.accessTokenSource;
  delete next.accessTokenStorageKey;
  delete next.accessTokenPersistence;
  delete next.accessTokenDotenvPath;
  delete next.accessTokenMutationGuard;
  delete next.authRequired;
  return next;
}

function isDotenvPairLine(line = "") {
  return /^\s*[A-Z_][A-Z0-9_]*\s*=/.test(line);
}

function parseDotenvEntries(raw = "") {
  return String(raw)
    .split(/\r?\n/)
    .map((line) => {
      if (!isDotenvPairLine(line)) {
        return { type: "raw", raw: line };
      }

      const match = line.match(/^(\s*)([A-Z_][A-Z0-9_]*)(\s*=\s*)(.*)$/);
      if (!match) {
        return { type: "raw", raw: line };
      }

      return {
        type: "pair",
        indent: match[1] || "",
        key: match[2],
        separator: match[3] || "=",
        value: match[4] || ""
      };
    });
}

function readDotenvEntries() {
  if (!fs.existsSync(DOTENV_PATH)) {
    return [];
  }

  return parseDotenvEntries(fs.readFileSync(DOTENV_PATH, "utf8"));
}

function decodeDotenvValue(value = "") {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    const quote = trimmed[0];
    const inner = trimmed.slice(1, -1);
    if (quote === '"') {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return inner.replace(/\\'/g, "'");
  }

  return trimmed;
}

function encodeDotenvValue(value = "") {
  const normalized = String(value ?? "");
  if (!normalized) {
    return "";
  }

  if (/^[A-Za-z0-9_./:@-]+$/.test(normalized)) {
    return normalized;
  }

  return JSON.stringify(normalized);
}

function writeDotenvEntries(entries) {
  const lines = entries.map((entry) => {
    if (entry.type === "pair") {
      return `${entry.indent || ""}${entry.key}${entry.separator || "="}${entry.value || ""}`;
    }
    return entry.raw || "";
  });

  let content = lines.join("\n");
  if (content && !content.endsWith("\n")) {
    content += "\n";
  }
  fs.writeFileSync(DOTENV_PATH, content, "utf8");
}

function getDotenvApiKey() {
  const entries = readDotenvEntries();
  for (const keyName of DOTENV_API_KEY_KEYS) {
    const pair = entries.find((entry) => entry.type === "pair" && entry.key === keyName);
    const value = pair ? decodeDotenvValue(pair.value) : "";
    if (value) {
      return {
        value,
        storageKey: keyName,
        scope: "dotenv-file"
      };
    }
  }

  return {
    value: "",
    storageKey: "",
    scope: "none"
  };
}

function getProcessEnvApiKey() {
  for (const keyName of DOTENV_API_KEY_KEYS) {
    const value = typeof process.env[keyName] === "string" ? process.env[keyName].trim() : "";
    if (value) {
      return {
        value,
        storageKey: keyName,
        scope: "environment"
      };
    }
  }

  return {
    value: "",
    storageKey: "",
    scope: "none"
  };
}

function getDotenvAccessToken() {
  const entries = readDotenvEntries();
  for (const keyName of DOTENV_ACCESS_TOKEN_KEYS) {
    const pair = entries.find((entry) => entry.type === "pair" && entry.key === keyName);
    const value = pair ? decodeDotenvValue(pair.value) : "";
    if (value) {
      return {
        value,
        storageKey: keyName,
        scope: "dotenv-file"
      };
    }
  }

  return {
    value: "",
    storageKey: "",
    scope: "none"
  };
}

function getProcessEnvAccessToken() {
  for (const keyName of DOTENV_ACCESS_TOKEN_KEYS) {
    const value = typeof process.env[keyName] === "string" ? process.env[keyName].trim() : "";
    if (value) {
      return {
        value,
        storageKey: keyName,
        scope: "environment"
      };
    }
  }

  return {
    value: "",
    storageKey: "",
    scope: "none"
  };
}

function writeManagedApiKeyToDotenv(apiKey) {
  const entries = readDotenvEntries();
  const nextEntries = [];
  let replaced = false;

  for (const entry of entries) {
    if (entry.type === "pair" && DOTENV_API_KEY_KEYS.includes(entry.key)) {
      if (!replaced) {
        nextEntries.push({
          ...entry,
          key: MANAGED_API_KEY_DOTENV_KEY,
          value: encodeDotenvValue(apiKey)
        });
        replaced = true;
      }
      continue;
    }
    nextEntries.push(entry);
  }

  if (!replaced) {
    if (nextEntries.length && nextEntries[nextEntries.length - 1].type === "raw" && nextEntries[nextEntries.length - 1].raw !== "") {
      nextEntries.push({ type: "raw", raw: "" });
    }
    nextEntries.push({
      type: "pair",
      indent: "",
      key: MANAGED_API_KEY_DOTENV_KEY,
      separator: "=",
      value: encodeDotenvValue(apiKey)
    });
  }

  writeDotenvEntries(nextEntries);
}

function writeManagedAccessTokenToDotenv(accessToken) {
  const entries = readDotenvEntries();
  const nextEntries = [];
  let replaced = false;

  for (const entry of entries) {
    if (entry.type === "pair" && DOTENV_ACCESS_TOKEN_KEYS.includes(entry.key)) {
      if (!replaced) {
        nextEntries.push({
          ...entry,
          key: MANAGED_ACCESS_TOKEN_DOTENV_KEY,
          value: encodeDotenvValue(accessToken)
        });
        replaced = true;
      }
      continue;
    }
    nextEntries.push(entry);
  }

  if (!replaced) {
    if (nextEntries.length && nextEntries[nextEntries.length - 1].type === "raw" && nextEntries[nextEntries.length - 1].raw !== "") {
      nextEntries.push({ type: "raw", raw: "" });
    }
    nextEntries.push({
      type: "pair",
      indent: "",
      key: MANAGED_ACCESS_TOKEN_DOTENV_KEY,
      separator: "=",
      value: encodeDotenvValue(accessToken)
    });
  }

  writeDotenvEntries(nextEntries);
}

function clearManagedApiKeyFromDotenv() {
  const entries = readDotenvEntries();
  const nextEntries = entries.filter((entry) => !(entry.type === "pair" && DOTENV_API_KEY_KEYS.includes(entry.key)));
  writeDotenvEntries(nextEntries);
}

function clearManagedAccessTokenFromDotenv() {
  const entries = readDotenvEntries();
  const nextEntries = entries.filter((entry) => !(entry.type === "pair" && DOTENV_ACCESS_TOKEN_KEYS.includes(entry.key)));
  writeDotenvEntries(nextEntries);
}

function getResolvedApiKey() {
  if (runtimeSecrets.apiKey) {
    return {
      value: runtimeSecrets.apiKey,
      source: "session",
      storageKey: "",
      storageScope: "memory-only"
    };
  }

  const processEnvSecret = getProcessEnvApiKey();
  if (processEnvSecret.value) {
    return {
      value: processEnvSecret.value,
      source: "env",
      storageKey: processEnvSecret.storageKey,
      storageScope: processEnvSecret.scope || "environment"
    };
  }

  const dotenvSecret = getDotenvApiKey();
  if (dotenvSecret.value) {
    return {
      value: dotenvSecret.value,
      source: "dotenv",
      storageKey: dotenvSecret.storageKey,
      storageScope: dotenvSecret.scope || "dotenv-file"
    };
  }

  return {
    value: "",
    source: "none",
    storageKey: "",
    storageScope: "none"
  };
}

function getResolvedAccessToken() {
  if (runtimeSecrets.accessToken) {
    return {
      value: runtimeSecrets.accessToken,
      source: "session",
      storageKey: "",
      storageScope: "memory-only"
    };
  }

  const processEnvSecret = getProcessEnvAccessToken();
  if (processEnvSecret.value) {
    return {
      value: processEnvSecret.value,
      source: "env",
      storageKey: processEnvSecret.storageKey,
      storageScope: processEnvSecret.scope || "environment"
    };
  }

  const dotenvSecret = getDotenvAccessToken();
  if (dotenvSecret.value) {
    return {
      value: dotenvSecret.value,
      source: "dotenv",
      storageKey: dotenvSecret.storageKey,
      storageScope: dotenvSecret.scope || "dotenv-file"
    };
  }

  return {
    value: "",
    source: "none",
    storageKey: "",
    storageScope: "none"
  };
}

function buildEffectiveApiEndpoint(baseUrl = "") {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
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

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw createError(400, "invalid_request", "publicBaseUrl must be a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw createError(400, "invalid_request", "publicBaseUrl must start with http:// or https://.");
  }

  parsed.search = "";
  parsed.hash = "";

  const basePath = normalizeBasePath(parsed.pathname);
  parsed.pathname = basePath || "/";

  return basePath ? `${parsed.origin}${basePath}` : parsed.origin;
}

function extractPublicBasePath(publicBaseUrl = "") {
  if (!publicBaseUrl) {
    return "";
  }

  try {
    return normalizeBasePath(new URL(publicBaseUrl).pathname);
  } catch {
    return "";
  }
}

function buildPublicApiBaseUrl(publicBaseUrl = "") {
  if (!publicBaseUrl) {
    return "";
  }

  return `${publicBaseUrl}/api`;
}

function normalizePersistedSettings(settings = {}) {
  const next = { ...DEFAULT_SETTINGS, ...stripSecretFields(settings) };

  for (const field of PROMPT_CONFIG_FIELDS) {
    if (isLikelyMojibake(next[field])) {
      next[field] = DEFAULT_SETTINGS[field];
    }
  }

  next.publicBaseUrl = normalizePublicBaseUrl(next.publicBaseUrl);
  next.trustProxyHeaders = Boolean(next.trustProxyHeaders);
  next.apiKey = "";
  next.accessToken = "";
  delete next.hasApiKey;
  delete next.maskedApiKey;
  delete next.apiKeySource;
  delete next.apiKeyStorageKey;
  delete next.apiKeyPersistence;
  delete next.apiKeyDotenvPath;
  delete next.hasAccessToken;
  delete next.maskedAccessToken;
  delete next.accessTokenSource;
  delete next.accessTokenStorageKey;
  delete next.accessTokenPersistence;
  delete next.accessTokenDotenvPath;
  delete next.authRequired;
  return next;
}

function loadState() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (data.appSettings) {
        if (
          (typeof data.appSettings.apiKey === "string" && data.appSettings.apiKey.trim()) ||
          (typeof data.appSettings.accessToken === "string" && data.appSettings.accessToken.trim())
        ) {
          pendingStateSanitize = true;
        }
        appSettings = normalizePersistedSettings(data.appSettings);
      }
      if (data.tasks) {
        for (const t of data.tasks) {
          if (t?.config) {
            if (
              (typeof t.config.apiKey === "string" && t.config.apiKey.trim()) ||
              (typeof t.config.accessToken === "string" && t.config.accessToken.trim())
            ) {
              pendingStateSanitize = true;
            }
            t.config = normalizePersistedSettings(t.config);
          } else {
            t.config = normalizePersistedSettings();
          }
          t.documentFormat = t.documentFormat || "markdown";
          t.asset = t.asset || null;
          t.contentVersion = typeof t.contentVersion === "string" && t.contentVersion ? t.contentVersion : (t.updatedAt || t.createdAt || now());
          if (Array.isArray(t.blocks)) {
            for (const block of t.blocks) {
              block.promptSnapshot = null;
              block.annotations = Array.isArray(block.annotations) ? block.annotations : [];
              block.comments = Array.isArray(block.comments) ? block.comments : [];
              block.translationUnit = normalizeEpubTranslationUnit(block.translationUnit);
              if (activeStatus(block.status)) {
                block.status = "paused";
                block.errorMessage = "";
                block.reviewErrorMessage = "";
              }
            }
          }
          t.annotations = Array.isArray(t.annotations) ? t.annotations : [];
          t.comments = Array.isArray(t.comments) ? t.comments : [];
          t.activity = Array.isArray(t.activity) ? t.activity : [];
          t.exportJobs = Array.isArray(t.exportJobs) ? t.exportJobs.map((job) => normalizePersistedExportJob(job)) : [];
          t.runtime = t.runtime && typeof t.runtime === "object" ? t.runtime : { sessionStartedAt: "", pendingQueue: [] };
          t.runtime.sessionStartedAt = typeof t.runtime.sessionStartedAt === "string" ? t.runtime.sessionStartedAt : "";
          t.runtime.pendingQueue = [];
          t.summary = buildSummary(t);
          t.exports = {};
          tasks.set(t.id, t);
        }
      }
    }
  } catch(e) { console.error("Failed to load state", e); }
}

let saveTimeout = null;

function writeStateToDisk() {
  const data = {
    appSettings: normalizePersistedSettings(appSettings),
    tasks: Array.from(tasks.values(), (task) => {
      const nextTask = structuredClone(task);
      nextTask.config = normalizePersistedSettings(nextTask.config);
      nextTask.exports = {};
      nextTask.exportJobs = ensureTaskExportJobs(nextTask).map((job) => normalizePersistedExportJob(job));
      if (nextTask.runtime && typeof nextTask.runtime === "object") {
        nextTask.runtime.pendingQueue = [];
      }
      if (Array.isArray(nextTask.blocks)) {
        for (const block of nextTask.blocks) {
          block.promptSnapshot = null;
        }
      }
      return nextTask;
    })
  };

  if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
}

export function flushState() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }

  try {
    writeStateToDisk();
  } catch (error) {
    console.error("Failed to save state", error);
  }
}

function saveState() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  saveTimeout = setTimeout(() => {
    saveTimeout = null;

    try {
      writeStateToDisk();
    } catch (error) {
      console.error("Failed to save state", error);
    }
  }, 3000);
}

getDotenvApiKey();
loadState();
if (pendingStateSanitize) {
  flushState();
}

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

function markTaskContentChanged(task) {
  task.contentVersion = now();
}

function normalizeExportJobProgress(progress = {}) {
  const percent = Number(progress?.percent);
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0,
    stage: typeof progress?.stage === "string" && progress.stage.trim() ? progress.stage.trim() : "queued",
    detail: typeof progress?.detail === "string" ? progress.detail : "",
    currentStep: Number.isInteger(progress?.currentStep) ? progress.currentStep : 0,
    totalSteps: Number.isInteger(progress?.totalSteps) ? progress.totalSteps : 0
  };
}

function normalizePersistedExportJob(job = {}) {
  const artifact = job?.artifact && typeof job.artifact === "object" ? job.artifact : null;
  return {
    id: typeof job?.id === "string" && job.id ? job.id : randomUUID(),
    format: typeof job?.format === "string" ? job.format : "markdown",
    options: job?.options && typeof job.options === "object" && !Array.isArray(job.options) ? clone(job.options) : {},
    signature: typeof job?.signature === "string" ? job.signature : "",
    sourceVersion: typeof job?.sourceVersion === "string" ? job.sourceVersion : "",
    status: EXPORT_JOB_STATUSES.includes(job?.status) ? job.status : "queued",
    progress: normalizeExportJobProgress(job?.progress),
    createdAt: typeof job?.createdAt === "string" ? job.createdAt : now(),
    startedAt: typeof job?.startedAt === "string" ? job.startedAt : "",
    finishedAt: typeof job?.finishedAt === "string" ? job.finishedAt : "",
    errorMessage: typeof job?.errorMessage === "string" ? job.errorMessage : "",
    artifact: artifact
      ? {
          filename: typeof artifact.filename === "string" ? artifact.filename : "",
          mimeType: typeof artifact.mimeType === "string" ? artifact.mimeType : "application/octet-stream",
          sizeBytes: Number.isFinite(Number(artifact.sizeBytes)) ? Number(artifact.sizeBytes) : 0,
          cachePath: typeof artifact.cachePath === "string" ? artifact.cachePath : "",
          renderer: typeof artifact.renderer === "string" ? artifact.renderer : "",
          generatedAt: typeof artifact.generatedAt === "string" ? artifact.generatedAt : ""
        }
      : null
  };
}

function ensureTaskExportJobs(task) {
  if (!Array.isArray(task.exportJobs)) {
    task.exportJobs = [];
  }
  return task.exportJobs;
}

function directoryIsWritable(directoryPath) {
  try {
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.accessSync(directoryPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getExportCacheDir() {
  if (resolvedExportCacheDir) {
    return resolvedExportCacheDir;
  }

  if (directoryIsWritable(CONFIGURED_EXPORT_CACHE_DIR)) {
    resolvedExportCacheDir = CONFIGURED_EXPORT_CACHE_DIR;
    return resolvedExportCacheDir;
  }

  if (!directoryIsWritable(FALLBACK_EXPORT_CACHE_DIR)) {
    throw createError(500, "export_cache_unwritable", "Export cache directory is not writable.");
  }

  resolvedExportCacheDir = FALLBACK_EXPORT_CACHE_DIR;
  return resolvedExportCacheDir;
}

function pathIsInsideDirectory(parentDirectory, childPath) {
  const relative = path.relative(parentDirectory, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function exportJobCacheAbsolutePath(cachePath = "") {
  const resolved = path.resolve(ROOT_DIR, cachePath || ".");
  if (!pathIsInsideDirectory(getExportCacheDir(), resolved)) {
    throw createError(500, "export_cache_invalid", "Cached export path is invalid.");
  }
  return resolved;
}

function exportJobHasCache(job) {
  if (!job?.artifact?.cachePath) {
    return false;
  }

  try {
    return fs.existsSync(exportJobCacheAbsolutePath(job.artifact.cachePath));
  } catch {
    return false;
  }
}

function exportJobIsStale(task, job) {
  return Boolean(job?.sourceVersion) && job.sourceVersion !== task.contentVersion;
}

function sanitizeExportJob(task, job) {
  const normalized = normalizePersistedExportJob(job);
  return {
    id: normalized.id,
    format: normalized.format,
    options: clone(normalized.options),
    status: normalized.status,
    progress: clone(normalized.progress),
    createdAt: normalized.createdAt,
    startedAt: normalized.startedAt,
    finishedAt: normalized.finishedAt,
    errorMessage: normalized.errorMessage || null,
    filename: normalized.artifact?.filename || "",
    mimeType: normalized.artifact?.mimeType || "",
    sizeBytes: normalized.artifact?.sizeBytes || 0,
    renderer: normalized.artifact?.renderer || "",
    generatedAt: normalized.artifact?.generatedAt || "",
    stale: exportJobIsStale(task, normalized),
    canDownload: normalized.status === "completed" && !exportJobIsStale(task, normalized) && exportJobHasCache(normalized)
  };
}

function artifactBufferFromArtifact(artifact) {
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

function buildExportJobSignature(task, format, options = {}) {
  return JSON.stringify({
    format,
    options,
    contentVersion: task.contentVersion || ""
  });
}

function formatOptionLabel(format, options = {}) {
  if (format === "pdf" || format === "pdf_bilingual") {
    return `PDF (${options.layout || "translation-only"})`;
  }
  if (format === "markdown_bilingual") {
    return "Markdown (bilingual)";
  }
  if (format === "epub_bilingual") {
    return "EPUB (bilingual)";
  }
  return format.toUpperCase();
}

function snapshotTaskForExport(task) {
  return {
    id: task.id,
    filename: task.filename,
    documentFormat: task.documentFormat,
    sourceMarkdown: task.sourceMarkdown,
    config: clone(task.config),
    annotations: clone(task.annotations || []),
    asset: clone(task.asset || null),
    blocks: clone(task.blocks || [])
  };
}

function updateExportJobProgress(task, job, patch = {}, options = {}) {
  job.progress = {
    ...job.progress,
    ...normalizeExportJobProgress({
      ...job.progress,
      ...patch
    })
  };

  refreshTask(task, {
    touchUpdatedAt: false,
    persist: options.persist !== false
  });
}

async function removeTaskExportCache(taskId) {
  const taskCacheDir = path.join(getExportCacheDir(), taskId);
  await rmAsync(taskCacheDir, { recursive: true, force: true });
}

function createError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError(400, "invalid_request", `${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function maskSecret(secret = "") {
  if (!secret) return "";
  if (secret.length <= 4) return "*".repeat(secret.length);
  return `${"*".repeat(secret.length - 4)}${secret.slice(-4)}`;
}

function parseTaskMarkdown(content) {
  try {
    return parseMarkdownDocument(content);
  } catch (error) {
    throw createError(
      422,
      "markdown_parse_failed",
      error instanceof Error ? error.message : "Failed to parse Markdown with remark/mdast."
    );
  }
}

function inferDocumentFormat(filename, requestedFormat) {
  if (requestedFormat !== undefined) {
    const normalized = requireNonEmptyString(requestedFormat, "documentFormat").toLowerCase();
    if (!DOCUMENT_FORMATS.includes(normalized)) {
      throw createError(400, "invalid_request", `documentFormat must be one of ${DOCUMENT_FORMATS.join(", ")}.`);
    }
    return normalized;
  }

  return /\.epub$/i.test(filename) ? "epub" : "markdown";
}

function escapeXmlText(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rebuildTextOnlyEpubFragment(sourceFragment, translatedText) {
  const fragment = String(sourceFragment || "").trim();
  const match = fragment.match(/^(<([^\s/>]+)(?:[^>]*)>)[\s\S]*(<\/\2>)$/);
  if (!match) {
    throw new Error("Failed to rebuild text-only EPUB fragment.");
  }
  return match[1] + escapeXmlText(String(translatedText || "").trim()) + match[3];
}

function unwrapEpubSegmentPayload(payload) {
  let current = payload;

  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current === "string") {
      const trimmed = current.trim();
      if (!trimmed) {
        return "";
      }
      try {
        current = JSON.parse(trimmed);
        continue;
      } catch {
        return trimmed;
      }
    }

    if (current && typeof current === "object" && !Array.isArray(current)) {
      const nestedCandidate =
        current.translations ??
        current.segments ??
        current.items ??
        current.result ??
        current.results ??
        current.data ??
        current.values;

      if (nestedCandidate !== undefined) {
        current = nestedCandidate;
        continue;
      }
    }

    break;
  }

  return current;
}

export function parseEpubTranslatedSegments(rawTranslation, expectedCount, providerLabel = "Provider") {
  const cleaned = String(rawTranslation || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  if (!cleaned) {
    throw new Error(`${providerLabel} returned empty EPUB segment translations.`);
  }

  let payload;
  try {
    payload = JSON.parse(cleaned);
  } catch {
    if (expectedCount === 1) {
      return [cleaned];
    }
    throw new Error(`${providerLabel} did not return valid JSON for EPUB segment translations.`);
  }

  payload = unwrapEpubSegmentPayload(payload);

  if (!Array.isArray(payload)) {
    if (expectedCount === 1) {
      if (typeof payload === "string" && payload.trim()) {
        return [payload.trim()];
      }
      if (payload && typeof payload === "object") {
        const candidate = payload.translation ?? payload.text ?? payload.value;
        if (typeof candidate === "string" && candidate.trim()) {
          return [candidate.trim()];
        }
      }
    }
    throw new Error(`${providerLabel} must return a JSON array for EPUB segment translations.`);
  }

  const translations = payload.map((item) => {
    if (typeof item === "string") {
      return item.trim();
    }
    if (item && typeof item === "object") {
      if (typeof item.translation === "string") {
        return item.translation.trim();
      }
      if (typeof item.text === "string") {
        return item.text.trim();
      }
      if (typeof item.value === "string") {
        return item.value.trim();
      }
    }
    return "";
  });

  if (translations.length !== expectedCount) {
    throw new Error(`${providerLabel} returned ${translations.length} EPUB segments, expected ${expectedCount}.`);
  }

  const emptyIndex = translations.findIndex((value) => value === "");
  if (emptyIndex >= 0) {
    throw new Error(`${providerLabel} returned ${translations.length} EPUB segments, but segment ${emptyIndex + 1} was empty; expected ${expectedCount} non-empty segments.`);
  }

  return translations;
}

function canAttemptEpubSegmentRepair(block, error) {
  if (!block?.translationUnit?.segmentTemplate) {
    return false;
  }

  const expectedCount = Array.isArray(block.translationUnit?.segments) ? block.translationUnit.segments.length : 0;
  if (expectedCount <= 1) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    /did not return valid JSON/i.test(message) ||
    /must return a JSON array/i.test(message) ||
    /returned \d+ EPUB segments/i.test(message) ||
    /expected \d+ non-empty segments/i.test(message)
  );
}

function getEpubPlaceholderPlan(block) {
  return buildEpubPlaceholderPlan(block?.translationUnit, {
    minimumMarkers: 1
  });
}

function shouldUseEpubPlaceholderMode(block) {
  const plan = getEpubPlaceholderPlan(block);
  if (!plan) {
    return false;
  }
  const inlineOrProtectedCount = plan.parts.filter((part) => part.type === "inline" || part.type === "keep").length;
  return inlineOrProtectedCount > 0;
}

function canAttemptEpubPlaceholderRepair(block, error) {
  if (!shouldUseEpubPlaceholderMode(block)) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    /EPUB placeholders/i.test(message) ||
    /placeholder translation/i.test(message) ||
    /inline placeholder/i.test(message)
  );
}

async function repairMalformedEpubSegmentTranslation(task, block, rawTranslation, providerSettings, signal) {
  const segments = Array.isArray(block.translationUnit?.segments) ? block.translationUnit.segments : [];
  const expectedCount = segments.length;

  if (!expectedCount) {
    throw new Error("No EPUB segments are available for repair.");
  }

  const repairPromptSnapshot = {
    systemPrompt: "You repair malformed EPUB segment translation output. Return only a valid JSON array of translated strings.",
    translationPrompt: [
      "Repair the malformed EPUB segment translation output below.",
      `Expected segment count: ${expectedCount}`,
      "Requirements:",
      `- Return only a JSON array with exactly ${expectedCount} translated strings.`,
      "- Keep the same order as the source segments.",
      "- Do not merge, omit, or wrap any segment.",
      "- Remove any markdown fences, objects, or explanations.",
      "- If the previous output merged multiple segments together, split it back to match the numbered source segments.",
      "Source segments:",
      ...segments.map((segment, index) => `${index + 1}. [${segment.kind}] ${segment.sourceText}`),
      "Malformed model output:",
      String(rawTranslation || "")
    ].join("\n"),
    retranslationPrompt: "",
    rawPayload: {
      blockId: block.id,
      expectedCount
    }
  };

  const repairResult = await translateWithDeepSeek({
    provider: providerSettings,
    promptSnapshot: repairPromptSnapshot,
    signal
  });

  const repairedSegments = parseEpubTranslatedSegments(repairResult.translation, expectedCount, providerSettings.apiProvider || "Provider");
  const applied = applyEpubTranslationUnit({
    blockType: block.type,
    sourceMarkdown: block.sourceMarkdown,
    translationUnit: block.translationUnit,
    translatedSegments: repairedSegments
  });

  return {
    ...applied,
    repairedTranslation: repairResult.translation
  };
}

async function repairMalformedEpubPlaceholderTranslation(task, block, rawTranslation, providerSettings, signal) {
  const plan = getEpubPlaceholderPlan(block);
  if (!plan) {
    throw new Error("No EPUB placeholder plan is available for repair.");
  }

  const expectedTokens = plan.placeholderTokens.join(" ");
  const repairPromptSnapshot = {
    systemPrompt: "You repair malformed EPUB placeholder translation output. Return only translated text with the exact placeholders preserved.",
    translationPrompt: [
      "Repair the malformed EPUB placeholder translation output below.",
      "Requirements:",
      "- Return only one translated text string.",
      "- Preserve every placeholder token exactly as written.",
      "- Keep placeholder order exactly the same.",
      "- Do not add JSON, markdown fences, XML, comments, or explanations.",
      "- Do not translate placeholder tokens.",
      "Expected placeholders in order:",
      expectedTokens,
      "Source placeholder text:",
      plan.sourceText,
      "Malformed model output:",
      String(rawTranslation || "")
    ].join("\n"),
    retranslationPrompt: "",
    rawPayload: {
      blockId: block.id,
      placeholderCount: plan.placeholderTokens.length,
      placeholders: plan.placeholderTokens
    }
  };

  const repairResult = await translateWithDeepSeek({
    provider: providerSettings,
    promptSnapshot: repairPromptSnapshot,
    signal
  });

  const applied = applyEpubPlaceholderTranslation({
    blockType: block.type,
    sourceMarkdown: block.sourceMarkdown,
    translationUnit: block.translationUnit,
    rawTranslation: repairResult.translation,
    providerLabel: providerSettings.apiProvider || "Provider"
  });

  return {
    ...applied,
    repairedTranslation: repairResult.translation
  };
}

function applyBestEffortEpubPlaceholderFallback(block, rawTranslation, providerLabel) {
  if (!shouldUseEpubPlaceholderMode(block)) {
    return null;
  }

  return applyEpubPlaceholderBestEffortTranslation({
    blockType: block.type,
    sourceMarkdown: block.sourceMarkdown,
    translationUnit: block.translationUnit,
    rawTranslation,
    providerLabel
  });
}

function buildEpubPromptSnapshot(task, block, overrides = {}) {
  const sourceFragment = block.translationUnit?.sourceFragment || block.sourceMarkdown;
  const sourceText = block.translationUnit?.sourceText || block.sourceMarkdown;
  const textOnly = Boolean(block.translationUnit?.textOnly);
  const segmentMapped = Boolean(block.translationUnit?.segmentMapped);
  const segments = Array.isArray(block.translationUnit?.segments) ? block.translationUnit.segments : [];
  const placeholderPlan = shouldUseEpubPlaceholderMode(block) ? getEpubPlaceholderPlan(block) : null;
  const values = {
    block_type: block.type,
    block_id: block.id,
    document_type: task.config.documentType,
    style: task.config.style,
    glossary: task.config.glossary,
    notes: task.config.notes,
    source_text: textOnly ? sourceText : sourceFragment,
    retranslation_goal: overrides.retranslationGoal || "more_accurate",
    current_translation: textOnly ? (block.translatedMarkdown || "") : (block.translationUnit?.translatedFragment || block.translatedMarkdown || ""),
    focus: overrides.focus || "preserve XHTML structure and terminology consistency"
  };

  const translationPrompt = textOnly
    ? [
        `Translate this EPUB visible text to Chinese.`,
        `Block type: ${block.type}`,
        `Block id: ${block.id}`,
        `Document type: ${task.config.documentType}`,
        `Style: ${task.config.style}`,
        `Glossary:`,
        task.config.glossary || "",
        `Notes:`,
        task.config.notes || "",
        `Requirements:`,
        `- Return only translated plain text.`,
        `- Do not add XML/HTML/XHTML tags, wrappers, markdown fences, or explanations.`,
        `- Preserve terminology consistency.`,
        `Source text:`,
        sourceText
      ].join("\n")
    : placeholderPlan
      ? [
          `Translate this EPUB placeholder text to Chinese.`,
          `Block type: ${block.type}`,
          `Block id: ${block.id}`,
          `Document type: ${task.config.documentType}`,
          `Style: ${task.config.style}`,
          `Glossary:`,
          task.config.glossary || "",
          `Notes:`,
          task.config.notes || "",
          `Requirements:`,
          `- Return only one translated text string.`,
          `- Preserve every placeholder token exactly as written.`,
          `- Keep placeholder token order exactly the same.`,
          `- Do not add or remove placeholder tokens.`,
          `- Do not translate placeholder tokens.`,
          `- Do not add JSON, XML/HTML/XHTML tags, markdown fences, comments, or explanations.`,
          `- Footnote/link placeholders such as [[MTS_KEEP_0001]] must remain unchanged.`,
          `Expected placeholders in order:`,
          placeholderPlan.placeholderTokens.join(" "),
          `Source placeholder text:`,
          placeholderPlan.sourceText
        ].join("\n")
      : segmentMapped
      ? [
          `Translate these EPUB text segments to Chinese.`,
          `Block type: ${block.type}`,
          `Block id: ${block.id}`,
          `Document type: ${task.config.documentType}`,
          `Style: ${task.config.style}`,
          `Glossary:`,
          task.config.glossary || "",
          `Notes:`,
          task.config.notes || "",
          `Requirements:`,
          `- Return only a JSON array of translated strings in the same order as the segments below.`,
          `- Do not return objects, markdown, code fences, XML, or explanations.`,
          `- Keep segment count exactly the same.`,
          `- Example format: ["第1段", "第2段", "第3段"]`,
          `Block preview:`,
          block.sourceMarkdown,
          `Segments:`,
          ...segments.map((segment, index) => `${index + 1}. [${segment.kind}] ${segment.sourceText}`)
        ].join("\n")
      : [
          `Translate this EPUB XHTML fragment to Chinese.`,
          `Block type: ${block.type}`,
          `Block id: ${block.id}`,
          `Document type: ${task.config.documentType}`,
          `Style: ${task.config.style}`,
          `Glossary:`,
          task.config.glossary || "",
          `Notes:`,
          task.config.notes || "",
          `Requirements:`,
          `- Keep exactly the same root tag and child tag structure.`,
          `- Do not add or remove tags, wrappers, comments, or code fences.`,
          `- Keep href, src, id, class, style, epub:type, role, aria-*, and data-* attributes unchanged.`,
          `- Translate only visible text and translatable alt/title text.`,
          `- Do not translate code, URLs, file paths, CLI commands, API names, identifiers, or CSS class names.`,
          `- Return only one valid XHTML fragment.`,
          `Source XHTML fragment:`,
          sourceFragment
        ].join("\n");

  const retranslationPrompt = textOnly
    ? [
        `Retranslate this EPUB visible text to Chinese.`,
        `Goal: ${values.retranslation_goal}`,
        `Block type: ${block.type}`,
        `Block id: ${block.id}`,
        `Focus: ${values.focus}`,
        `Current translation:`,
        values.current_translation,
        `Requirements:`,
        `- Return only translated plain text.`,
        `- Do not add XML/HTML/XHTML tags or explanations.`,
        `Source text:`,
        sourceText
      ].join("\n")
    : placeholderPlan
      ? [
          `Retranslate this EPUB placeholder text to Chinese.`,
          `Goal: ${values.retranslation_goal}`,
          `Block type: ${block.type}`,
          `Block id: ${block.id}`,
          `Focus: ${values.focus}`,
          `Current translation preview:`,
          block.translatedMarkdown || "",
          `Requirements:`,
          `- Return only one translated text string.`,
          `- Preserve every placeholder token exactly as written.`,
          `- Keep placeholder token order exactly the same.`,
          `- Do not add or remove placeholder tokens.`,
          `- Do not translate placeholder tokens.`,
          `- Do not add JSON, XML/HTML/XHTML tags, markdown fences, comments, or explanations.`,
          `Expected placeholders in order:`,
          placeholderPlan.placeholderTokens.join(" "),
          `Source placeholder text:`,
          placeholderPlan.sourceText
        ].join("\n")
      : segmentMapped
      ? [
          `Retranslate these EPUB text segments to Chinese.`,
          `Goal: ${values.retranslation_goal}`,
          `Block type: ${block.type}`,
          `Block id: ${block.id}`,
          `Focus: ${values.focus}`,
          `Current translation preview:`,
          block.translatedMarkdown || "",
          `Requirements:`,
          `- Return only a JSON array of translated strings in the same order as the segments below.`,
          `- Keep segment count exactly the same.`,
          `- Do not return XML, markdown, or explanations.`,
          `- Example format: ["第1段", "第2段", "第3段"]`,
          `Block preview:`,
          block.sourceMarkdown,
          `Segments:`,
          ...segments.map((segment, index) => `${index + 1}. [${segment.kind}] ${segment.sourceText}`)
        ].join("\n")
      : [
          `Retranslate this EPUB XHTML fragment to Chinese.`,
          `Goal: ${values.retranslation_goal}`,
          `Block type: ${block.type}`,
          `Block id: ${block.id}`,
          `Focus: ${values.focus}`,
          `Current translation fragment:`,
          values.current_translation,
          `Requirements:`,
          `- Keep exactly the same XHTML structure.`,
          `- Make only translation changes; do not modify non-text attributes.`,
          `- Return only one valid XHTML fragment.`,
          `Source XHTML fragment:`,
          sourceFragment
        ].join("\n");

  const systemPrompt = placeholderPlan
    ? "You are an EPUB translation engine. Translate the provided placeholder text into professional Simplified Chinese while preserving every [[MTS_*]] placeholder token exactly and in the same order. Return only the translated placeholder text."
    : textOnly
      ? "You are an EPUB translation engine. Translate visible EPUB text into professional Simplified Chinese. Return only translated plain text."
      : segmentMapped
        ? "You are an EPUB translation engine. Translate the provided EPUB text segments into professional Simplified Chinese. Return only a JSON array of translated strings with the exact same item count and order."
        : EPUB_SYSTEM_PROMPT;

  return {
    systemPrompt,
    translationPrompt,
    retranslationPrompt,
    rawPayload: {
      ...values,
      epubMode: placeholderPlan ? "inline-placeholder" : (segmentMapped ? "segment-array" : (textOnly ? "text-only" : "xhtml-fragment")),
      placeholderTokens: placeholderPlan?.placeholderTokens || []
    }
  };
}

async function parseTaskInput({ taskId, filename, content, contentBase64, contentBuffer, documentFormat }) {
  const resolvedFormat = inferDocumentFormat(filename, documentFormat);

  if (resolvedFormat === "epub") {
    const parsed = await parseEpubArchive({ taskId, contentBase64, contentBuffer });
    return {
      documentFormat: resolvedFormat,
      sourceMarkdown: parsed.sourcePreview || "",
      parser: parsed.parser,
      stats: parsed.stats,
      blocks: normalizeParsedBlocks(parsed.blocks),
      asset: parsed.asset
    };
  }

  const markdownContent = requireNonEmptyString(content, "content");
  const parsed = parseTaskMarkdown(markdownContent);
  return {
    documentFormat: resolvedFormat,
    sourceMarkdown: markdownContent,
    parser: parsed.parser,
    stats: parsed.stats,
    blocks: parsed.blocks,
    asset: null
  };
}


function normalizeEpubTranslationUnit(translationUnit) {
  if (!translationUnit || typeof translationUnit !== "object") {
    return null;
  }

  const next = { ...translationUnit };
  if (next.segments === undefined || next.segments === null) {
    next.segments = [];
  } else if (Array.isArray(next.segments)) {
    next.segments = next.segments;
  } else {
    next.segments = [next.segments];
  }
  next.sourceText = typeof next.sourceText === "string" ? next.sourceText : "";
  next.textOnly = Boolean(next.textOnly);
  next.segmentMapped = Boolean(next.segmentMapped);
  next.segmentTemplate = typeof next.segmentTemplate === "string" ? next.segmentTemplate : "";
  next.previewTemplate = typeof next.previewTemplate === "string" ? next.previewTemplate : "";
  return next;
}

function normalizeParsedBlocks(blocks = []) {
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks.map((block) => ({
    ...block,
    reviewState: block?.reviewState || "none",
    reviewCandidateTranslation: typeof block?.reviewCandidateTranslation === "string" ? block.reviewCandidateTranslation : "",
    reviewErrorMessage: typeof block?.reviewErrorMessage === "string" ? block.reviewErrorMessage : "",
    translationUnit: normalizeEpubTranslationUnit(block.translationUnit)
  }));
}

function sanitizeConfig(config) {
  const next = clone(stripSecretFields(config));
  const resolvedApiKey = getResolvedApiKey();
  const resolvedAccessToken = getResolvedAccessToken();
  next.publicBaseUrl = normalizePublicBaseUrl(next.publicBaseUrl);
  next.trustProxyHeaders = Boolean(next.trustProxyHeaders);

  next.apiKey = "";
  next.hasApiKey = Boolean(resolvedApiKey.value);
  next.maskedApiKey = maskSecret(resolvedApiKey.value);
  next.apiKeySource = resolvedApiKey.source;
  next.apiKeyStorageKey = resolvedApiKey.source === "dotenv" ? resolvedApiKey.storageKey : "";
  next.apiKeyPersistence =
    resolvedApiKey.source === "dotenv"
      ? "dotenv-file"
      : resolvedApiKey.source === "session"
        ? "memory-only"
        : resolvedApiKey.source === "env"
          ? "environment"
          : "none";
  next.apiKeyDotenvPath = DOTENV_PATH;
  next.hasAccessToken = Boolean(resolvedAccessToken.value);
  next.maskedAccessToken = maskSecret(resolvedAccessToken.value);
  next.accessTokenSource = resolvedAccessToken.source;
  next.accessTokenStorageKey = ["dotenv", "env"].includes(resolvedAccessToken.source) ? resolvedAccessToken.storageKey : "";
  next.accessTokenPersistence =
    resolvedAccessToken.source === "dotenv"
      ? "dotenv-file"
      : resolvedAccessToken.source === "session"
        ? "memory-only"
        : resolvedAccessToken.source === "env"
          ? "environment"
          : "none";
  next.accessTokenDotenvPath = DOTENV_PATH;
  next.authRequired = Boolean(resolvedAccessToken.value);
  next.apiKeyMutationGuard = "loopback-only";
  next.accessTokenMutationGuard = "loopback-only";
  next.effectiveApiEndpoint = buildEffectiveApiEndpoint(next.apiBaseUrl);
  next.publicApiBaseUrl = buildPublicApiBaseUrl(next.publicBaseUrl);
  next.publicBasePath = extractPublicBasePath(next.publicBaseUrl);

  return next;
}

function sanitizeAsset(asset) {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  return {
    packagePath: asset.packagePath || "",
    title: asset.title || "",
    language: asset.language || "",
    spineCount: Number.isInteger(asset.spineCount) ? asset.spineCount : 0
  };
}

function buildTaskConfig(config = {}) {
  const merged = mergeSettings(stripSecretFields(appSettings), stripSecretFields(config));
  const resolvedApiKey = getResolvedApiKey();
  const resolvedAccessToken = getResolvedAccessToken();

  merged.apiKey = "";
  merged.accessToken = "";
  merged.hasApiKey = Boolean(resolvedApiKey.value);
  merged.maskedApiKey = maskSecret(resolvedApiKey.value);
  merged.apiKeySource = resolvedApiKey.source;
  merged.apiKeyStorageKey = resolvedApiKey.source === "dotenv" ? resolvedApiKey.storageKey : "";
  merged.apiKeyPersistence =
    resolvedApiKey.source === "dotenv"
      ? "dotenv-file"
      : resolvedApiKey.source === "session"
        ? "memory-only"
        : resolvedApiKey.source === "env"
          ? "environment"
          : "none";
  merged.hasAccessToken = Boolean(resolvedAccessToken.value);
  merged.maskedAccessToken = maskSecret(resolvedAccessToken.value);
  merged.accessTokenSource = resolvedAccessToken.source;
  merged.accessTokenStorageKey = ["dotenv", "env"].includes(resolvedAccessToken.source) ? resolvedAccessToken.storageKey : "";
  merged.accessTokenPersistence =
    resolvedAccessToken.source === "dotenv"
      ? "dotenv-file"
      : resolvedAccessToken.source === "session"
        ? "memory-only"
        : resolvedAccessToken.source === "env"
          ? "environment"
          : "none";
  merged.apiKeyDotenvPath = DOTENV_PATH;
  merged.accessTokenDotenvPath = DOTENV_PATH;
  merged.authRequired = Boolean(resolvedAccessToken.value);

  return merged;
}

function getProviderSettings(task) {
  const resolvedApiKey = getResolvedApiKey();

  return {
    apiProvider: task.config.apiProvider,
    apiKey: resolvedApiKey.value,
    apiBaseUrl: task.config.apiBaseUrl,
    model: task.config.model,
    requestTimeoutMs: task.config.requestTimeoutMs
  };
}

function mergeSettings(currentSettings, patch = {}) {
  const next = clone(currentSettings);
  const stringFields = [
    "apiProvider",
    "apiBaseUrl",
    "publicBaseUrl",
    "model",
    "sourceLanguage",
    "targetLanguage",
    "documentType",
    "style",
    "glossary",
    "notes",
    "cacheStrategy",
    "systemPrompt",
    "blockPromptTemplate",
    "retranslationPromptTemplate"
  ];

  for (const field of stringFields) {
    if (patch[field] === undefined) continue;
    if (typeof patch[field] !== "string") {
      throw createError(400, "invalid_request", `${field} must be a string.`);
    }
    next[field] = patch[field];
  }

  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== "string") {
      throw createError(400, "invalid_request", "apiKey must be a string.");
    }
    runtimeSecrets.apiKey = patch.apiKey.trim();
  }

  if (patch.accessToken !== undefined) {
    if (typeof patch.accessToken !== "string") {
      throw createError(400, "invalid_request", "accessToken must be a string.");
    }
    runtimeSecrets.accessToken = patch.accessToken.trim();
  }

  const booleanFields = ["trustProxyHeaders"];
  for (const field of booleanFields) {
    if (patch[field] === undefined) continue;
    if (typeof patch[field] !== "boolean") {
      throw createError(400, "invalid_request", `${field} must be a boolean.`);
    }
    next[field] = patch[field];
  }

  const numberFields = ["retries", "concurrency", "requestTimeoutMs"];
  for (const field of numberFields) {
    if (patch[field] === undefined) continue;
    const value = Number(patch[field]);
    if (!Number.isInteger(value) || value < 0) {
      throw createError(400, "invalid_request", `${field} must be an integer greater than or equal to 0.`);
    }
    next[field] = value;
  }

  next.apiKey = "";
  delete next.hasApiKey;
  delete next.maskedApiKey;
  delete next.apiKeySource;
  delete next.apiKeyStorageKey;
  delete next.apiKeyPersistence;
  delete next.hasAccessToken;
  delete next.maskedAccessToken;
  delete next.accessTokenSource;
  delete next.accessTokenStorageKey;
  delete next.accessTokenPersistence;
  next.publicBaseUrl = normalizePublicBaseUrl(next.publicBaseUrl);
  next.trustProxyHeaders = Boolean(next.trustProxyHeaders);
  return next;
}

function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");
}

function buildPromptSnapshot(task, block, overrides = {}) {
  if (task.documentFormat === "epub") {
    return buildEpubPromptSnapshot(task, block, overrides);
  }

  const values = {
    block_type: block.type,
    block_id: block.id,
    document_type: task.config.documentType,
    style: task.config.style,
    glossary: task.config.glossary,
    notes: task.config.notes,
    source_text: block.sourceMarkdown,
    retranslation_goal: overrides.retranslationGoal || "more_accurate",
    current_translation: block.translatedMarkdown || "",
    focus: overrides.focus || "structure safety and terminology consistency"
  };

  return {
    systemPrompt: task.config.systemPrompt || SYSTEM_PROMPT,
    translationPrompt: renderTemplate(task.config.blockPromptTemplate || BLOCK_PROMPT_TEMPLATE, values),
    retranslationPrompt: renderTemplate(task.config.retranslationPromptTemplate || RETRANSLATION_PROMPT_TEMPLATE, values),
    rawPayload: values
  };
}

function countWords(text) {
  if (!text) return 0;
  const latin = text.match(/[A-Za-z0-9_]+/g)?.length || 0;
  const cjk = text.match(/[\u3400-\u9fff]/gu)?.length || 0;
  return latin + cjk;
}

function translatedStatus(status) {
  return status === "translated" || status === "edited" || status === "retranslated";
}

function activeStatus(status) {
  return status === "queued" || status === "translating";
}

function externallyStoppedStatus(block) {
  if (!block) {
    return "";
  }
  if (block.status === "paused" || block.status === "cancelled") {
    return block.status;
  }
  return "";
}

function canScheduleFromStatus(status) {
  return status === "idle" || status === "failed" || status === "paused" || status === "cancelled";
}

function buildSummary(task) {
  const counts = {
    idle: 0,
    queued: 0,
    translating: 0,
    paused: 0,
    translated: 0,
    failed: 0,
    edited: 0,
    retranslated: 0,
    skipped: 0,
    cancelled: 0,
    locked: 0
  };

  let totalSourceCharacterCount = 0;
  let translatedSourceCharacterCount = 0;
  let translatedTargetCharacterCount = 0;
  let sourceWordCount = 0;
  let translatedWordCount = 0;

  for (const block of task.blocks) {
    if (counts[block.status] !== undefined) {
      counts[block.status] += 1;
    }
    if (block.locked) {
      counts.locked += 1;
    }

    if (block.shouldTranslate) {
      totalSourceCharacterCount += block.sourceMarkdown.length;
      sourceWordCount += countWords(block.sourceMarkdown);
    }

    if (block.shouldTranslate && translatedStatus(block.status)) {
      translatedSourceCharacterCount += block.sourceMarkdown.length;
      translatedTargetCharacterCount += (block.translatedMarkdown || "").length;
      translatedWordCount += countWords(block.translatedMarkdown || "");
    }
  }

  const translatableBlocks = task.blocks.filter((block) => block.shouldTranslate).length;
  const completedBlocks = counts.translated + counts.edited + counts.retranslated;
  const elapsedSeconds = task.runtime.sessionStartedAt
    ? Math.max(1, Math.round((Date.now() - Date.parse(task.runtime.sessionStartedAt)) / 1000))
    : 0;
  const translationSpeed = elapsedSeconds ? Number((translatedWordCount / elapsedSeconds).toFixed(2)) : 0;
  const remainingSourceWords = Math.max(0, sourceWordCount - translatedWordCount);
  const estimatedTimeRemaining = translationSpeed > 0 ? Math.ceil(remainingSourceWords / translationSpeed) : null;

  let stage = "parsed";
  if (counts.translating || counts.queued) {
    stage = "translating";
  } else if (counts.paused) {
    stage = "paused";
  } else if (counts.cancelled && completedBlocks < translatableBlocks) {
    stage = "cancelled";
  } else if (counts.failed) {
    stage = "needs_review";
  } else if (completedBlocks) {
    stage = "review_ready";
  }

  return {
    stage,
    totalBlocks: task.blocks.length,
    translatableBlocks,
    skippedBlocks: counts.skipped,
    completedBlocks,
    progress: translatableBlocks ? Math.round((completedBlocks / translatableBlocks) * 100) : 100,
    activeBlocks: counts.translating,
    totalSourceCharacterCount,
    translatedSourceCharacterCount,
    translatedTargetCharacterCount,
    sourceWordCount,
    translatedWordCount,
    translationSpeed,
    estimatedTimeRemaining,
    counts
  };
}

function exportBaseName(filename) {
  return filename.replace(/\.(md|markdown|epub)$/i, "");
}

function buildExports(task) {
  const baseName = exportBaseName(task.filename);
  const exportLanguage = resolveExportLanguage(task?.config?.targetLanguage);

  return {
    markdown: {
      filename: `${baseName}.${exportLanguage.suffix}.md`,
      mimeType: "text/markdown; charset=utf-8",
      encoding: "utf8",
      content: mergeMarkdown(task.blocks, 'target_only')
    },
    markdown_bilingual: {
      filename: `${baseName}.Bilingual.md`,
      mimeType: "text/markdown; charset=utf-8",
      encoding: "utf8",
      content: mergeMarkdown(task.blocks, 'bilingual')
    },
    records: {
      filename: `${baseName}.translation-records.json`,
      mimeType: "application/json",
      encoding: "json",
      content: task.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        order: block.order,
        headingPath: block.headingPath,
        shouldTranslate: block.shouldTranslate,
        status: block.status,
        locked: block.locked,
        tokenEstimate: block.tokenEstimate,
        retryCount: block.retryCount,
        failureCount: block.failureCount,
        errorMessage: block.errorMessage,
        lastTranslatedAt: block.lastTranslatedAt,
        lastEditedAt: block.lastEditedAt
      }))
    },
    annotations: {
      filename: `${baseName}.annotations.json`,
      mimeType: "application/json",
      encoding: "json",
      content: task.annotations
    },
    mapping: {
      filename: `${baseName}.mapping.json`,
      mimeType: "application/json",
      encoding: "json",
      content: task.blocks.map((block) => ({
        id: block.id,
        type: block.type,
        order: block.order,
        headingPath: block.headingPath,
        sourceRange: block.sourceRange,
        sourceMarkdown: block.sourceMarkdown,
        translatedMarkdown: block.translatedMarkdown || "",
        translationUnit: block.translationUnit || null,
        shouldTranslate: block.shouldTranslate,
        status: block.status,
        locked: block.locked,
        skipReason: block.skipReason
      }))
    }
  };
}

function normalizeExportOptions(format, options = {}) {
  const normalized = {};

  if (format === "pdf" || format === "pdf_bilingual") {
    normalized.layout = typeof options.layout === "string" && options.layout.trim() ? options.layout.trim() : "translation-only";
  }

  if (format === "pdf_bilingual") {
    normalized.layout = "bilingual";
  }

  if (format === "epub") {
    normalized.layout = "translation-only";
  }

  if (format === "epub_bilingual") {
    normalized.layout = "bilingual";
  }

  return normalized;
}

function addActivity(task, type, title, detail) {
  task.activity.unshift({
    id: randomUUID(),
    type,
    title,
    detail,
    at: now()
  });
  task.activity = task.activity.slice(0, 32);
}

function syncTaskReadModel(task, options = {}) {
  if (options.touchUpdatedAt) {
    task.updatedAt = now();
  }

  if (options.rebuildPromptSnapshots) {
    for (const block of task.blocks) {
      block.promptSnapshot = buildPromptSnapshot(task, block);
    }
  }

  task.summary = buildSummary(task);

  if (options.rebuildExports) {
    task.exports = buildExports(task);
  } else if (task.exports && Object.keys(task.exports).length) {
    task.exports = {};
  }
}

function refreshTask(task, options = {}) {
  syncTaskReadModel(task, {
    touchUpdatedAt: options.touchUpdatedAt !== false,
    rebuildPromptSnapshots: options.rebuildPromptSnapshots === true,
    rebuildExports: options.rebuildExports === true
  });
  if (options.persist !== false) {
    saveState();
  }
}

function sanitizeTask(task) {
  const next = clone(task);
  next.config = sanitizeConfig(task.config);
  next.asset = sanitizeAsset(task.asset);
  next.exportJobs = ensureTaskExportJobs(task).map((job) => sanitizeExportJob(task, job));
  return next;
}

function summarizeTask(task) {
  return {
    id: task.id,
    filename: task.filename,
    source: task.source,
    documentFormat: task.documentFormat || "markdown",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    stage: task.summary.stage,
    parser: task.parser,
    stats: task.stats,
    summary: task.summary,
    exportJobs: ensureTaskExportJobs(task).map((job) => sanitizeExportJob(task, job))
  };
}

function ensureTask(taskId) {
  const task = tasks.get(taskId);
  if (!task) {
    throw createError(404, "task_not_found", `Task ${taskId} was not found.`);
  }
  return task;
}

function ensureBlock(task, blockId) {
  const block = task.blocks.find((candidate) => candidate.id === blockId);
  if (!block) {
    throw createError(404, "block_not_found", `Block ${blockId} was not found.`);
  }
  return block;
}

function ensureTranslatableBlock(task, blockId) {
  const block = ensureBlock(task, blockId);
  if (!block.shouldTranslate) {
    throw createError(409, "block_not_translatable", `Block ${blockId} is not translatable by default.`);
  }
  if (block.locked) {
    throw createError(409, "block_locked", `Block ${blockId} is locked.`);
  }
  return block;
}

function normalizeBlockIds(blockIds) {
  if (!Array.isArray(blockIds) || !blockIds.length) {
    throw createError(400, "invalid_request", "blockIds must be a non-empty array.");
  }

  const unique = new Set();
  for (const blockId of blockIds) {
    unique.add(requireNonEmptyString(blockId, "blockIds[]"));
  }
  return [...unique];
}

function assertTranslationReady(task) {
  const provider = getProviderSettings(task);

  if (!provider.apiKey) {
    throw createError(409, "provider_not_configured", "API key is not configured.");
  }

  if (!provider.model) {
    throw createError(400, "invalid_request", "model is required for translation.");
  }

  if (!provider.apiBaseUrl) {
    throw createError(400, "invalid_request", "apiBaseUrl is required for translation.");
  }

  if (task.documentFormat === "epub") {
    const requiresReparse = task.blocks.some((block) => (
      block.shouldTranslate &&
      block.translationUnit?.segmentMapped &&
      !block.translationUnit?.segmentTemplate
    ));
    if (requiresReparse) {
      throw createError(409, "epub_reparse_required", "This EPUB task was parsed with an older block mapping format. Reparse or re-import the EPUB before translating.");
    }
  }
}

function getTaskTimerBucket(taskId) {
  let bucket = taskTimers.get(taskId);
  if (!bucket) {
    bucket = new Map();
    taskTimers.set(taskId, bucket);
  }
  return bucket;
}

function rememberBlockTimer(taskId, blockId, timerId) {
  const bucket = getTaskTimerBucket(taskId);
  const timersForBlock = bucket.get(blockId) || [];
  timersForBlock.push(timerId);
  bucket.set(blockId, timersForBlock);
}

function clearBlockTimers(taskId, blockId) {
  const bucket = taskTimers.get(taskId);
  if (!bucket) return;
  const timersForBlock = bucket.get(blockId) || [];
  for (const timerId of timersForBlock) {
    clearTimeout(timerId);
  }
  bucket.delete(blockId);
  if (!bucket.size) {
    taskTimers.delete(taskId);
  }
}

function clearTaskTimers(taskId) {
  const bucket = taskTimers.get(taskId);
  if (!bucket) return;
  for (const timersForBlock of bucket.values()) {
    for (const timerId of timersForBlock) {
      clearTimeout(timerId);
    }
  }
  taskTimers.delete(taskId);
}

function getTaskAbortBucket(taskId) {
  let bucket = taskAbortControllers.get(taskId);
  if (!bucket) {
    bucket = new Map();
    taskAbortControllers.set(taskId, bucket);
  }
  return bucket;
}

function rememberBlockAbortController(taskId, blockId, controller) {
  const bucket = getTaskAbortBucket(taskId);
  const controllersForBlock = bucket.get(blockId) || [];
  controllersForBlock.push(controller);
  bucket.set(blockId, controllersForBlock);
}

function clearBlockAbortControllers(taskId, blockId) {
  const bucket = taskAbortControllers.get(taskId);
  if (!bucket) return;
  const controllersForBlock = bucket.get(blockId) || [];
  for (const controller of controllersForBlock) {
    try { controller.abort(); } catch {}
  }
  bucket.delete(blockId);
  if (!bucket.size) {
    taskAbortControllers.delete(taskId);
  }
}

function clearTaskAbortControllers(taskId) {
  const bucket = taskAbortControllers.get(taskId);
  if (!bucket) return;
  for (const controllersForBlock of bucket.values()) {
    for (const controller of controllersForBlock) {
      try { controller.abort(); } catch {}
    }
  }
  taskAbortControllers.delete(taskId);
}

function markSessionStart(task) {
  ensureTaskRuntime(task);
  if (!task.runtime.sessionStartedAt || task.summary.stage === "paused" || task.summary.stage === "cancelled") {
    task.runtime.sessionStartedAt = now();
  }
}

function ensureTaskRuntime(task) {
  if (!task.runtime || typeof task.runtime !== "object") {
    task.runtime = {};
  }
  if (typeof task.runtime.sessionStartedAt !== "string") {
    task.runtime.sessionStartedAt = "";
  task.runtime.pendingQueue = [];
  }
  if (!Array.isArray(task.runtime.pendingQueue)) {
    task.runtime.pendingQueue = [];
  }
  return task.runtime;
}

function getTaskConcurrency(task) {
  const raw = Number(task?.config?.concurrency ?? appSettings.concurrency ?? 1);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  return Math.max(1, Math.floor(raw));
}

function activeWorkerCount(task) {
  return task.blocks.filter((block) => block.status === "translating").length;
}

function buildQueuedJob(block, options = {}) {
  return {
    blockId: block.id,
    retranslationGoal: options.retranslationGoal || "",
    focus: options.focus || "",
    queuedAt: now()
  };
}

function resetQueuedBlockState(block) {
  block.status = "queued";
  block.errorMessage = "";
  block.reviewState = "none";
  block.reviewErrorMessage = "";
  block.reviewCandidateTranslation = "";
}

function queueBlockJob(task, block, options = {}) {
  const runtime = ensureTaskRuntime(task);
  runtime.pendingQueue = runtime.pendingQueue.filter((job) => job.blockId !== block.id);
  clearBlockTimers(task.id, block.id);
  clearBlockAbortControllers(task.id, block.id);
  resetQueuedBlockState(block);
  runtime.pendingQueue.push(buildQueuedJob(block, options));
}

function enqueueBlocks(task, blocks, optionsFactory = () => ({})) {
  if (!Array.isArray(blocks) || !blocks.length) {
    return 0;
  }

  markSessionStart(task);
  for (const block of blocks) {
    queueBlockJob(task, block, optionsFactory(block));
  }
  pumpTaskQueue(task);
  return blocks.length;
}

function pumpTaskQueue(task) {
  const runtime = ensureTaskRuntime(task);
  const concurrency = getTaskConcurrency(task);

  while (runtime.pendingQueue.length && activeWorkerCount(task) < concurrency) {
    const nextJob = runtime.pendingQueue.shift();
    if (!nextJob) {
      break;
    }

    const block = task.blocks.find((candidate) => candidate.id === nextJob.blockId);
    if (!block || !block.shouldTranslate || block.locked || block.status !== "queued") {
      continue;
    }

    scheduleBlockTranslation(task, block, nextJob);
  }
}

function applyEpubTranslationResult(task, block, rawTranslation, providerLabel, options = {}) {
  const sourceFragment = block.translationUnit?.sourceFragment || block.sourceMarkdown;
  const segmentCount = Array.isArray(block.translationUnit?.segments) ? block.translationUnit.segments.length : 0;

  if (block.translationUnit?.segmentTemplate && segmentCount > 0) {
    if (shouldUseEpubPlaceholderMode(block) && (!options.allowBestEffortFallback || String(rawTranslation || "").includes("[[MTS_"))) {
      return applyEpubPlaceholderTranslation({
        blockType: block.type,
        sourceMarkdown: block.sourceMarkdown,
        translationUnit: block.translationUnit,
        rawTranslation,
        providerLabel
      });
    }

    const translatedSegments = parseEpubTranslatedSegments(rawTranslation, segmentCount, providerLabel);
    return applyEpubTranslationUnit({
      blockType: block.type,
      sourceMarkdown: block.sourceMarkdown,
      translationUnit: block.translationUnit,
      translatedSegments
    });
  }

  if (block.translationUnit?.textOnly) {
    return {
      normalizedFragment: rebuildTextOnlyEpubFragment(sourceFragment, rawTranslation),
      previewText: String(rawTranslation || "").trim(),
      structureSignature: block.translationUnit?.structureSignature || "text-only-fallback"
    };
  }

  if (options.allowBestEffortFallback) {
    return {
      normalizedFragment: rebuildTextOnlyEpubFragment(sourceFragment, rawTranslation),
      previewText: String(rawTranslation || "").trim(),
      structureSignature: "confirmed-text-fallback"
    };
  }

  throw new Error("EPUB block is missing segment template metadata. Reparse the task before translating.");
}

function scheduleBlockTranslation(task, block, options = {}) {
  clearBlockTimers(task.id, block.id);
  clearBlockAbortControllers(task.id, block.id);

  block.status = "translating";
  block.reviewCandidateTranslation = "";
  block.reviewErrorMessage = "";
  markSessionStart(task);
  refreshTask(task, { persist: false });

  void (async () => {
    let candidateTranslation = "";
    try {
      const promptSnapshot = buildPromptSnapshot(task, block, {
        retranslationGoal: options.retranslationGoal,
        focus: options.focus
      });
      block.promptSnapshot = promptSnapshot;

      const providerSettings = getProviderSettings(task);
      const providerLabel = providerSettings.apiProvider || "Provider";
      const providerController = new AbortController();
      rememberBlockAbortController(task.id, block.id, providerController);
      const providerResult = await translateWithDeepSeek({
        provider: providerSettings,
        promptSnapshot,
        useRetranslationPrompt: Boolean(options.retranslationGoal),
        signal: providerController.signal
      });
      const translation = providerResult.translation;
      candidateTranslation = typeof translation === "string" ? translation : "";

      if (!externallyStoppedStatus(block)) {
        let nextTranslatedMarkdown = translation;
        let translatedFragment = null;
        let structureSignature = null;
        let reviewCandidateTranslation = candidateTranslation;
        let repairedMalformedOutput = false;

        if (task.documentFormat === "epub") {
          try {
            const applied = applyEpubTranslationResult(task, block, translation, providerLabel);
            translatedFragment = applied.normalizedFragment;
            structureSignature = applied.structureSignature;
            nextTranslatedMarkdown = applied.previewText;
          } catch (error) {
            const repairFn = canAttemptEpubPlaceholderRepair(block, error)
              ? repairMalformedEpubPlaceholderTranslation
              : (canAttemptEpubSegmentRepair(block, error) ? repairMalformedEpubSegmentTranslation : null);

            if (!repairFn) {
              if (candidateTranslation.trim()) {
                error.rawCandidateTranslation = candidateTranslation.trim();
              }
              throw error;
            }

            try {
              const repaired = await repairFn(task, block, translation, providerSettings, providerController.signal);
              translatedFragment = repaired.normalizedFragment;
              structureSignature = repaired.structureSignature;
              nextTranslatedMarkdown = repaired.previewText;
              reviewCandidateTranslation = String(repaired.repairedTranslation || candidateTranslation).trim();
              repairedMalformedOutput = true;
            } catch (repairError) {
              const fallback = applyBestEffortEpubPlaceholderFallback(block, translation, providerLabel);
              if (fallback) {
                translatedFragment = fallback.normalizedFragment;
                structureSignature = fallback.structureSignature;
                nextTranslatedMarkdown = fallback.previewText;
                reviewCandidateTranslation = "";
                repairedMalformedOutput = true;
              } else {
                const combinedError = new Error(`${error instanceof Error ? error.message : String(error)} Automatic repair also failed: ${repairError instanceof Error ? repairError.message : String(repairError)}`);
                if (candidateTranslation.trim()) {
                  combinedError.rawCandidateTranslation = candidateTranslation.trim();
                }
                throw combinedError;
              }
            }
          }
        }

        if (!externallyStoppedStatus(block)) {
          block.reviewCandidateTranslation = reviewCandidateTranslation;
          if (task.documentFormat === "epub") {
            if (block.translationUnit && translatedFragment !== null) {
              block.translationUnit.translatedFragment = translatedFragment;
            }
            if (block.translationUnit && structureSignature !== null) {
              block.translationUnit.structureSignature = structureSignature;
            }
            block.translatedMarkdown = nextTranslatedMarkdown;
          } else {
            block.translatedMarkdown = translation;
          }

          block.status = options.retranslationGoal ? "retranslated" : "translated";
          block.lastTranslatedAt = now();
          block.retryCount += options.retranslationGoal ? 1 : 0;
          block.reviewState = "none";
          block.reviewErrorMessage = "";
          block.errorMessage = "";
          markTaskContentChanged(task);
          addActivity(
            task,
            options.retranslationGoal ? "block_retranslated" : "block_translated",
            options.retranslationGoal ? "Block retranslated" : "Block translated",
            `${block.id} finished ${options.retranslationGoal ? "retranslation" : "translation"} via ${providerLabel} API${repairedMalformedOutput ? " after automatic EPUB output repair" : ""}.`
          );
        }
      }
    } catch (error) {
      if (!externallyStoppedStatus(block)) {
        block.status = "failed";
        block.failureCount += 1;
        block.errorMessage = error instanceof Error ? error.message : String(error);
        block.reviewErrorMessage = block.errorMessage;
        const rawCandidateTranslation =
          (typeof error?.rawCandidateTranslation === "string" && error.rawCandidateTranslation.trim()) ||
          candidateTranslation.trim();
        block.reviewCandidateTranslation = rawCandidateTranslation;
        block.reviewState = "none";
        addActivity(task, "block_failed", "Block translation failed", `${block.id} failed: ${block.errorMessage}`);
      } else {
        block.errorMessage = "";
        block.reviewErrorMessage = "";
        block.reviewCandidateTranslation = "";
      }
    } finally {
      refreshTask(task);
      clearBlockTimers(task.id, block.id);
      clearBlockAbortControllers(task.id, block.id);
      pumpTaskQueue(task);
    }
  })();
}

async function createTaskRecord({ filename, content, contentBase64, contentBuffer, documentFormat, config = {}, source = "api" }) {
  const taskId = randomUUID();
  const parsed = await parseTaskInput({
    taskId,
    filename,
    content,
    contentBase64,
    contentBuffer,
    documentFormat
  });

  const task = {
    id: taskId,
    filename,
    source,
    documentFormat: parsed.documentFormat,
    sourceMarkdown: parsed.sourceMarkdown,
    createdAt: now(),
    updatedAt: now(),
    config: buildTaskConfig(config),
    parser: parsed.parser,
    stats: parsed.stats,
    blocks: normalizeParsedBlocks(parsed.blocks).map((block) => ({
      ...block,
      promptSnapshot: null
    })),
    asset: parsed.asset,
    annotations: [],
    comments: [],
    activity: [],
    summary: null,
    exports: {},
    exportJobs: [],
    contentVersion: now(),
    runtime: {
      sessionStartedAt: ""
    }
  };

  addActivity(task, "task_created", "Task created", `${filename} was parsed into block mappings.`);
  refreshTask(task);
  tasks.set(task.id, task);
  saveState();
  return task;
}


async function reparseIntoTask(task, payload = {}) {
  if (payload.filename !== undefined) {
    task.filename = requireNonEmptyString(payload.filename, "filename");
  }

  if (payload.config !== undefined) {
    if (!payload.config || typeof payload.config !== "object" || Array.isArray(payload.config)) {
      throw createError(400, "invalid_request", "config must be an object.");
    }
    task.config = buildTaskConfig({ ...task.config, ...payload.config });
  }

  clearTaskTimers(task.id);

  let parsed = null;
  if (task.documentFormat === "epub") {
    if (payload.documentFormat !== undefined && inferDocumentFormat(task.filename, payload.documentFormat) !== "epub") {
      throw createError(409, "format_switch_not_supported", "Switching an EPUB task to another format is not supported.");
    }

    if (payload.contentBase64 !== undefined) {
      parsed = await parseTaskInput({
        taskId: task.id,
        filename: task.filename,
        contentBase64: payload.contentBase64,
        documentFormat: "epub"
      });
    } else {
      const reparsed = await reparseEpubArchive({
        taskDir: task.asset?.taskDir,
        inputPath: task.asset?.sourceArchivePath
      });
      parsed = {
        documentFormat: "epub",
        sourceMarkdown: reparsed.sourcePreview || "",
        parser: reparsed.parser,
        stats: reparsed.stats,
        blocks: normalizeParsedBlocks(reparsed.blocks),
        asset: reparsed.asset
      };
    }
  } else {
    if (payload.content !== undefined) {
      task.sourceMarkdown = requireNonEmptyString(payload.content, "content");
    }
    const markdownParsed = parseTaskMarkdown(task.sourceMarkdown);
    parsed = {
      documentFormat: "markdown",
      sourceMarkdown: task.sourceMarkdown,
      parser: markdownParsed.parser,
      stats: markdownParsed.stats,
      blocks: normalizeParsedBlocks(markdownParsed.blocks),
      asset: null
    };
  }

  task.documentFormat = parsed.documentFormat;
  task.sourceMarkdown = parsed.sourceMarkdown;
  task.parser = parsed.parser;
  task.stats = parsed.stats;
  task.blocks = normalizeParsedBlocks(parsed.blocks).map((block) => ({
    ...block,
    promptSnapshot: null
  }));
  task.asset = parsed.asset;
  task.annotations = [];
  task.comments = [];
  task.exportJobs = [];
  task.runtime.sessionStartedAt = "";
  task.runtime.pendingQueue = [];
  markTaskContentChanged(task);

  addActivity(task, "task_reparsed", "Task reparsed", `${task.filename} was reparsed and block mappings were rebuilt.`);
  refreshTask(task);
}


function validateAnnotation(annotation) {
  const supportedTypes = new Set(["highlight", "underline", "strike", "comment"]);
  if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
    throw createError(400, "invalid_request", "annotation must be an object.");
  }

  if (!supportedTypes.has(annotation.type)) {
    throw createError(400, "invalid_request", "annotation.type must be one of highlight, underline, strike, comment.");
  }
}

export function getServiceOverview(context = {}) {
  const accessToken = getResolvedAccessToken();
  const publicBaseUrl =
    typeof context === "string"
      ? context
      : normalizePublicBaseUrl(context.publicBaseUrl || "");
  const basePath =
    typeof context === "string"
      ? ""
      : normalizeBasePath(context.basePath || extractPublicBasePath(publicBaseUrl));
  const docsPath = `${basePath}/api/docs` || "/api/docs";
  const openApiPath = `${basePath}/openapi.yaml` || "/openapi.yaml";
  const healthPath = `${basePath}/health` || "/health";

  return {
    service: SERVICE_INFO,
    publicBaseUrl,
    baseUrl: publicBaseUrl ? `${publicBaseUrl}/api` : "",
    authRequired: Boolean(accessToken.value),
    docsPath,
    openApiPath,
    healthPath
  };
}

export function listTasks() {
  return [...tasks.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((task) => summarizeTask(task));
}

export function getSettings() {
  return sanitizeConfig(appSettings);
}

export async function testProviderConnection() {
  const settings = getSettings();
  const provider = {
    apiProvider: settings.apiProvider,
    apiKey: getResolvedApiKey().value,
    apiBaseUrl: settings.apiBaseUrl,
    model: settings.model,
    requestTimeoutMs: appSettings.requestTimeoutMs
  };

  return {
    testedAt: now(),
    effectiveApiEndpoint: buildEffectiveApiEndpoint(settings.apiBaseUrl),
    keySource: settings.apiKeySource,
    keyStorageKey: settings.apiKeyStorageKey,
    result: await testChatCompletionsConnection({ provider })
  };
}

export function updateSettings(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  appSettings = mergeSettings(appSettings, patch);
  flushState();
  return getSettings();
}

export function getResolvedAccessTokenState() {
  return getResolvedAccessToken();
}

export function persistAccessTokenToDotenv(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const accessToken = requireNonEmptyString(payload.accessToken, "accessToken");
  writeManagedAccessTokenToDotenv(accessToken);
  runtimeSecrets.accessToken = "";

  const persistedValue = getDotenvAccessToken().value;
  if (persistedValue !== accessToken) {
    throw createError(500, "dotenv_persist_failed", "Failed to persist access token to the local .env file.");
  }

  return getSettings();
}

export function persistApiKeyToDotenv(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const apiKey = requireNonEmptyString(payload.apiKey, "apiKey");
  writeManagedApiKeyToDotenv(apiKey);
  runtimeSecrets.apiKey = "";

  const persistedValue = getDotenvApiKey().value;
  if (persistedValue !== apiKey) {
    throw createError(500, "dotenv_persist_failed", "Failed to persist API key to the local .env file.");
  }

  return getSettings();
}

export function clearApiKey(payload = {}) {
  const options = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const rawScope = options.scope === undefined ? "all" : requireNonEmptyString(options.scope, "scope").toLowerCase();
  const scope = rawScope === "env" ? "dotenv" : rawScope;

  if (!["session", "dotenv", "all"].includes(scope)) {
    throw createError(400, "invalid_request", 'scope must be one of session, dotenv, all.');
  }

  if (scope === "session" || scope === "all") {
    runtimeSecrets.apiKey = "";
  }

  if (scope === "dotenv" || scope === "all") {
    clearManagedApiKeyFromDotenv();
  }

  return getSettings();
}

export function clearAccessToken(payload = {}) {
  const options = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const rawScope = options.scope === undefined ? "all" : requireNonEmptyString(options.scope, "scope").toLowerCase();
  const scope = rawScope === "env" ? "dotenv" : rawScope;

  if (!["session", "dotenv", "all"].includes(scope)) {
    throw createError(400, "invalid_request", 'scope must be one of session, dotenv, all.');
  }

  if (scope === "session" || scope === "all") {
    runtimeSecrets.accessToken = "";
  }

  if (scope === "dotenv" || scope === "all") {
    clearManagedAccessTokenFromDotenv();
  }

  return getSettings();
}

export async function createTask(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const filename = requireNonEmptyString(input.filename, "filename");
  const config = input.config ?? {};

  if (config && (typeof config !== "object" || Array.isArray(config))) {
    throw createError(400, "invalid_request", "config must be an object.");
  }

  return sanitizeTask(await createTaskRecord({
    filename,
    content: input.content,
    contentBase64: input.contentBase64,
    contentBuffer: input.contentBuffer,
    documentFormat: input.documentFormat,
    config
  }));
}

export function getTask(taskId) {
  const task = ensureTask(taskId);
  syncTaskReadModel(task, {
    touchUpdatedAt: false,
    rebuildPromptSnapshots: false,
    rebuildExports: false
  });
  return sanitizeTask(task);
}

export function getBlock(taskId, blockId) {
  const task = ensureTask(taskId);
  const block = ensureBlock(task, blockId);
  block.promptSnapshot = buildPromptSnapshot(task, block);
  syncTaskReadModel(task, {
    touchUpdatedAt: false,
    rebuildPromptSnapshots: false,
    rebuildExports: false
  });

  return {
    taskId: task.id,
    updatedAt: task.updatedAt,
    block: clone(block)
  };
}

export async function reparseTask(taskId, payload = {}) {
  const task = ensureTask(taskId);
  await reparseIntoTask(task, payload);
  return sanitizeTask(task);
}

function serializeTaskStatusBlock(block) {
  return {
    id: block.id,
    type: block.type,
    status: block.status,
    shouldTranslate: block.shouldTranslate,
    locked: block.locked,
    errorMessage: block.errorMessage,
    reviewState: block.reviewState || "none",
    reviewCandidateTranslation: block.reviewCandidateTranslation || "",
    reviewErrorMessage: block.reviewErrorMessage || "",
    lastTranslatedAt: block.lastTranslatedAt,
    lastEditedAt: block.lastEditedAt
  };
}

function getSerializedTranslatedMarkdown(block) {
  const storedTranslation = block.translatedMarkdown || "";
  const translatedFragment = block.translationUnit?.translatedFragment || "";
  if (translatedFragment && /<br\b/i.test(translatedFragment)) {
    try {
      return buildEpubPreviewFromNormalizedFragment(block.type, translatedFragment) || storedTranslation;
    } catch {
      return storedTranslation;
    }
  }
  return storedTranslation;
}

function getSerializedSourceMarkdown(block) {
  const storedSource = block.sourceMarkdown || "";
  const sourceFragment = block.translationUnit?.sourceFragment || "";
  if (sourceFragment && /<br\b/i.test(sourceFragment)) {
    try {
      return buildEpubPreviewFromNormalizedFragment(block.type, sourceFragment) || storedSource;
    } catch {
      return storedSource;
    }
  }
  return storedSource;
}

function serializeTaskPageBlock(block) {
  return {
    ...serializeTaskStatusBlock(block),
    order: block.order,
    headingPath: clone(block.headingPath || []),
    sourceMarkdown: getSerializedSourceMarkdown(block),
    translatedMarkdown: getSerializedTranslatedMarkdown(block),
    tokenEstimate: block.tokenEstimate,
    skipReason: block.skipReason || ""
  };
}

export function getTaskStatus(taskId, options = {}) {
  const task = ensureTask(taskId);
  syncTaskReadModel(task, {
    touchUpdatedAt: false,
    rebuildPromptSnapshots: false,
    rebuildExports: false
  });

  const totalBlocks = task.blocks.length;
  const requestedPageSize = options.pageSize === "all"
    ? "all"
    : Number(options.pageSize === undefined ? 20 : options.pageSize);
  if (requestedPageSize !== "all" && (!Number.isInteger(requestedPageSize) || requestedPageSize <= 0)) {
    throw createError(400, "invalid_request", "pageSize must be a positive integer or 'all'.");
  }

  const normalizedPageSize = requestedPageSize === "all" ? Math.max(1, totalBlocks || 1) : requestedPageSize;
  const totalPages = requestedPageSize === "all" ? 1 : Math.max(1, Math.ceil(totalBlocks / normalizedPageSize));
  const requestedPage = Number(options.page === undefined ? 1 : options.page);
  if (!Number.isInteger(requestedPage) || requestedPage <= 0) {
    throw createError(400, "invalid_request", "page must be a positive integer.");
  }
  const page = Math.min(requestedPage, totalPages);
  const pageStart = requestedPageSize === "all" ? 0 : (page - 1) * normalizedPageSize;
  const pageEnd = requestedPageSize === "all" ? totalBlocks : Math.min(totalBlocks, pageStart + normalizedPageSize);
  const pageBlocks = task.blocks.slice(pageStart, pageEnd);
  const includeBlocks = options.includeBlocks === true;
  const failedBlocks = task.blocks
    .filter((block) => block.status === "failed")
    .map((block) => ({
      id: block.id,
      order: block.order
    }));

  return {
    taskId: task.id,
    filename: task.filename,
    documentFormat: task.documentFormat || "markdown",
    updatedAt: task.updatedAt,
    stage: task.summary.stage,
    providerLabel: task.config.apiProvider || appSettings.apiProvider || "Provider",
    summary: clone(task.summary),
    page,
    pageSize: normalizedPageSize,
    totalPages,
    totalBlocks,
    failedBlocks,
    exportJobs: ensureTaskExportJobs(task).map((job) => sanitizeExportJob(task, job)),
    blocks: includeBlocks ? task.blocks.map(serializeTaskStatusBlock) : undefined,
    pageBlocks: pageBlocks.map(serializeTaskPageBlock)
  };
}

export function getBlockPrompt(taskId, blockId) {
  const task = ensureTask(taskId);
  const block = ensureBlock(task, blockId);
  block.promptSnapshot = buildPromptSnapshot(task, block);
  syncTaskReadModel(task, {
    touchUpdatedAt: false,
    rebuildPromptSnapshots: false,
    rebuildExports: false
  });

  return {
    taskId: task.id,
    blockId: block.id,
    promptSnapshot: clone(block.promptSnapshot)
  };
}

export function startTaskTranslation(taskId) {
  const task = ensureTask(taskId);
  assertTranslationReady(task);

  const eligibleBlocks = task.blocks.filter(
    (block) => block.shouldTranslate && !block.locked && canScheduleFromStatus(block.status)
  );

  if (!eligibleBlocks.length) {
    addActivity(task, "task_translate_noop", "No blocks scheduled", "No eligible blocks were found for full-document translation.");
    refreshTask(task);
    return sanitizeTask(task);
  }

  enqueueBlocks(task, eligibleBlocks);
  addActivity(task, "task_translation_started", "Task translation started", `${eligibleBlocks.length} blocks were queued with concurrency ${getTaskConcurrency(task)}.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function pauseTask(taskId) {
  const task = ensureTask(taskId);
  ensureTaskRuntime(task).pendingQueue = [];
  clearTaskTimers(taskId);
  clearTaskAbortControllers(taskId);

  let pausedCount = 0;
  for (const block of task.blocks) {
    if (activeStatus(block.status)) {
      block.status = "paused";
      block.errorMessage = "";
      pausedCount += 1;
    }
  }

  addActivity(task, "task_paused", "Task paused", `${pausedCount} queued or active blocks were paused.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function resumeTask(taskId) {
  const task = ensureTask(taskId);
  assertTranslationReady(task);

  const pausedBlocks = task.blocks.filter(
    (block) => block.shouldTranslate && !block.locked && block.status === "paused"
  );

  if (!pausedBlocks.length) {
    addActivity(task, "task_resume_noop", "No paused blocks resumed", "No paused blocks were found for this task.");
    refreshTask(task);
    return sanitizeTask(task);
  }

  enqueueBlocks(task, pausedBlocks);
  addActivity(task, "task_resumed", "Task resumed", `${pausedBlocks.length} paused blocks were re-queued with concurrency ${getTaskConcurrency(task)}.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function cancelTask(taskId) {
  const task = ensureTask(taskId);
  ensureTaskRuntime(task).pendingQueue = [];
  clearTaskTimers(taskId);
  clearTaskAbortControllers(taskId);

  let cancelledCount = 0;
  for (const block of task.blocks) {
    if (activeStatus(block.status) || block.status === "paused") {
      block.status = "cancelled";
      block.errorMessage = "";
      cancelledCount += 1;
    }
  }

  addActivity(task, "task_cancelled", "Task cancelled", `${cancelledCount} queued, active or paused blocks were cancelled.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export async function deleteTask(taskId) {
  const task = ensureTask(taskId);
  clearTaskTimers(taskId);
  clearTaskAbortControllers(taskId);
  tasks.delete(taskId);
  await removeTaskArtifacts(task);
  await removeTaskExportCache(taskId);
  saveState();

  return {
    taskId,
    filename: task.filename,
    deleted: true
  };
}

export function startBlockTranslation(taskId, blockId) {
  const task = ensureTask(taskId);
  assertTranslationReady(task);
  const block = ensureTranslatableBlock(task, blockId);
  enqueueBlocks(task, [block]);
  addActivity(task, "block_translation_started", "Block translation started", `${block.id} was queued for translation.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function retranslateBlock(taskId, blockId, payload = {}) {
  const task = ensureTask(taskId);
  assertTranslationReady(task);
  const block = ensureTranslatableBlock(task, blockId);

  const retranslationGoal =
    payload.retranslationGoal === undefined ? "more_accurate" : requireNonEmptyString(payload.retranslationGoal, "retranslationGoal");
  const focus =
    payload.focus === undefined ? "structure safety and terminology consistency" : requireNonEmptyString(payload.focus, "focus");

  enqueueBlocks(task, [block], () => ({ retranslationGoal, focus }));
  block.promptSnapshot = buildPromptSnapshot(task, block, {
    retranslationGoal,
    focus
  });

  addActivity(task, "block_retranslation_started", "Block retranslation started", `${block.id} was queued for retranslation with goal ${retranslationGoal}.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function retranslateBlocksBatch(taskId, payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const task = ensureTask(taskId);
  assertTranslationReady(task);
  const blockIds = normalizeBlockIds(payload.blockIds);
  const retranslationGoal =
    payload.retranslationGoal === undefined ? "more_accurate" : requireNonEmptyString(payload.retranslationGoal, "retranslationGoal");
  const focus =
    payload.focus === undefined ? "structure safety and terminology consistency" : requireNonEmptyString(payload.focus, "focus");

  const scheduledBlocks = [];
  const skipped = [];

  blockIds.forEach((blockId) => {
    try {
      const block = ensureTranslatableBlock(task, blockId);
      scheduledBlocks.push(block);
      block.promptSnapshot = buildPromptSnapshot(task, block, {
        retranslationGoal,
        focus
      });
    } catch (error) {
      skipped.push({
        blockId,
        code: error?.code || "internal_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  enqueueBlocks(task, scheduledBlocks, () => ({ retranslationGoal, focus }));
  const scheduledBlockIds = scheduledBlocks.map((block) => block.id);

  addActivity(
    task,
    "batch_retranslation_started",
    "Batch retranslation started",
    `${scheduledBlockIds.length} blocks were queued for retranslation with concurrency ${getTaskConcurrency(task)}.`
  );

  refreshTask(task);

  return {
    taskId: task.id,
    updatedAt: task.updatedAt,
    retranslationGoal,
    focus,
    scheduledBlockIds,
    skipped,
    summary: clone(task.summary)
  };
}

async function applyConfirmedReviewCandidate(task, block) {
  const candidate = String(block.reviewCandidateTranslation || "").trim();
  if (!candidate) {
    throw createError(409, "review_candidate_missing", "No candidate translation is available for confirmation.");
  }

  if (task.documentFormat !== "epub") {
    block.translatedMarkdown = candidate;
    return "plain-text";
  }

  const applied = applyEpubTranslationResult(task, block, candidate, "Confirmed candidate", {
    allowBestEffortFallback: true
  });

  if (block.translationUnit) {
    block.translationUnit.translatedFragment = applied.normalizedFragment;
    block.translationUnit.structureSignature = applied.structureSignature;
  }
  block.translatedMarkdown = applied.previewText;

  if (block.translationUnit?.segmentTemplate && Array.isArray(block.translationUnit?.segments) && block.translationUnit.segments.length > 0) {
    return "segment-template";
  }
  if (block.translationUnit?.textOnly) {
    return "text-only";
  }
  return "text-fallback";
}

export async function updateBlock(taskId, blockId, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const task = ensureTask(taskId);
  const block = ensureBlock(task, blockId);

  let changed = false;

  if (patch.translatedMarkdown !== undefined && task.documentFormat === "epub") {
    throw createError(409, "manual_edit_not_supported", "Manual block text editing is not supported for EPUB tasks. Use retranslation instead.");
  }

  if (patch.reviewState !== undefined) {
    if (!["confirmed", "ignored", "none"].includes(patch.reviewState)) {
      throw createError(400, "invalid_request", "reviewState must be one of confirmed, ignored, none.");
    }
    if (patch.reviewState === "confirmed") {
      const confirmationMode = await applyConfirmedReviewCandidate(task, block);
      block.status = "edited";
      block.errorMessage = "";
      block.reviewErrorMessage = "";
      block.reviewState = "confirmed";
      block.lastEditedAt = now();
      markTaskContentChanged(task);
      addActivity(task, "block_review_confirmed", "Block confirmed", `${block.id} review candidate was confirmed (${confirmationMode}).`);
      changed = true;
    } else if (patch.reviewState === "ignored") {
      block.reviewState = "ignored";
      block.reviewErrorMessage = block.errorMessage || block.reviewErrorMessage || "";
      addActivity(task, "block_review_ignored", "Block ignored", `${block.id} review candidate was ignored.`);
      changed = true;
    } else {
      block.reviewState = block.reviewCandidateTranslation ? "pending_confirmation" : "none";
      changed = true;
    }
  }

  if (patch.translatedMarkdown !== undefined) {
    if (typeof patch.translatedMarkdown !== "string") {
      throw createError(400, "invalid_request", "translatedMarkdown must be a string.");
    }
    block.translatedMarkdown = patch.translatedMarkdown;
    block.status = "edited";
    block.errorMessage = "";
    block.reviewErrorMessage = "";
    block.reviewState = "confirmed";
    block.lastEditedAt = now();
    markTaskContentChanged(task);
    changed = true;
  }

  if (patch.locked !== undefined) {
    if (typeof patch.locked !== "boolean") {
      throw createError(400, "invalid_request", "locked must be a boolean.");
    }
    block.locked = patch.locked;
    if (patch.locked) {
      clearBlockTimers(taskId, blockId);
    }
    changed = true;
  }

  if (!changed) {
    throw createError(400, "invalid_request", "At least one of translatedMarkdown, reviewState or locked must be provided.");
  }

  addActivity(task, "block_updated", "Block updated", `${block.id} content or lock state was updated.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function addAnnotation(taskId, blockId, annotationInput) {
  validateAnnotation(annotationInput);

  const task = ensureTask(taskId);
  const block = ensureBlock(task, blockId);
  const annotation = {
    id: randomUUID(),
    blockId,
    type: annotationInput.type,
    scope: typeof annotationInput.scope === "string" ? annotationInput.scope : "translation",
    start: Number.isInteger(annotationInput.start) ? annotationInput.start : 0,
    end: Number.isInteger(annotationInput.end) ? annotationInput.end : 0,
    text: typeof annotationInput.text === "string" ? annotationInput.text : "",
    note: typeof annotationInput.note === "string" ? annotationInput.note : "",
    createdAt: now()
  };

  task.annotations.push(annotation);
  block.annotations.push(annotation);
  if (annotation.type === "comment") {
    task.comments.push(annotation);
    block.comments.push(annotation);
  }

  addActivity(task, "annotation_saved", "Annotation saved", `${block.id} received a new ${annotation.type} annotation.`);
  refreshTask(task);
  return sanitizeTask(task);
}

function ensureExportJob(task, jobId) {
  const job = ensureTaskExportJobs(task).find((candidate) => candidate.id === jobId);
  if (!job) {
    throw createError(404, "export_job_not_found", `Export job ${jobId} was not found.`);
  }
  return job;
}

function createExportJobRecord(task, format, normalizedOptions) {
  const signature = buildExportJobSignature(task, format, normalizedOptions);
  return {
    id: randomUUID(),
    format,
    options: clone(normalizedOptions),
    signature,
    sourceVersion: task.contentVersion || now(),
    status: "queued",
    progress: normalizeExportJobProgress({
      percent: 0,
      stage: "queued",
      detail: "Waiting to start export.",
      currentStep: 0,
      totalSteps: 4
    }),
    createdAt: now(),
    startedAt: "",
    finishedAt: "",
    errorMessage: "",
    artifact: null
  };
}

function findReusableExportJob(task, signature) {
  return ensureTaskExportJobs(task).find((job) =>
    job.signature === signature
      && !exportJobIsStale(task, job)
      && (
        job.status === "queued"
          || job.status === "running"
          || (job.status === "completed" && exportJobHasCache(job))
      )
  ) || null;
}

async function persistArtifactToCache(taskId, job, artifact) {
  const extension = path.extname(artifact.filename || "") || "";
  const taskCacheDir = path.join(getExportCacheDir(), taskId);
  const absolutePath = path.join(taskCacheDir, `${job.id}${extension}`);
  fs.mkdirSync(taskCacheDir, { recursive: true });
  await writeFileAsync(absolutePath, artifactBufferFromArtifact(artifact));

  return {
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    sizeBytes: Number(artifact.sizeBytes || fs.statSync(absolutePath).size || 0),
    cachePath: path.relative(ROOT_DIR, absolutePath),
    renderer: artifact.renderer || "",
    generatedAt: artifact.generatedAt || now()
  };
}

function createProgressPulse(task, job, targetPercent, detail) {
  let currentPercent = job.progress.percent;
  job.progress.detail = detail;
  return setInterval(() => {
    if (job.status !== "running") {
      return;
    }

    currentPercent = Math.min(targetPercent, currentPercent + 3);
    if (currentPercent <= job.progress.percent) {
      return;
    }

    updateExportJobProgress(task, job, {
      percent: currentPercent,
      stage: "rendering",
      detail
    });
  }, 2000);
}

async function buildArtifactForJob(taskSnapshot, format, normalizedOptions, internalOptions = {}) {
  if (format === "pdf" || format === "pdf_bilingual") {
    return buildPdfExport(taskSnapshot, {
      ...normalizedOptions,
      ...internalOptions
    });
  }

  if (format === "epub" || format === "epub_bilingual") {
    if (taskSnapshot.documentFormat !== "epub") {
      throw createError(409, "export_not_supported", "EPUB export is only available for EPUB tasks.");
    }
    return buildEpubExport(taskSnapshot, normalizedOptions);
  }

  return clone(buildExports(taskSnapshot)[format]);
}

async function runExportJob(taskId, jobId) {
  const task = tasks.get(taskId);
  if (!task) {
    return;
  }

  const job = ensureTaskExportJobs(task).find((candidate) => candidate.id === jobId);
  if (!job || job.status !== "queued") {
    return;
  }

  let pulse = null;
  try {
    job.status = "running";
    job.startedAt = now();
    updateExportJobProgress(task, job, {
      percent: 8,
      stage: "preparing",
      detail: "Preparing export snapshot.",
      currentStep: 1,
      totalSteps: 4
    });

    const taskSnapshot = snapshotTaskForExport(task);
    updateExportJobProgress(task, job, {
      percent: 18,
      stage: "rendering",
      detail: "Rendering export artifact.",
      currentStep: 2,
      totalSteps: 4
    });

    const progressReporter =
      job.format === "pdf" || job.format === "pdf_bilingual"
        ? (patch = {}) => updateExportJobProgress(task, job, patch, { persist: false })
        : null;

    if (job.format === "epub" || job.format === "epub_bilingual") {
      pulse = createProgressPulse(
        task,
        job,
        84,
        job.format === "epub_bilingual" ? "Packaging bilingual EPUB export." : "Packaging EPUB export."
      );
    }

    const artifact = await buildArtifactForJob(taskSnapshot, job.format, job.options || {}, {
      onProgress: progressReporter
    });
    if (pulse) {
      clearInterval(pulse);
      pulse = null;
    }

    updateExportJobProgress(task, job, {
      percent: 90,
      stage: "caching",
      detail: "Writing export to cache.",
      currentStep: 3,
      totalSteps: 4
    });

    job.artifact = await persistArtifactToCache(taskId, job, artifact);
    job.status = "completed";
    job.finishedAt = now();
    job.errorMessage = "";
    updateExportJobProgress(task, job, {
      percent: 100,
      stage: "completed",
      detail: "Export is ready to download.",
      currentStep: 4,
      totalSteps: 4
    });

    addActivity(task, "task_exported", "Task exported", `${task.filename} finished async export as ${formatOptionLabel(job.format, job.options)}.`);
    refreshTask(task, { touchUpdatedAt: false });
  } catch (error) {
    if (pulse) {
      clearInterval(pulse);
    }
    job.status = "failed";
    job.finishedAt = now();
    job.errorMessage = error instanceof Error ? error.message : String(error);
    updateExportJobProgress(task, job, {
      percent: Math.max(job.progress.percent, 100),
      stage: "failed",
      detail: job.errorMessage,
      currentStep: 4,
      totalSteps: 4
    });
    addActivity(task, "task_export_failed", "Task export failed", `${task.filename} export failed: ${job.errorMessage}`);
    refreshTask(task, { touchUpdatedAt: false });
  }
}

export function createExportJob(taskId, payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const format = requireNonEmptyString(payload.format, "format");
  if (!EXPORT_FORMATS.includes(format)) {
    throw createError(400, "invalid_request", `format must be one of ${EXPORT_FORMATS.join(", ")}.`);
  }

  const task = ensureTask(taskId);
  syncTaskReadModel(task, {
    touchUpdatedAt: false,
    rebuildPromptSnapshots: false,
    rebuildExports: false
  });
  const normalizedOptions = normalizeExportOptions(format, payload);
  const signature = buildExportJobSignature(task, format, normalizedOptions);
  const reusableJob = findReusableExportJob(task, signature);

  if (reusableJob) {
    return {
      taskId: task.id,
      filename: task.filename,
      job: sanitizeExportJob(task, reusableJob)
    };
  }

  const job = createExportJobRecord(task, format, normalizedOptions);
  const exportJobs = ensureTaskExportJobs(task);
  exportJobs.unshift(job);
  task.exportJobs = exportJobs.slice(0, 12);
  addActivity(task, "task_export_queued", "Task export queued", `${task.filename} queued async export as ${formatOptionLabel(format, normalizedOptions)}.`);
  refreshTask(task, { touchUpdatedAt: false });
  setTimeout(() => {
    void runExportJob(task.id, job.id);
  }, 0);

  return {
    taskId: task.id,
    filename: task.filename,
    job: sanitizeExportJob(task, job)
  };
}

export function getExportJob(taskId, jobId) {
  const task = ensureTask(taskId);
  syncTaskReadModel(task, {
    touchUpdatedAt: false,
    rebuildPromptSnapshots: false,
    rebuildExports: false
  });
  const job = ensureExportJob(task, jobId);
  return {
    taskId: task.id,
    filename: task.filename,
    job: sanitizeExportJob(task, job)
  };
}

export async function readExportJobArtifact(taskId, jobId) {
  const task = ensureTask(taskId);
  const job = ensureExportJob(task, jobId);

  if (job.status !== "completed" || !job.artifact?.cachePath) {
    throw createError(409, "export_job_not_ready", "Export job is not ready to download yet.");
  }

  if (exportJobIsStale(task, job)) {
    throw createError(409, "export_job_stale", "This cached export is stale because the task content changed. Create a new export job.");
  }

  if (!exportJobHasCache(job)) {
    throw createError(404, "export_cache_missing", "The cached export file is no longer available.");
  }

  const payload = await readFileAsync(exportJobCacheAbsolutePath(job.artifact.cachePath));
  return {
    taskId: task.id,
    jobId: job.id,
    filename: job.artifact.filename,
    mimeType: job.artifact.mimeType,
    payload
  };
}

export async function exportTask(taskId, format, options = {}) {
  if (!EXPORT_FORMATS.includes(format)) {
    throw createError(400, "invalid_request", `format must be one of ${EXPORT_FORMATS.join(", ")}.`);
  }

  const task = ensureTask(taskId);
  syncTaskReadModel(task, {
    touchUpdatedAt: false,
    rebuildPromptSnapshots: false,
    rebuildExports: false
  });
  const normalizedOptions = normalizeExportOptions(format, options);

  let artifact = null;
  if (format === "pdf" || format === "pdf_bilingual") {
    artifact = await buildPdfExport(task, normalizedOptions);
  } else if (format === "epub" || format === "epub_bilingual") {
    if (task.documentFormat !== "epub") {
      throw createError(409, "export_not_supported", "EPUB export is only available for EPUB tasks.");
    }
    artifact = await buildEpubExport(task, normalizedOptions);
  } else {
    artifact = clone(buildExports(task)[format]);
  }

  addActivity(
    task,
    "task_exported",
    "Task exported",
    format === "pdf" || format === "pdf_bilingual"
      ? `${task.filename} was exported as PDF (${normalizedOptions.layout}).`
      : format === "epub" || format === "epub_bilingual"
        ? `${task.filename} was exported as EPUB (${normalizedOptions.layout}).`
        : `${task.filename} was exported as ${format}.`
  );
  refreshTask(task);

  return {
    taskId: task.id,
    filename: task.filename,
    format,
    generatedAt: now(),
    options: normalizedOptions,
    export: artifact
  };
}

export function clearAllState() {
  for (const taskId of taskTimers.keys()) {
    clearTaskTimers(taskId);
  }
  tasks.clear();
  fs.rmSync(getExportCacheDir(), { recursive: true, force: true });
  resolvedExportCacheDir = "";
  runtimeSecrets.apiKey = "";
  runtimeSecrets.accessToken = "";
  appSettings = structuredClone(DEFAULT_SETTINGS);
  pendingStateSanitize = false;
}
