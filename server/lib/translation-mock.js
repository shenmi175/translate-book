const PHRASE_MAP = new Map([
  ["Markdown Translator Studio", "Markdown Translator Studio"],
  ["Translate English Markdown into Chinese while keeping its structure intact.", "将英文 Markdown 翻译成中文，同时保持其结构完整。"],
  ["Core promises", "核心承诺"],
  ["Preserve headings, lists, blockquotes, tables, links, and emphasis.", "保留标题、列表、引用块、表格、链接和强调格式。"],
  ["Skip code blocks, inline code, URLs, file paths, and CLI commands.", "跳过代码块、行内代码、URL、文件路径和 CLI 命令。"],
  ["Review, annotate, and retranslate one block at a time.", "支持逐块审校、批注和重译。"],
  ["The safest translation is the one that keeps Markdown valid.", "最安全的翻译，是始终让 Markdown 保持有效的翻译。"],
  ["Block Type", "块类型"],
  ["Translate", "是否翻译"],
  ["Notes", "说明"],
  ["paragraph", "段落"],
  ["Yes", "是"],
  ["No", "否"],
  ["Keep emphasis and links", "保留强调与链接"],
  ["Return the source block verbatim", "原样返回源块"],
  ["Read [the API guide](https://example.com/api/guide) before export.", "导出前请阅读 [API 指南](https://example.com/api/guide)。"],
  ["Workspace preview", "工作台预览"]
]);

const WORD_MAP = new Map([
  ["translate", "翻译"],
  ["translation", "翻译"],
  ["translator", "翻译器"],
  ["studio", "工作台"],
  ["workspace", "工作台"],
  ["document", "文档"],
  ["documents", "文档"],
  ["markdown", "Markdown"],
  ["block", "块"],
  ["blocks", "块"],
  ["heading", "标题"],
  ["headings", "标题"],
  ["list", "列表"],
  ["lists", "列表"],
  ["table", "表格"],
  ["tables", "表格"],
  ["link", "链接"],
  ["links", "链接"],
  ["review", "审校"],
  ["annotate", "批注"],
  ["annotation", "批注"],
  ["export", "导出"],
  ["preview", "预览"],
  ["before", "在……之前"]
]);

const PROTECTED_TERMS = [
  "Markdown",
  "DeepSeek",
  "API",
  "CLI",
  "JSON",
  "FastAPI",
  "Node",
  "OpenAI",
  "ChatGPT",
  "DeepSeek API",
  "deepseek-chat"
];

function parseGlossary(glossaryText = "") {
  const glossaryMap = new Map();

  for (const line of glossaryText.split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?)\s*(?:=|->|=>|:)\s*(.+?)\s*$/);
    if (match) {
      glossaryMap.set(match[1], match[2]);
    }
  }

  return glossaryMap;
}

function protectMatches(text, pattern, stash, key) {
  return text.replace(pattern, (match) => {
    const token = `__${key}_${stash.length}__`;
    stash.push({ token, value: match });
    return token;
  });
}

function restoreProtected(text, stash) {
  let result = text;
  for (const item of stash) {
    result = result.replace(item.token, item.value);
  }
  return result;
}

function applyDictionary(text, glossaryMap) {
  let translated = text;

  const glossaryEntries = [...glossaryMap.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [source, target] of glossaryEntries) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    translated = translated.replace(new RegExp(escaped, "g"), target);
  }

  const phraseEntries = [...PHRASE_MAP.entries()].sort((left, right) => right[0].length - left[0].length);
  for (const [source, target] of phraseEntries) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    translated = translated.replace(new RegExp(escaped, "g"), target);
  }

  translated = translated.replace(/\b([A-Za-z][A-Za-z-]*)\b/g, (match) => {
    const lower = match.toLowerCase();
    return WORD_MAP.get(lower) || match;
  });

  return translated;
}

function translateInline(text, glossaryMap) {
  if (!/[A-Za-z]/.test(text)) {
    return text;
  }

  let result = text;
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, path) => `![${translateInline(alt, glossaryMap)}](${path})`);
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => `[${translateInline(label, glossaryMap)}](${url})`);

  const stash = [];
  result = protectMatches(result, /`[^`]+`/g, stash, "CODE");
  result = protectMatches(result, /\bhttps?:\/\/\S+\b/g, stash, "URL");
  result = protectMatches(result, /\b(?:[A-Za-z]:\\|\/)?[\w.-]+(?:[\\/][\w.-]+)+\b/g, stash, "PATH");

  for (const term of PROTECTED_TERMS) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = protectMatches(result, new RegExp(escaped, "g"), stash, "TERM");
  }

  result = applyDictionary(result, glossaryMap);
  result = result.replace(/\s+,/g, ",").replace(/\s+\./g, ".").replace(/\s+:/g, ":");
  return restoreProtected(result, stash);
}

function translateTable(blockText, glossaryMap) {
  return blockText
    .split("\n")
    .map((line, index) => {
      if (index === 1 && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line)) {
        return line;
      }

      const segments = line.split("|");
      return segments
        .map((segment, segmentIndex) => {
          if (segmentIndex === 0 || segmentIndex === segments.length - 1) {
            return segment;
          }

          const trimmed = segment.trim();
          const translated = translateInline(trimmed, glossaryMap);
          const leftPadding = segment.match(/^\s*/)?.[0] || "";
          const rightPadding = segment.match(/\s*$/)?.[0] || "";
          return `${leftPadding}${translated}${rightPadding}`;
        })
        .join("|");
    })
    .join("\n");
}

function translateLineByPrefix(blockText, prefixPattern, glossaryMap) {
  return blockText
    .split("\n")
    .map((line) => {
      const match = line.match(prefixPattern);
      if (!match) {
        return translateInline(line, glossaryMap);
      }
      return `${match[1]}${translateInline(match[2], glossaryMap)}`;
    })
    .join("\n");
}

function applyRetranslationFocus(text, goal, focus) {
  if (goal === "more_concise") {
    return text.replace(/逐块/g, "").replace(/\s+/g, " ").trim();
  }

  if (goal === "more_technical_doc") {
    return text.replace("工作台", "翻译工作台").replace("重新翻译", "重译");
  }

  if (goal === "more_terminology_consistent" || focus.includes("术语")) {
    return text.replace("重新翻译", "重译");
  }

  return text;
}

export function mockTranslateBlock(block, config, options = {}) {
  if (!block.shouldTranslate) {
    return block.sourceMarkdown;
  }

  const glossaryMap = parseGlossary(config.glossary);
  let translated = block.sourceMarkdown;

  switch (block.type) {
    case "heading":
      translated = translateLineByPrefix(block.sourceMarkdown, /^(\s{0,3}#{1,6}\s+)(.*)$/, glossaryMap);
      break;
    case "list_item":
      translated = translateLineByPrefix(block.sourceMarkdown, /^(\s*(?:[-*+]|\d+\.)\s+)(.*)$/, glossaryMap);
      break;
    case "blockquote":
      translated = translateLineByPrefix(block.sourceMarkdown, /^(\s*>\s?)(.*)$/, glossaryMap);
      break;
    case "table":
      translated = translateTable(block.sourceMarkdown, glossaryMap);
      break;
    default:
      translated = translateInline(block.sourceMarkdown, glossaryMap);
      break;
  }

  if (options.goal || options.focus) {
    translated = applyRetranslationFocus(translated, options.goal || "", options.focus || "");
  }

  return translated;
}
