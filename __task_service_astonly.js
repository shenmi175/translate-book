import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCK_PROMPT_TEMPLATE,
  DEFAULT_SETTINGS,
  RETRANSLATION_PROMPT_TEMPLATE,
  SYSTEM_PROMPT
} from "../data/default-prompts.js";
import { mergeMarkdown, parseMarkdownDocument } from "./markdown.js";
import { translateWithDeepSeek } from "./translation-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "../data/db.json");

export const SERVICE_INFO = {
  name: "Markdown Translator Backend",
  version: "1.3.0",
  description: "A pure REST backend for block-safe Markdown translation workflows."
};

export const EXPORT_FORMATS = ["markdown", "records", "annotations", "mapping", "pdf"];
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

const tasks = new Map();
const taskTimers = new Map();
let appSettings = structuredClone(DEFAULT_SETTINGS);

function loadState() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (data.appSettings) {
        appSettings = { ...DEFAULT_SETTINGS, ...data.appSettings };
      }
      if (data.tasks) {
        for (const t of data.tasks) {
          if (t?.config) {
            t.config.apiKey = "";
            t.config = { ...DEFAULT_SETTINGS, ...t.config, apiKey: "" };
          }
          tasks.set(t.id, t);
        }
      }
    }
  } catch(e) { console.error("Failed to load state", e); }
}

let saveTimeout = null;
function saveState() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      const data = {
        appSettings,
        tasks: Array.from(tasks.values())
      };
      if (!fs.existsSync(path.dirname(DB_PATH))) {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
      }
      fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch(e) { console.error("Failed to save state", e); }
  }, 1000);
}

loadState();

function clone(value) {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
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

function sanitizeConfig(config) {
  const next = clone(config);
  next.apiKey = "";
  next.hasApiKey = Boolean(config.apiKey);
  next.maskedApiKey = maskSecret(config.apiKey);
  return next;
}

function buildTaskConfig(config = {}) {
  const merged = mergeSettings(appSettings, config);
  merged.apiKey = "";
  merged.hasApiKey = Boolean(appSettings.apiKey);
  merged.maskedApiKey = maskSecret(appSettings.apiKey);
  return merged;
}

function getProviderSettings(task) {
  return {
    apiProvider: appSettings.apiProvider,
    apiKey: appSettings.apiKey,
    apiBaseUrl: appSettings.apiBaseUrl,
    model: task.config.model,
    requestTimeoutMs: appSettings.requestTimeoutMs
  };
}

function mergeSettings(currentSettings, patch = {}) {
  const next = clone(currentSettings);
  const stringFields = [
    "apiProvider",
    "apiKey",
    "apiBaseUrl",
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

  const numberFields = ["retries", "concurrency", "requestTimeoutMs"];
  for (const field of numberFields) {
    if (patch[field] === undefined) continue;
    const value = Number(patch[field]);
    if (!Number.isInteger(value) || value < 0) {
      throw createError(400, "invalid_request", `${field} must be an integer greater than or equal to 0.`);
    }
    next[field] = value;
  }

  return next;
}

function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");
}

function buildPromptSnapshot(task, block, overrides = {}) {
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
  const translationSpeed = elapsedSeconds ? Number((translatedSourceCharacterCount / elapsedSeconds).toFixed(2)) : 0;
  const remainingSourceCharacters = Math.max(0, totalSourceCharacterCount - translatedSourceCharacterCount);
  const estimatedTimeRemaining = translationSpeed > 0 ? Math.ceil(remainingSourceCharacters / translationSpeed) : null;

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
    activeBlocks: counts.queued + counts.translating,
    totalSourceCharacterCount,
    translatedSourceCharacterCount,
    translatedTargetCharacterCount,
    translatedWordCount,
    translationSpeed,
    estimatedTimeRemaining,
    counts
  };
}

function exportBaseName(filename) {
  return filename.replace(/\.(md|markdown)$/i, "");
}

function buildExports(task) {
  const baseName = exportBaseName(task.filename);

  return {
    markdown: {
      filename: `${baseName}.zh-CN.md`,
      mimeType: "text/markdown; charset=utf-8",
      encoding: "utf8",
      content: mergeMarkdown(task.blocks)
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
        shouldTranslate: block.shouldTranslate,
        status: block.status,
        locked: block.locked,
        skipReason: block.skipReason
      }))
    }
  };
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

function refreshTask(task) {
  task.updatedAt = now();
  for (const block of task.blocks) {
    block.promptSnapshot = buildPromptSnapshot(task, block);
  }
  task.summary = buildSummary(task);
  task.exports = buildExports(task);
  saveState();
}

function sanitizeTask(task) {
  const next = clone(task);
  next.config = sanitizeConfig(task.config);
  return next;
}

