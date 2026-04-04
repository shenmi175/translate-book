import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PDF_LAYOUTS = new Set(["translation-only", "bilingual"]);
const PAGE = {
  width: 595.28,
  height: 841.89,
  marginX: 46,
  marginTop: 54,
  marginBottom: 48,
  gutter: 20
};

const BROWSER_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

const COLORS = {
  ink: "0.12 0.16 0.24",
  muted: "0.44 0.49 0.58",
  accent: "0.17 0.34 0.62",
  line: "0.84 0.87 0.91",
  panel: "0.96 0.97 0.99",
  codePanel: "0.95 0.96 0.98"
};

function createError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
}

function translatedStatus(status) {
  return status === "translated" || status === "edited" || status === "retranslated";
}

function normalizeLayout(layout = "translation-only") {
  const value = typeof layout === "string" && layout.trim() ? layout.trim().toLowerCase() : "translation-only";
  if (!PDF_LAYOUTS.has(value)) {
    throw createError(400, "invalid_request", "layout must be one of translation-only or bilingual.");
  }
  return value;
}

function exportBaseName(filename) {
  return filename.replace(/\.(md|markdown|epub)$/i, "");
}

function escapeHtml(value = "") {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeInlineMarkdown(text = "") {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `${alt || "Image"} (${src})`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `${label} (${url})`)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
}

function cleanMarkdownForPdf(markdown = "", type = "paragraph") {
  const normalized = markdown.replace(/\r\n?/g, "\n").trimEnd();

  if (!normalized) {
    return "";
  }

  switch (type) {
    case "heading":
      return decodeInlineMarkdown(normalized.replace(/^\s{0,3}#{1,6}\s+/, "").trim());
    case "list_item": {
      const match = normalized.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/s);
      if (!match) {
        return decodeInlineMarkdown(normalized);
      }
      const marker = /^\d/.test(match[2]) ? `${match[2]} ` : "- ";
      return `${marker}${decodeInlineMarkdown(match[3].trim())}`;
    }
    case "blockquote":
      return decodeInlineMarkdown(normalized.replace(/^\s*>\s?/gm, "").trim());
    case "fenced_code": {
      const lines = normalized.split("\n");
      const first = lines[0] || "";
      const language = first.replace(/^\s*(```|~~~)/, "").trim();
      const bodyLines = lines.slice(1, lines[lines.length - 1]?.match(/^\s*(```|~~~)/) ? -1 : undefined);
      const body = bodyLines.join("\n").trimEnd();
      return language ? `[${language}]\n${body}` : body;
    }
    case "table": {
      const lines = normalized.split("\n").filter(Boolean);
      const filtered = lines.filter((line, index) => {
        if (index !== 1) {
          return true;
        }
        return !/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
      });
      return filtered
        .map((line) =>
          line
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => decodeInlineMarkdown(cell.trim()))
            .join(" | ")
        )
        .join("\n");
    }
    case "image": {
      const match = normalized.match(/!\[([^\]]*)\]\(([^)]+)\)/);
      if (!match) {
        return decodeInlineMarkdown(normalized);
      }
      const alt = match[1] || "Image";
      return `${alt}\n${match[2]}`;
    }
    case "math_block":
      return normalized.replace(/^\s*\$\$\s*\n?/, "").replace(/\n?\$\$\s*$/, "").trim();
    case "thematic_break":
      return "";
    default:
      return decodeInlineMarkdown(normalized);
  }
}

