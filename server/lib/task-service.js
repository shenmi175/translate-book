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
import { buildPdfExport } from "./pdf-export.js";
import { buildEpubExport, parseEpubArchive, removeTaskArtifacts, reparseEpubArchive } from "./epub-service.js";
import { applyEpubTranslationUnit } from "./epub-hotpath.js";
import { testChatCompletionsConnection, translateWithDeepSeek } from "./translation-provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const DB_PATH = path.join(__dirname, "../data/db.json");
const DOTENV_PATH = path.join(ROOT_DIR, ".env");

export const SERVICE_INFO = {
  name: "Markdown and EPUB Translator Backend",
  version: "1.5.0",
  description: "A pure REST backend for block-safe Markdown and EPUB translation workflows."
};

export const EXPORT_FORMATS = ["markdown", "markdown_bilingual", "records", "annotations", "mapping", "pdf", "pdf_bilingual", "epub"];
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
const runtimeSecrets = {
  apiKey: ""
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
  delete next.hasApiKey;
  delete next.maskedApiKey;
  delete next.apiKeySource;
  delete next.apiKeyStorageKey;
  delete next.apiKeyPersistence;
  delete next.apiKeyDotenvPath;
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

function clearManagedApiKeyFromDotenv() {
  const entries = readDotenvEntries();
  const nextEntries = entries.filter((entry) => !(entry.type === "pair" && DOTENV_API_KEY_KEYS.includes(entry.key)));
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

function buildEffectiveApiEndpoint(baseUrl = "") {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function normalizePersistedSettings(settings = {}) {
  const next = { ...DEFAULT_SETTINGS, ...stripSecretFields(settings) };

  for (const field of PROMPT_CONFIG_FIELDS) {
    if (isLikelyMojibake(next[field])) {
      next[field] = DEFAULT_SETTINGS[field];
    }
  }

  next.apiKey = "";
  delete next.hasApiKey;
  delete next.maskedApiKey;
  delete next.apiKeySource;
  delete next.apiKeyStorageKey;
  delete next.apiKeyPersistence;
  delete next.apiKeyDotenvPath;
  return next;
}

function loadState() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
      if (data.appSettings) {
        if (typeof data.appSettings.apiKey === "string" && data.appSettings.apiKey.trim()) {
          pendingStateSanitize = true;
        }
        appSettings = normalizePersistedSettings(data.appSettings);
      }
      if (data.tasks) {
        for (const t of data.tasks) {
          if (t?.config) {
            if (typeof t.config.apiKey === "string" && t.config.apiKey.trim()) {
              pendingStateSanitize = true;
            }
            t.config = normalizePersistedSettings(t.config);
          } else {
            t.config = normalizePersistedSettings();
          }
          t.documentFormat = t.documentFormat || "markdown";
          t.asset = t.asset || null;
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
  }, 1000);
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

function parseEpubTranslatedSegments(rawTranslation, expectedCount, providerLabel = "Provider") {
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

  if (translations.length !== expectedCount || translations.some((value) => value === "")) {
    throw new Error(`${providerLabel} returned ${translations.length} EPUB segments, expected ${expectedCount}.`);
  }

  return translations;
}

function buildEpubPromptSnapshot(task, block, overrides = {}) {
  const sourceFragment = block.translationUnit?.sourceFragment || block.sourceMarkdown;
  const sourceText = block.translationUnit?.sourceText || block.sourceMarkdown;
  const textOnly = Boolean(block.translationUnit?.textOnly);
  const segmentMapped = Boolean(block.translationUnit?.segmentMapped);
  const segments = Array.isArray(block.translationUnit?.segments) ? block.translationUnit.segments : [];
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

  return {
    systemPrompt: EPUB_SYSTEM_PROMPT,
    translationPrompt,
    retranslationPrompt,
    rawPayload: values
  };
}

async function parseTaskInput({ taskId, filename, content, contentBase64, documentFormat }) {
  const resolvedFormat = inferDocumentFormat(filename, documentFormat);

  if (resolvedFormat === "epub") {
    const parsed = await parseEpubArchive({ taskId, contentBase64 });
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
        : "none";
  next.apiKeyDotenvPath = DOTENV_PATH;
  next.apiKeyMutationGuard = "loopback-only";
  next.effectiveApiEndpoint = buildEffectiveApiEndpoint(next.apiBaseUrl);

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

  merged.apiKey = "";
  merged.hasApiKey = Boolean(resolvedApiKey.value);
  merged.maskedApiKey = maskSecret(resolvedApiKey.value);
  merged.apiKeySource = resolvedApiKey.source;
  merged.apiKeyStorageKey = resolvedApiKey.source === "dotenv" ? resolvedApiKey.storageKey : "";
  merged.apiKeyPersistence =
    resolvedApiKey.source === "dotenv"
      ? "dotenv-file"
      : resolvedApiKey.source === "session"
        ? "memory-only"
        : "none";
  merged.apiKeyDotenvPath = DOTENV_PATH;

  return merged;
}

function getProviderSettings(task) {
  const resolvedApiKey = getResolvedApiKey();

  return {
    apiProvider: appSettings.apiProvider,
    apiKey: resolvedApiKey.value,
    apiBaseUrl: appSettings.apiBaseUrl,
    model: task.config.model,
    requestTimeoutMs: appSettings.requestTimeoutMs
  };
}

function mergeSettings(currentSettings, patch = {}) {
  const next = clone(currentSettings);
  const stringFields = [
    "apiProvider",
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

  if (patch.apiKey !== undefined) {
    if (typeof patch.apiKey !== "string") {
      throw createError(400, "invalid_request", "apiKey must be a string.");
    }
    runtimeSecrets.apiKey = patch.apiKey.trim();
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

  return {
    markdown: {
      filename: `${baseName}.zh-CN.md`,
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
  saveState();
}

function sanitizeTask(task) {
  const next = clone(task);
  next.config = sanitizeConfig(task.config);
  next.asset = sanitizeAsset(task.asset);
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
  markSessionStart(task);
  refreshTask(task);

  void (async () => {
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
      const candidateTranslation = typeof translation === "string" ? translation : "";

      if (!externallyStoppedStatus(block)) {
        let nextTranslatedMarkdown = translation;
        let translatedFragment = null;
        let structureSignature = null;

        if (task.documentFormat === "epub") {
          const applied = applyEpubTranslationResult(task, block, translation, providerLabel);
          translatedFragment = applied.normalizedFragment;
          structureSignature = applied.structureSignature;
          nextTranslatedMarkdown = applied.previewText;
        }

        if (!externallyStoppedStatus(block)) {
          block.reviewCandidateTranslation = candidateTranslation;
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
          addActivity(
            task,
            options.retranslationGoal ? "block_retranslated" : "block_translated",
            options.retranslationGoal ? "Block retranslated" : "Block translated",
            `${block.id} finished ${options.retranslationGoal ? "retranslation" : "translation"} via ${providerLabel} API.`
          );
        }
      }
    } catch (error) {
      if (!externallyStoppedStatus(block)) {
        block.status = "failed";
        block.failureCount += 1;
        block.errorMessage = error instanceof Error ? error.message : String(error);
        block.reviewErrorMessage = block.errorMessage;
        block.reviewState = block.reviewCandidateTranslation ? "pending_confirmation" : "none";
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

async function createTaskRecord({ filename, content, contentBase64, documentFormat, config = {}, source = "api" }) {
  const taskId = randomUUID();
  const parsed = await parseTaskInput({
    taskId,
    filename,
    content,
    contentBase64,
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
  task.runtime.sessionStartedAt = "";
  task.runtime.pendingQueue = [];

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

function serializeTaskPageBlock(block) {
  return {
    ...serializeTaskStatusBlock(block),
    order: block.order,
    headingPath: clone(block.headingPath || []),
    sourceMarkdown: block.sourceMarkdown,
    translatedMarkdown: block.translatedMarkdown || "",
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
    blocks: task.blocks.map(serializeTaskStatusBlock),
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
  } else if (format === "epub") {
    if (task.documentFormat !== "epub") {
      throw createError(409, "export_not_supported", "EPUB export is only available for EPUB tasks.");
    }
    artifact = await buildEpubExport(task);
  } else {
    artifact = clone(buildExports(task)[format]);
  }

  addActivity(
    task,
    "task_exported",
    "Task exported",
    format === "pdf" || format === "pdf_bilingual"
      ? `${task.filename} was exported as PDF (${normalizedOptions.layout}).`
      : format === "epub"
        ? `${task.filename} was exported as EPUB.`
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
  runtimeSecrets.apiKey = "";
  appSettings = structuredClone(DEFAULT_SETTINGS);
}





























