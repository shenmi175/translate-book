import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveExportLanguage } from "./export-language.js";
import { mergeMarkdown } from "./markdown.js";

const EPUB_LAYOUTS = new Set(["translation-only", "bilingual"]);
const PANDOC_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Pandoc\\pandoc.exe",
    "C:\\Program Files (x86)\\Pandoc\\pandoc.exe"
  ],
  darwin: [
    "/opt/homebrew/bin/pandoc",
    "/usr/local/bin/pandoc",
    "/usr/bin/pandoc"
  ],
  linux: [
    "/usr/bin/pandoc",
    "/usr/local/bin/pandoc"
  ]
};
const PANDOC_COMMANDS = process.platform === "win32" ? ["pandoc.exe", "pandoc"] : ["pandoc"];

const DEFAULT_EPUB_STYLESHEET = `:root {
  color-scheme: light;
}

html, body {
  margin: 0;
  padding: 0;
}

body {
  font-family: "Noto Serif", "Source Han Serif SC", serif;
  line-height: 1.68;
  word-break: break-word;
}

h1, h2, h3, h4, h5, h6 {
  line-height: 1.3;
  margin: 1.1em 0 0.55em;
}

p, li, blockquote {
  margin: 0.7em 0;
}

pre, code {
  font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
}

pre {
  white-space: pre-wrap;
}

blockquote {
  margin-left: 0;
  padding-left: 1em;
  border-left: 0.25em solid #cbd5e1;
  color: #334155;
}

table {
  border-collapse: collapse;
  width: 100%;
}

th, td {
  border: 1px solid #cbd5e1;
  padding: 0.45em 0.6em;
  text-align: left;
  vertical-align: top;
}

img {
  max-width: 100%;
  height: auto;
}
`;

let preferredPandocCommand = null;

function createError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function normalizeLayout(layout = "translation-only") {
  const value = typeof layout === "string" && layout.trim() ? layout.trim().toLowerCase() : "translation-only";
  if (!EPUB_LAYOUTS.has(value)) {
    throw createError(400, "invalid_request", "layout must be one of translation-only or bilingual.");
  }
  return value;
}

function uniqueCandidates(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function pandocCandidates() {
  return uniqueCandidates([
    preferredPandocCommand,
    process.env.MARKDOWN_TRANSLATOR_PANDOC_BIN,
    process.env.PANDOC_BIN,
    ...PANDOC_COMMANDS,
    ...(PANDOC_CANDIDATES[process.platform] || [])
  ]);
}

async function runPandoc(args = []) {
  let lastError = null;

  for (const candidate of pandocCandidates()) {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(candidate, args, { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (error) => {
          if (error?.code === "ENOENT") {
            const missing = createError(
              503,
              "markdown_epub_renderer_unavailable",
              "Markdown-to-EPUB export requires Pandoc. Install pandoc or set MARKDOWN_TRANSLATOR_PANDOC_BIN."
            );
            missing.isToolMissing = true;
            reject(missing);
            return;
          }
          reject(error);
        });

        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(
            createError(
              422,
              "markdown_epub_render_failed",
              stderr.trim() || `Pandoc exited with code ${code}.`,
              { command: candidate }
            )
          );
        });
      });

      preferredPandocCommand = candidate;
      return candidate;
    } catch (error) {
      lastError = error;
      if (error?.isToolMissing) {
        continue;
      }
      throw error;
    }
  }

  throw lastError || createError(
    503,
    "markdown_epub_renderer_unavailable",
    "Markdown-to-EPUB export requires Pandoc. Install pandoc or set MARKDOWN_TRANSLATOR_PANDOC_BIN."
  );
}

function exportBaseName(filename) {
  return String(filename || "document").replace(/\.(md|markdown|epub)$/i, "");
}

function buildMarkdownSource(task, layout) {
  return mergeMarkdown(task?.blocks || [], layout === "bilingual" ? "bilingual" : "target_only").trim();
}

function buildMetadataPayload(task, exportLanguage, layout) {
  const title = exportBaseName(task?.filename) || "document";
  return {
    title,
    lang: exportLanguage.tag || "und",
    identifier: task?.id ? `translate-book:${task.id}:${layout}` : `translate-book:${randomUUID()}`,
    creator: "Translate Book",
    date: new Date().toISOString().slice(0, 10)
  };
}

export async function buildMarkdownEpubExport(task, options = {}) {
  const layout = normalizeLayout(options.layout);
  const exportLanguage = resolveExportLanguage(task?.config?.targetLanguage);
  const outputFilename = `${exportBaseName(task?.filename)}.${layout === "bilingual" ? "bilingual" : exportLanguage.suffix}.epub`;
  const markdown = buildMarkdownSource(task, layout) || `# ${exportBaseName(task?.filename) || "Document"}\n`;
  const workingDir = await mkdtemp(path.join(os.tmpdir(), `mts-md-epub-${randomUUID()}-`));
  const inputPath = path.join(workingDir, "document.md");
  const metadataPath = path.join(workingDir, "metadata.json");
  const cssPath = path.join(workingDir, "epub.css");
  const outputPath = path.join(workingDir, outputFilename);

  try {
    await writeFile(inputPath, markdown, "utf8");
    await writeFile(metadataPath, `${JSON.stringify(buildMetadataPayload(task, exportLanguage, layout), null, 2)}\n`, "utf8");
    await writeFile(cssPath, DEFAULT_EPUB_STYLESHEET, "utf8");

    const renderer = await runPandoc([
      "--from",
      "gfm+tex_math_dollars+tex_math_single_backslash",
      "--to",
      "epub3",
      "--standalone",
      "--toc",
      "--mathml",
      "--metadata-file",
      metadataPath,
      "--css",
      cssPath,
      "-o",
      outputPath,
      inputPath
    ]);

    const buffer = await readFile(outputPath);
    const fileStats = await stat(outputPath);
    return {
      filename: outputFilename,
      mimeType: "application/epub+zip",
      encoding: "base64",
      previewText: layout === "bilingual" ? "Bilingual EPUB export" : "Translation-only EPUB export",
      content: buffer.toString("base64"),
      sizeBytes: fileStats.size,
      generatedAt: new Date().toISOString(),
      renderer: renderer.includes("pandoc") ? "pandoc" : renderer,
      validator: "pandoc",
      layout
    };
  } finally {
    await rm(workingDir, { recursive: true, force: true });
  }
}