function summarizeTask(task) {
  return {
    id: task.id,
    filename: task.filename,
    source: task.source,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    stage: task.summary.stage,
    parser: task.parser,
    stats: task.stats,
    summary: task.summary
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
    throw createError(409, "provider_not_configured", "DeepSeek API key is not configured.");
  }

  if (provider.apiProvider && provider.apiProvider !== "DeepSeek") {
    throw createError(400, "unsupported_provider", `Unsupported apiProvider ${provider.apiProvider}.`);
  }

  if (!provider.model) {
    throw createError(400, "invalid_request", "model is required for translation.");
  }

  if (!provider.apiBaseUrl) {
    throw createError(400, "invalid_request", "apiBaseUrl is required for translation.");
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

function markSessionStart(task) {
  if (!task.runtime.sessionStartedAt || task.summary.stage === "paused" || task.summary.stage === "cancelled") {
    task.runtime.sessionStartedAt = now();
  }
}

function scheduleBlockTranslation(task, block, options = {}) {
  clearBlockTimers(task.id, block.id);

  block.status = "queued";
  block.errorMessage = "";
  markSessionStart(task);
  refreshTask(task);

  const startDelay = options.offsetMs || 120;
  const finishDelay = startDelay + 360;

  const startTimer = setTimeout(() => {
    block.status = "translating";
    refreshTask(task);
  }, startDelay);

  const finishTimer = setTimeout(async () => {
    try {
      const promptSnapshot = buildPromptSnapshot(task, block, {
        retranslationGoal: options.retranslationGoal,
        focus: options.focus
      });
      block.promptSnapshot = promptSnapshot;

      const { translation } = await translateWithDeepSeek({
        provider: getProviderSettings(task),
        promptSnapshot,
        useRetranslationPrompt: Boolean(options.retranslationGoal)
      });

      block.translatedMarkdown = translation;
      block.status = options.retranslationGoal ? "retranslated" : "translated";
      block.lastTranslatedAt = now();
      block.retryCount += options.retranslationGoal ? 1 : 0;
      addActivity(
        task,
        options.retranslationGoal ? "block_retranslated" : "block_translated",
        options.retranslationGoal ? "Block retranslated" : "Block translated",
        `${block.id} finished ${options.retranslationGoal ? "retranslation" : "translation"} via DeepSeek API.`
      );
    } catch (error) {
      block.status = "failed";
      block.failureCount += 1;
      block.errorMessage = error instanceof Error ? error.message : String(error);
      addActivity(task, "block_failed", "Block translation failed", `${block.id} failed: ${block.errorMessage}`);
    }

    refreshTask(task);
    clearBlockTimers(task.id, block.id);
  }, finishDelay);

  rememberBlockTimer(task.id, block.id, startTimer);
  rememberBlockTimer(task.id, block.id, finishTimer);
}

function createTaskRecord({ filename, content, config = {}, source = "api" }) {
  const parsed = parseMarkdownDocument(content);
  const task = {
    id: randomUUID(),
    filename,
    source,
    sourceMarkdown: content,
    createdAt: now(),
    updatedAt: now(),
    config: buildTaskConfig(config),
    parser: parsed.parser,
    stats: parsed.stats,
    blocks: parsed.blocks.map((block) => ({
      ...block,
      promptSnapshot: null
    })),
    annotations: [],
    comments: [],
    activity: [],
    summary: null,
    exports: {},
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

function reparseIntoTask(task, payload = {}) {
  if (payload.filename !== undefined) {
    task.filename = requireNonEmptyString(payload.filename, "filename");
  }

  if (payload.content !== undefined) {
    task.sourceMarkdown = requireNonEmptyString(payload.content, "content");
  }

  if (payload.config !== undefined) {
    if (!payload.config || typeof payload.config !== "object" || Array.isArray(payload.config)) {
      throw createError(400, "invalid_request", "config must be an object.");
    }
    task.config = buildTaskConfig({ ...task.config, ...payload.config });
  }

  clearTaskTimers(task.id);

  const parsed = parseMarkdownDocument(task.sourceMarkdown);
  task.parser = parsed.parser;
  task.stats = parsed.stats;
  task.blocks = parsed.blocks.map((block) => ({
    ...block,
    promptSnapshot: null
  }));
  task.annotations = [];
  task.comments = [];
  task.runtime.sessionStartedAt = "";

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

export function getServiceOverview(origin) {
  return {
    service: SERVICE_INFO,
    baseUrl: `${origin}/api`,
    docsPath: "/api/docs",
    openApiPath: "/openapi.yaml",
    healthPath: "/health"
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

export function updateSettings(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  appSettings = mergeSettings(appSettings, patch);
  saveState();
  return getSettings();
}

export function createTask(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const filename = requireNonEmptyString(input.filename, "filename");
  const content = requireNonEmptyString(input.content, "content");
  const config = input.config ?? {};

  if (config && (typeof config !== "object" || Array.isArray(config))) {
    throw createError(400, "invalid_request", "config must be an object.");
  }

  return sanitizeTask(createTaskRecord({ filename, content, config }));
}

export function getTask(taskId) {
  return sanitizeTask(ensureTask(taskId));
}

export function getBlock(taskId, blockId) {
  const task = ensureTask(taskId);
  const block = ensureBlock(task, blockId);
  block.promptSnapshot = buildPromptSnapshot(task, block);
  refreshTask(task);

  return {
    taskId: task.id,
    updatedAt: task.updatedAt,
    block: clone(block)
  };
}

export function reparseTask(taskId, payload = {}) {
  const task = ensureTask(taskId);
  reparseIntoTask(task, payload);
  return sanitizeTask(task);
}

export function getTaskStatus(taskId) {
  const task = ensureTask(taskId);
  refreshTask(task);

  return {
    taskId: task.id,
    filename: task.filename,
    updatedAt: task.updatedAt,
    stage: task.summary.stage,
    summary: clone(task.summary),
    blocks: task.blocks.map((block) => ({
      id: block.id,
      type: block.type,
      status: block.status,
      shouldTranslate: block.shouldTranslate,
      locked: block.locked,
      errorMessage: block.errorMessage,
      lastTranslatedAt: block.lastTranslatedAt,
      lastEditedAt: block.lastEditedAt
    }))
  };
}

export function getBlockPrompt(taskId, blockId) {
  const task = ensureTask(taskId);
  const block = ensureBlock(task, blockId);
  block.promptSnapshot = buildPromptSnapshot(task, block);
  refreshTask(task);

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

  eligibleBlocks.forEach((block, index) => {
    scheduleBlockTranslation(task, block, { offsetMs: 120 + index * 180 });
  });

  addActivity(task, "task_translation_started", "Task translation started", `${eligibleBlocks.length} blocks were scheduled.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function pauseTask(taskId) {
  const task = ensureTask(taskId);
  clearTaskTimers(taskId);

  let pausedCount = 0;
  for (const block of task.blocks) {
    if (activeStatus(block.status)) {
      block.status = "paused";
      pausedCount += 1;
    }
  }

  addActivity(task, "task_paused", "Task paused", `${pausedCount} active blocks were paused.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function cancelTask(taskId) {
  const task = ensureTask(taskId);
  clearTaskTimers(taskId);

  let cancelledCount = 0;
  for (const block of task.blocks) {
    if (activeStatus(block.status) || block.status === "paused") {
      block.status = "cancelled";
      block.errorMessage = "";
      cancelledCount += 1;
    }
  }

  addActivity(task, "task_cancelled", "Task cancelled", `${cancelledCount} pending blocks were cancelled.`);
  refreshTask(task);
  return sanitizeTask(task);
}

export function deleteTask(taskId) {
  const task = ensureTask(taskId);
  clearTaskTimers(taskId);
  tasks.delete(taskId);
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
  scheduleBlockTranslation(task, block, { offsetMs: 120 });
  addActivity(task, "block_translation_started", "Block translation started", `${block.id} was added to the translation queue.`);
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

  scheduleBlockTranslation(task, block, {
    offsetMs: 120,
    retranslationGoal,
    focus
  });

  block.promptSnapshot = buildPromptSnapshot(task, block, {
    retranslationGoal,
    focus
  });

  addActivity(task, "block_retranslation_started", "Block retranslation started", `${block.id} will be retranslated with goal ${retranslationGoal}.`);
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

  const scheduledBlockIds = [];
  const skipped = [];

  blockIds.forEach((blockId, index) => {
    try {
      const block = ensureTranslatableBlock(task, blockId);

      scheduleBlockTranslation(task, block, {
        offsetMs: 120 + index * 180,
        retranslationGoal,
        focus
      });

      block.promptSnapshot = buildPromptSnapshot(task, block, {
        retranslationGoal,
        focus
      });
      scheduledBlockIds.push(block.id);
    } catch (error) {
      skipped.push({
        blockId,
        code: error?.code || "internal_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  addActivity(
    task,
    "batch_retranslation_started",
    "Batch retranslation started",
    `${scheduledBlockIds.length} blocks were scheduled for retranslation.`
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

export function updateBlock(taskId, blockId, patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw createError(400, "invalid_request", "Request body must be an object.");
  }

  const task = ensureTask(taskId);
  const block = ensureBlock(task, blockId);

  let changed = false;

  if (patch.translatedMarkdown !== undefined) {
    if (typeof patch.translatedMarkdown !== "string") {
      throw createError(400, "invalid_request", "translatedMarkdown must be a string.");
    }
    block.translatedMarkdown = patch.translatedMarkdown;
    block.status = "edited";
    block.errorMessage = "";
    block.lastEditedAt = now();
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
    throw createError(400, "invalid_request", "At least one of translatedMarkdown or locked must be provided.");
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

export function exportTask(taskId, format) {
  if (!EXPORT_FORMATS.includes(format)) {
    throw createError(400, "invalid_request", `format must be one of ${EXPORT_FORMATS.join(", ")}.`);
  }

  if (format === "pdf") {
    throw createError(501, "not_implemented", "PDF export is reserved but not implemented in the live backend yet.");
  }

  const task = ensureTask(taskId);
  refreshTask(task);

  return {
    taskId: task.id,
    filename: task.filename,
    format,
    generatedAt: now(),
    export: clone(task.exports[format])
  };
}

export function clearAllState() {
  for (const taskId of taskTimers.keys()) {
    clearTaskTimers(taskId);
  }
  tasks.clear();
  appSettings = structuredClone(DEFAULT_SETTINGS);
}