function headingLevel(markdown = "") {
  const match = markdown.match(/^\s{0,3}(#{1,6})\s+/);
  return match ? match[1].length : 1;
}

function blockStyle(block) {
  if (block.type === "heading") {
    const level = headingLevel(block.sourceMarkdown);
    const sizes = [22, 18, 15, 13, 12, 11];
    return {
      fontSize: sizes[level - 1] || 11,
      lineHeight: (sizes[level - 1] || 11) * 1.35,
      gapAfter: 12,
      metaSize: 8
    };
  }

  if (block.type === "fenced_code" || block.type === "math_block" || block.type === "frontmatter" || block.type === "html_block") {
    return { fontSize: 9, lineHeight: 13, gapAfter: 10, metaSize: 8, panel: COLORS.codePanel };
  }

  if (block.type === "table") {
    return { fontSize: 9.5, lineHeight: 13.5, gapAfter: 10, metaSize: 8, panel: COLORS.panel };
  }

  return { fontSize: 11, lineHeight: 15.5, gapAfter: 10, metaSize: 8 };
}

function pickTargetMarkdown(block) {
  if (block.shouldTranslate && translatedStatus(block.status) && block.translatedMarkdown) {
    return block.translatedMarkdown;
  }
  return block.sourceMarkdown;
}

function createRenderableBlocks(task) {
  return task.blocks.map((block) => {
    const style = blockStyle(block);
    return {
      id: block.id,
      type: block.type,
      style,
      source: cleanMarkdownForPdf(block.sourceMarkdown, block.type),
      target: cleanMarkdownForPdf(pickTargetMarkdown(block), block.type),
      status: block.status,
      shouldTranslate: block.shouldTranslate
    };
  });
}

function renderHtmlDocument(task, layout, generatedAt) {
  const blocks = createRenderableBlocks(task);
  const headerLabel = layout === "bilingual" ? "Bilingual PDF Export" : "Translation-only PDF Export";

  const content =
    layout === "bilingual"
      ? blocks
          .map((block) => {
            if (block.type === "thematic_break") {
              return "<hr />";
            }
            const headingClass =
              block.type === "heading"
                ? `heading heading-${Math.min(headingLevel(task.blocks.find((item) => item.id === block.id)?.sourceMarkdown || ""), 6)}`
                : "body";
            return `
              <section class="block">
                <div class="stack">
                  <div class="pane">
                    <div class="pane-label">Original</div>
                    <pre class="${headingClass}">${escapeHtml(block.source)}</pre>
                  </div>
                  <div class="pane">
                    <div class="pane-label">Translation</div>
                    <pre class="${headingClass}">${escapeHtml(block.target)}</pre>
                  </div>
                </div>
              </section>
            `;
          })
          .join("\n")
      : blocks
          .map((block) => {
            if (block.type === "thematic_break") {
              return "<hr />";
            }
            const cls = block.type === "heading" ? `heading heading-${Math.min(headingLevel(task.blocks.find((item) => item.id === block.id)?.sourceMarkdown || ""), 6)}` : "body";
            return `
              <section class="block">
                <pre class="${cls}">${escapeHtml(block.target)}</pre>
              </section>
            `;
          })
          .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(task.filename)} - ${headerLabel}</title>
    <style>
      @page { size: A4; margin: 18mm 14mm; }
      body {
        font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
        color: #1f2937;
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: flex-end;
        border-bottom: 1px solid #dbe3ef;
        padding-bottom: 10px;
        margin-bottom: 18px;
      }
      h1 {
        margin: 0;
        font-size: 24px;
        color: #1d4f91;
      }
      .subtitle {
        margin-top: 4px;
        color: #64748b;
        font-size: 12px;
      }
      .export-meta {
        color: #64748b;
        font-size: 11px;
        text-align: right;
      }
      .block {
        break-inside: avoid;
        margin-bottom: 18px;
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .pane {
        border: 1px solid #dbe3ef;
        border-radius: 10px;
        padding: 10px 12px;
        background: #fbfdff;
      }
      .pane-label {
        font-size: 11px;
        font-weight: 700;
        color: #1d4f91;
        margin-bottom: 6px;
        text-transform: uppercase;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
      }
      .heading {
        font-weight: 700;
        color: #0f172a;
      }
      .heading-1 { font-size: 24px; line-height: 1.3; }
      .heading-2 { font-size: 20px; line-height: 1.35; }
      .heading-3 { font-size: 17px; line-height: 1.4; }
      .heading-4 { font-size: 15px; line-height: 1.45; }
      hr {
        border: none;
        border-top: 1px solid #dbe3ef;
        margin: 18px 0;
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <h1>${escapeHtml(task.filename)}</h1>
        <div class="subtitle">${headerLabel}</div>
      </div>
      <div class="export-meta">
        <div>${layout}</div>
        <div>${escapeHtml(generatedAt)}</div>
      </div>
    </header>
    ${content}
  </body>
</html>`;
}

async function findBrowserExecutable() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

async function spawnBrowserPdf(executable, html, pdfPath) {
  const tempDir = path.dirname(pdfPath);
  const htmlPath = path.join(tempDir, "document.html");
  const profilePath = path.join(tempDir, "profile");
  await writeFile(htmlPath, html, "utf8");

  return new Promise((resolve, reject) => {
    const args = [
      "--headless",
      "--disable-gpu",
      "--disable-crashpad-for-testing",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profilePath}`,
      "--print-to-pdf-no-header",
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, "/")}`
    ];

    const child = spawn(executable, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(createError(503, "pdf_renderer_timeout", "Browser PDF renderer timed out."));
    }, 15000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(createError(503, "pdf_renderer_failed", error.message));
    });

    child.on("exit", async (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(createError(503, "pdf_renderer_failed", stderr.trim() || `Browser PDF renderer exited with code ${code}.`));
        return;
      }

      try {
        const info = await stat(pdfPath);
        if (!info.size) {
          reject(createError(503, "pdf_renderer_failed", "Browser PDF renderer produced an empty file."));
          return;
        }
        resolve(await readFile(pdfPath));
      } catch (error) {
        reject(createError(503, "pdf_renderer_failed", error instanceof Error ? error.message : String(error)));
      }
    });
  });
}

function estimateUnitWidth(character) {
  if (character === "\t") return 1.2;
  if (character === " ") return 0.32;
  if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(character)) return 1;
  if (/[A-Z]/.test(character)) return 0.66;
  if (/[a-z0-9]/.test(character)) return 0.56;
  if (/[\r\n]/.test(character)) return 0;
  return 0.62;
}

function maxTextUnits(width, fontSize) {
  return Math.max(8, width / (fontSize * 0.58));
}

function wrapText(text = "", width, fontSize) {
  const maxUnits = maxTextUnits(width, fontSize);
  const paragraphs = String(text).replace(/\r\n?/g, "\n").split("\n");
  const lines = [];

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let current = "";
    let currentUnits = 0;

    for (const character of paragraph) {
      const units = estimateUnitWidth(character);
      if (current && currentUnits + units > maxUnits) {
        lines.push(current);
        current = character;
        currentUnits = units;
      } else {
        current += character;
        currentUnits += units;
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  while (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.length ? lines : [""];
}

function utf16BeHex(text = "") {
  const utf16le = Buffer.from(String(text), "utf16le");
  const utf16be = Buffer.alloc(utf16le.length);
  for (let index = 0; index < utf16le.length; index += 2) {
    utf16be[index] = utf16le[index + 1];
    utf16be[index + 1] = utf16le[index];
  }
  return utf16be.toString("hex").toUpperCase();
}

function pdfText(text, x, y, fontSize, color = COLORS.ink) {
  if (!text) {
    return "";
  }
  return `BT\n/F1 ${fontSize} Tf\n${color} rg\n1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm\n<${utf16BeHex(text)}> Tj\nET\n`;
}

function pdfLine(x1, y1, x2, y2, width = 1, color = COLORS.line) {
  return `${color} RG\n${width} w\n${x1.toFixed(2)} ${y1.toFixed(2)} m\n${x2.toFixed(2)} ${y2.toFixed(2)} l\nS\n`;
}

function pdfRectFill(x, y, width, height, color = COLORS.panel) {
  return `q\n${color} rg\n${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re\nf\nQ\n`;
}

function buildPageHeader(page, layout, pageNumber, pageCount) {
  const commands = [];
  const title = layout === "bilingual" ? `${page.title} - bilingual export` : `${page.title} - translation export`;

  commands.push(pdfText(title, PAGE.marginX, PAGE.height - 36, 16, COLORS.accent));
  commands.push(pdfText(`Exported at ${page.generatedAt}`, PAGE.marginX, PAGE.height - 54, 9, COLORS.muted));
  commands.push(
    pdfText(
      layout === "bilingual" ? "Original above, translation below" : "Translation view",
      PAGE.marginX,
      PAGE.height - 68,
      9,
      COLORS.muted
    )
  );
  commands.push(pdfText(`Page ${pageNumber} / ${pageCount}`, PAGE.width - PAGE.marginX - 70, PAGE.height - 36, 9, COLORS.muted));
  commands.push(pdfLine(PAGE.marginX, PAGE.height - 78, PAGE.width - PAGE.marginX, PAGE.height - 78));
  return commands.join("");
}

function paginateTranslationOnly(task, renderableBlocks, generatedAt) {
  const pages = [];
  let current = { title: task.filename, generatedAt, commands: "", cursorY: PAGE.height - 94 };

  function pushPage() {
    pages.push(current);
    current = { title: task.filename, generatedAt, commands: "", cursorY: PAGE.height - 94 };
  }

  function ensureSpace(height) {
    if (current.cursorY - height < PAGE.marginBottom) {
      pushPage();
    }
  }

  const width = PAGE.width - PAGE.marginX * 2;

  for (const block of renderableBlocks) {
    if (block.type === "thematic_break") {
      ensureSpace(20);
      current.commands += pdfLine(PAGE.marginX, current.cursorY - 4, PAGE.width - PAGE.marginX, current.cursorY - 4);
      current.cursorY -= 18;
      continue;
    }

    const lines = wrapText(block.target, width, block.style.fontSize);
    const textHeight = lines.length * block.style.lineHeight;
    const boxHeight = textHeight + 18;
    const needed = boxHeight + block.style.gapAfter;

    ensureSpace(needed);

    if (block.style.panel) {
      current.commands += pdfRectFill(PAGE.marginX - 4, current.cursorY - textHeight - 10, width + 8, boxHeight, block.style.panel);
    }

    let lineY = current.cursorY - block.style.fontSize;
    for (const line of lines) {
      current.commands += pdfText(line, PAGE.marginX, lineY, block.style.fontSize, COLORS.ink);
      lineY -= block.style.lineHeight;
    }

    current.cursorY = current.cursorY - textHeight - block.style.gapAfter;
  }

  pages.push(current);
  return pages;
}

function paginateBilingual(task, renderableBlocks, generatedAt) {
  const pages = [];
  let current = { title: task.filename, generatedAt, commands: "", cursorY: PAGE.height - 94 };

  function pushPage() {
    pages.push(current);
    current = { title: task.filename, generatedAt, commands: "", cursorY: PAGE.height - 94 };
  }

  function ensureSpace(height) {
    if (current.cursorY - height < PAGE.marginBottom) {
      pushPage();
    }
  }

  const totalWidth = PAGE.width - PAGE.marginX * 2;

  for (const block of renderableBlocks) {
    if (block.type === "thematic_break") {
      ensureSpace(20);
      current.commands += pdfLine(PAGE.marginX, current.cursorY - 4, PAGE.width - PAGE.marginX, current.cursorY - 4);
      current.cursorY -= 18;
      continue;
    }

    const sourceLines = wrapText(block.source, totalWidth, block.style.fontSize);
    const targetLines = wrapText(block.target, totalWidth, block.style.fontSize);
    const sourceHeight = sourceLines.length * block.style.lineHeight;
    const targetHeight = targetLines.length * block.style.lineHeight;
    const sourceBoxHeight = sourceHeight + 24;
    const targetBoxHeight = targetHeight + 24;
    const needed = sourceBoxHeight + targetBoxHeight + block.style.gapAfter + 18;

    ensureSpace(needed);

    if (block.style.panel) {
      current.commands += pdfRectFill(PAGE.marginX - 4, current.cursorY - sourceHeight - 18, totalWidth + 8, sourceBoxHeight, block.style.panel);
    }

    current.commands += pdfText("Original", PAGE.marginX, current.cursorY, 8.5, COLORS.accent);
    current.commands += pdfLine(PAGE.marginX, current.cursorY - 4, PAGE.width - PAGE.marginX, current.cursorY - 4, 0.7);

    let leftY = current.cursorY - 16;
    for (const line of sourceLines) {
      current.commands += pdfText(line, PAGE.marginX, leftY, block.style.fontSize, COLORS.ink);
      leftY -= block.style.lineHeight;
    }

    current.cursorY = current.cursorY - sourceHeight - 22;

    if (block.style.panel) {
      current.commands += pdfRectFill(PAGE.marginX - 4, current.cursorY - targetHeight - 18, totalWidth + 8, targetBoxHeight, block.style.panel);
    }

    current.commands += pdfText("Translation", PAGE.marginX, current.cursorY, 8.5, COLORS.accent);
    current.commands += pdfLine(PAGE.marginX, current.cursorY - 4, PAGE.width - PAGE.marginX, current.cursorY - 4, 0.7);

    let rightY = current.cursorY - 16;
    for (const line of targetLines) {
      current.commands += pdfText(line, PAGE.marginX, rightY, block.style.fontSize, COLORS.ink);
      rightY -= block.style.lineHeight;
    }

    current.cursorY = current.cursorY - targetHeight - block.style.gapAfter - 22;
  }

  pages.push(current);
  return pages;
}

function buildFallbackPdfDocument(pageCommands, title, generatedAt) {
  const objects = [null];
  const reserve = () => {
    objects.push(null);
    return objects.length - 1;
  };

  const catalogId = reserve();
  const pagesId = reserve();
  const fontId = reserve();
  const descendantFontId = reserve();
  const infoId = reserve();
  const pageIds = [];

  objects[descendantFontId] =
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>";
  objects[fontId] = `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${descendantFontId} 0 R] >>`;

  for (const page of pageCommands) {
    const streamId = reserve();
    const pageId = reserve();
    const body = Buffer.from(page, "utf8");
    objects[streamId] = Buffer.concat([
      Buffer.from(`<< /Length ${body.length} >>\nstream\n`, "utf8"),
      body,
      Buffer.from("\nendstream", "utf8")
    ]);
    objects[pageId] =
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE.width.toFixed(2)} ${PAGE.height.toFixed(2)}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`;
    pageIds.push(pageId);
  }

  objects[pagesId] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[catalogId] = `<< /Type /Catalog /Pages ${pagesId} 0 R /PageLayout /OneColumn >>`;
  objects[infoId] = `<< /Title (${title.replace(/[()\\]/g, "\\$&")}) /Producer (Markdown Translator Backend) /CreationDate (${generatedAt}) >>`;

  const header = Buffer.from("%PDF-1.7\n%\xD3\xF4\xCC\xC6\n", "binary");
  const parts = [header];
  const offsets = [0];
  let offset = header.length;

  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = offset;
    const prefix = Buffer.from(`${id} 0 obj\n`, "utf8");
    const body = Buffer.isBuffer(objects[id]) ? objects[id] : Buffer.from(`${objects[id]}\n`, "utf8");
    const suffix = Buffer.from("\nendobj\n", "utf8");
    parts.push(prefix, body, suffix);
    offset += prefix.length + body.length + suffix.length;
  }

  const xrefOffset = offset;
  const xrefLines = ["xref", `0 ${objects.length}`, "0000000000 65535 f "];
  for (let id = 1; id < objects.length; id += 1) {
    xrefLines.push(`${String(offsets[id]).padStart(10, "0")} 00000 n `);
  }

  const trailer =
    `${xrefLines.join("\n")}\ntrailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(Buffer.from(trailer, "utf8"));
  return Buffer.concat(parts);
}

function buildFallbackPdfBuffer(task, layout, generatedAt) {
  const renderableBlocks = createRenderableBlocks(task);
  const pages =
    layout === "bilingual"
      ? paginateBilingual(task, renderableBlocks, generatedAt)
      : paginateTranslationOnly(task, renderableBlocks, generatedAt);
  const pageCommands = pages.map((page, index) => buildPageHeader(page, layout, index + 1, pages.length) + page.commands);
  const title = `${exportBaseName(task.filename)} ${layout}`;
  return buildFallbackPdfDocument(pageCommands, title, generatedAt);
}

function buildArtifactFromBuffer(task, layout, generatedAt, pdfBuffer, renderer) {
  const baseName = exportBaseName(task.filename);
  return {
    filename: `${baseName}.${layout === "bilingual" ? "bilingual" : "zh-CN"}.pdf`,
    mimeType: "application/pdf",
    encoding: "base64",
    previewText: layout === "bilingual" ? "Bilingual PDF export" : "Translation-only PDF export",
    content: pdfBuffer.toString("base64"),
    sizeBytes: pdfBuffer.length,
    layout,
    renderer,
    generatedAt
  };
}

export async function buildPdfExport(task, options = {}) {
  const layout = normalizeLayout(options.layout);
  const generatedAt = new Date().toISOString();

  const browser = await findBrowserExecutable();
  if (browser) {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), `mts-pdf-${randomUUID()}-`));
    try {
      const pdfPath = path.join(tempDir, "export.pdf");
      const html = renderHtmlDocument(task, layout, generatedAt);
      const pdfBuffer = await spawnBrowserPdf(browser, html, pdfPath);
      return buildArtifactFromBuffer(task, layout, generatedAt, pdfBuffer, "chromium");
    } catch {
      const fallbackBuffer = buildFallbackPdfBuffer(task, layout, generatedAt);
      return buildArtifactFromBuffer(task, layout, generatedAt, fallbackBuffer, "fallback");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  const fallbackBuffer = buildFallbackPdfBuffer(task, layout, generatedAt);
  return buildArtifactFromBuffer(task, layout, generatedAt, fallbackBuffer, "fallback");
}
