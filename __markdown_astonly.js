let astRuntime = null;
let astRuntimeError = null;

try {
  const [{ remark }, { unified }, { fromMarkdown }, { gfmFromMarkdown }, { gfm }, { toMarkdown }] = await Promise.all([
    import("remark"),
    import("unified"),
    import("mdast-util-from-markdown"),
    import("mdast-util-gfm"),
    import("micromark-extension-gfm"),
    import("mdast-util-to-markdown")
  ]);

  astRuntime = {
    remark,
    unified,
    fromMarkdown,
    gfmFromMarkdown,
    gfm,
    toMarkdown
  };
} catch (error) {
  astRuntimeError = error;
}

const PARSER_VERSION = "1.3.0";

export const PARSER_INFO = {
  engine: astRuntime ? "remark-mdast" : "heuristic-line-parser",
  version: PARSER_VERSION,
  astBacked: Boolean(astRuntime),
  roundTripStrategy: "source-slice-reassembly"
};

const PREFIX_BY_TYPE = {
  heading: "h",
  paragraph: "p",
  list_item: "li",
  blockquote: "bq",
  table: "tbl",
  image: "img",
  fenced_code: "code",
  thematic_break: "hr",
  html_block: "html",
  math_block: "math",
  frontmatter: "fm"
};

const TRANSLATABLE_TYPES = new Set(["heading", "paragraph", "list_item", "blockquote", "table", "image"]);
const PARAGRAPH_LIKE_TYPES = new Set(["heading", "paragraph", "list_item", "blockquote"]);

function isBlank(line) {
  return /^\s*$/.test(line);
}

function isThematicBreak(line) {
  return /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/.test(line);
}

function isFenceStart(line) {
  return /^\s*(```|~~~)/.test(line);
}

function isHeading(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function isListItem(line) {
  return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
}

function isBlockquote(line) {
  return /^\s*>\s?/.test(line);
}

function isImage(line) {
  return /^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line);
}

function isHtmlBlock(line) {
  return /^\s*</.test(line);
}

function isMathFence(line) {
  return /^\s*\$\$\s*$/.test(line);
}

function isTableAlignment(line) {
  return /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
}

function looksLikeTable(lines, index) {
  return index + 1 < lines.length && /\|/.test(lines[index]) && isTableAlignment(lines[index + 1]);
}

function nextId(type, counters) {
  const prefix = PREFIX_BY_TYPE[type] || "blk";
  const current = (counters[prefix] || 0) + 1;
  counters[prefix] = current;
  return `${prefix}-${String(current).padStart(3, "0")}`;
}

function tokenEstimate(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function skipReasonFor(type) {
  switch (type) {
    case "fenced_code":
      return "Code blocks are skipped by default.";
    case "thematic_break":
      return "Thematic breaks do not need translation.";
    case "math_block":
      return "Math blocks are skipped by default.";
    case "frontmatter":
      return "Frontmatter is kept as-is by default.";
    case "html_block":
      return "Raw HTML-like blocks are skipped conservatively.";
    default:
      return "";
  }
}

function buildLineOffsets(lines) {
  const offsets = [];
  let offset = 0;

  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  return offsets;
}

function offsetToLineIndex(lineOffsets, offset) {
  let lineIndex = 0;

  for (let index = 0; index < lineOffsets.length; index += 1) {
    if (lineOffsets[index] > offset) {
      break;
    }
    lineIndex = index;
  }

  return lineIndex;
}

function buildSourceRangeFromOffsets(lines, lineOffsets, startOffset, endOffset) {
  const safeEndOffset = Math.max(startOffset, endOffset);
  const startLineIndex = offsetToLineIndex(lineOffsets, startOffset);
  const endLineIndex = offsetToLineIndex(lineOffsets, safeEndOffset);

  return {
    startLine: startLineIndex + 1,
    endLine: endLineIndex + 1,
    startOffset,
    endOffset: safeEndOffset
  };
}

function createBlock(type, sourceMarkdown, counters, headingPath, order, separatorAfter, sourceRange) {
  const shouldTranslate = TRANSLATABLE_TYPES.has(type);

  return {
    id: nextId(type, counters),
    type,
    order,
    headingPath: [...headingPath],
    sourceMarkdown,
    translatedMarkdown: shouldTranslate ? "" : sourceMarkdown,
    status: shouldTranslate ? "idle" : "skipped",
    shouldTranslate,
    skipped: !shouldTranslate,
    skipReason: shouldTranslate ? "" : skipReasonFor(type),
    locked: false,
    annotations: [],
    comments: [],
    retryCount: 0,
    failureCount: 0,
    tokenEstimate: tokenEstimate(sourceMarkdown),
    separatorAfter,
    errorMessage: "",
    lastTranslatedAt: "",
    lastEditedAt: "",
    sourceRange
  };
}

function collectMultiline(lines, startIndex, predicate) {
  const collected = [lines[startIndex]];
  let index = startIndex + 1;

  while (index < lines.length && predicate(lines[index])) {
    collected.push(lines[index]);
    index += 1;
  }

  return { lines: collected, nextIndex: index };
}

function extractLeadingFrontmatter(normalized) {
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    return { frontmatter: null, remainder: normalized, offset: 0 };
  }

  let endIndex = 1;
  while (endIndex < lines.length && lines[endIndex] !== "---") {
    endIndex += 1;
  }

  if (endIndex >= lines.length) {
    return { frontmatter: null, remainder: normalized, offset: 0 };
  }

  const frontmatter = lines.slice(0, endIndex + 1).join("\n");
  const remainderLines = lines.slice(endIndex + 1);
  const remainder = remainderLines.join("\n");
  return {
    frontmatter,
    remainder,
    offset: frontmatter.length + 1
  };
}

function createParserWarning(code, message, severity = "warning") {
  return { code, message, severity };
}

function pushUniqueWarning(warnings, warning) {
  if (!warnings.some((item) => item.code === warning.code && item.message === warning.message)) {
    warnings.push(warning);
  }
}

function buildParserWarnings(normalized, options = {}) {
  const warnings = [];

  if (!options.astBacked) {
    if (astRuntimeError) {
      pushUniqueWarning(
        warnings,
        createParserWarning(
          "ast_parser_unavailable",
          "remark/mdast dependencies are not installed. Falling back to the heuristic parser."
        )
      );
    }

    if (/^\[\^[^\]]+\]:\s+/m.test(normalized) || /\[\^[^\]]+\]/.test(normalized)) {
      pushUniqueWarning(
        warnings,
        createParserWarning(
          "footnotes_detected",
          "Footnotes were detected. AST parsing is recommended for production use."
        )
      );
    }

    if (/^\[[^\]]+\]:\s+\S+/m.test(normalized)) {
      pushUniqueWarning(
        warnings,
        createParserWarning(
          "reference_links_detected",
          "Reference-style links were detected. AST parsing is recommended for exact block mapping."
        )
      );
    }

    if (/^[^\n]+\n(?:=+|-+)\s*$/m.test(normalized)) {
      pushUniqueWarning(
        warnings,
        createParserWarning(
          "setext_headings_detected",
          "Setext headings were detected. AST parsing is recommended for consistent heading mapping."
        )
      );
    }
  }

  if (/<!--[\s\S]*?-->/.test(normalized)) {
    pushUniqueWarning(warnings, createParserWarning("html_comments_detected", "HTML comments were detected and should be preserved carefully."));
  }

  if (/\n\$\$\s*\n/.test(`\n${normalized}\n`)) {
    pushUniqueWarning(warnings, createParserWarning("math_blocks_detected", "Math fences were detected and are handled by the heuristic fallback."));
  }

  if (options.fallbackReason) {
    pushUniqueWarning(warnings, createParserWarning(options.fallbackReason.code, options.fallbackReason.message));
  }

  if (options.parseError) {
    pushUniqueWarning(
      warnings,
      createParserWarning("ast_parse_failed", `AST parsing failed and the parser fell back to the heuristic mode: ${options.parseError}`)
    );
  }

  return warnings;
}

function buildStats(normalized, blocks) {
  return {
    characters: normalized.length,
    paragraphs: blocks.filter((block) => PARAGRAPH_LIKE_TYPES.has(block.type)).length,
    blocks: blocks.length,
    translatableBlocks: blocks.filter((block) => block.shouldTranslate).length,
    skippedBlocks: blocks.filter((block) => !block.shouldTranslate).length
  };
}

function heuristicParse(normalized, warnings = []) {
  const lines = normalized.split("\n");
  const lineOffsets = buildLineOffsets(lines);
  const blocks = [];
  const counters = {};
  const headingPath = [];
  let index = 0;
  let order = 0;

  if (lines[0] === "---") {
    let endIndex = 1;
    while (endIndex < lines.length && lines[endIndex] !== "---") {
      endIndex += 1;
    }

    if (endIndex < lines.length) {
      const sourceMarkdown = lines.slice(0, endIndex + 1).join("\n");
      index = endIndex + 1;

      let blankCount = 0;
      while (index < lines.length && isBlank(lines[index])) {
        blankCount += 1;
        index += 1;
      }

      blocks.push(
        createBlock(
          "frontmatter",
          sourceMarkdown,
          counters,
          headingPath,
          order++,
          index < lines.length ? "\n".repeat(blankCount + 1) : "",
          buildSourceRangeFromOffsets(lines, lineOffsets, 0, sourceMarkdown.length)
        )
      );
    }
  }

  while (index < lines.length) {
    while (index < lines.length && isBlank(lines[index])) {
      index += 1;
    }

    if (index >= lines.length) break;

    const startLine = index;
    const startOffset = lineOffsets[startLine] ?? 0;
    const line = lines[index];
    let type = "paragraph";
    let sourceMarkdown = line;
    let nextIndex = index + 1;

    if (isFenceStart(line)) {
      type = "fenced_code";
      const fenceMatch = line.match(/^\s*(```+|~~~+)/);
      const fence = fenceMatch ? fenceMatch[1] : "```";
      const collected = [line];
      nextIndex = index + 1;
      while (nextIndex < lines.length) {
        collected.push(lines[nextIndex]);
        if (lines[nextIndex].trim().startsWith(fence)) {
          nextIndex += 1;
          break;
        }
        nextIndex += 1;
      }
      sourceMarkdown = collected.join("\n");
    } else if (isMathFence(line)) {
      type = "math_block";
      const collected = [line];
      nextIndex = index + 1;
      while (nextIndex < lines.length) {
        collected.push(lines[nextIndex]);
        if (isMathFence(lines[nextIndex])) {
          nextIndex += 1;
          break;
        }
        nextIndex += 1;
      }
      sourceMarkdown = collected.join("\n");
    } else if (isHeading(line)) {
      type = "heading";
      const match = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      if (match) {
        const level = match[1].length;
        headingPath.splice(level - 1);
        headingPath[level - 1] = match[2].trim();
      }
    } else if (looksLikeTable(lines, index)) {
      type = "table";
      const collected = [line, lines[index + 1]];
      nextIndex = index + 2;
      while (nextIndex < lines.length && /\|/.test(lines[nextIndex]) && !isBlank(lines[nextIndex])) {
        collected.push(lines[nextIndex]);
        nextIndex += 1;
      }
      sourceMarkdown = collected.join("\n");
    } else if (isBlockquote(line)) {
      type = "blockquote";
      const collected = collectMultiline(lines, index, (candidate) => isBlockquote(candidate) && !isBlank(candidate));
      sourceMarkdown = collected.lines.join("\n");
      nextIndex = collected.nextIndex;
    } else if (isListItem(line)) {
      type = "list_item";
      const collected = [line];
      nextIndex = index + 1;
      while (
        nextIndex < lines.length &&
        !isBlank(lines[nextIndex]) &&
        !isHeading(lines[nextIndex]) &&
        !isListItem(lines[nextIndex]) &&
        !isFenceStart(lines[nextIndex]) &&
        !looksLikeTable(lines, nextIndex) &&
        !isBlockquote(lines[nextIndex]) &&
        !isThematicBreak(lines[nextIndex]) &&
        !isImage(lines[nextIndex])
      ) {
        collected.push(lines[nextIndex]);
        nextIndex += 1;
      }
      sourceMarkdown = collected.join("\n");
    } else if (isImage(line)) {
      type = "image";
    } else if (isThematicBreak(line)) {
      type = "thematic_break";
    } else if (isHtmlBlock(line)) {
      type = "html_block";
      const collected = collectMultiline(lines, index, (candidate) => !isBlank(candidate) && !isHeading(candidate));
      sourceMarkdown = collected.lines.join("\n");
      nextIndex = collected.nextIndex;
    } else {
      const collected = [line];
      nextIndex = index + 1;
      while (
        nextIndex < lines.length &&
        !isBlank(lines[nextIndex]) &&
        !isHeading(lines[nextIndex]) &&
        !isListItem(lines[nextIndex]) &&
        !isFenceStart(lines[nextIndex]) &&
        !looksLikeTable(lines, nextIndex) &&
        !isBlockquote(lines[nextIndex]) &&
        !isThematicBreak(lines[nextIndex]) &&
        !isImage(lines[nextIndex])
      ) {
        collected.push(lines[nextIndex]);
        nextIndex += 1;
      }
      sourceMarkdown = collected.join("\n");
    }

    index = nextIndex;

    let blankCount = 0;
    while (index < lines.length && isBlank(lines[index])) {
      blankCount += 1;
      index += 1;
    }

    const separatorAfter = index < lines.length ? "\n".repeat(blankCount + 1) : "";
    const endOffset = startOffset + sourceMarkdown.length;

    blocks.push(
      createBlock(
        type,
        sourceMarkdown,
        counters,
        headingPath,
        order++,
        separatorAfter,
        buildSourceRangeFromOffsets(lines, lineOffsets, startOffset, endOffset)
      )
    );
  }

  return {
    blocks,
    stats: buildStats(normalized, blocks),
    parser: {
      engine: "heuristic-line-parser",
      version: PARSER_VERSION,
      astBacked: false,
      roundTripStrategy: "source-slice-reassembly",
      warnings
    }
  };
}

function nodeStartOffset(node) {
  return node?.position?.start?.offset;
}

function nodeEndOffset(node) {
  return node?.position?.end?.offset;
}

function nodeToText(node) {
  if (!node || typeof node !== "object") {
    return "";
  }

  if (typeof node.value === "string") {
    return node.value;
  }

  if (node.type === "image") {
    return node.alt || "";
  }

  if (!Array.isArray(node.children)) {
    return "";
  }

  return node.children.map((child) => nodeToText(child)).join("");
}

function createAstEntry(type, node, startOffset, endOffset) {
  return {
    type,
    node,
    startOffset,
    endOffset
  };
}

function astNodeType(node, sourceMarkdown) {
  switch (node.type) {
    case "heading":
      return "heading";
    case "paragraph":
      if (node.children?.length === 1 && node.children[0].type === "image" && sourceMarkdown.trim().startsWith("![")) {
        return "image";
      }
      return "paragraph";
    case "blockquote":
      return "blockquote";
    case "table":
      return "table";
    case "code":
      return "fenced_code";
    case "thematicBreak":
      return "thematic_break";
    case "html":
      return "html_block";
    case "listItem":
      return "list_item";
    case "definition":
      return "html_block";
    case "footnoteDefinition":
      return "paragraph";
    default:
      return "paragraph";
  }
}

function buildAstEntries(tree, normalized, offsetBase) {
  const entries = [];

  for (const node of tree.children || []) {
    if (node.type === "list") {
      for (const item of node.children || []) {
        const startOffset = offsetBase + (nodeStartOffset(item) ?? 0);
        const endOffset = offsetBase + (nodeEndOffset(item) ?? startOffset);
        const sourceMarkdown = normalized.slice(startOffset, endOffset);
        entries.push(createAstEntry(astNodeType(item, sourceMarkdown), item, startOffset, endOffset));
      }
      continue;
    }

    const startOffset = offsetBase + (nodeStartOffset(node) ?? 0);
    const endOffset = offsetBase + (nodeEndOffset(node) ?? startOffset);
    const sourceMarkdown = normalized.slice(startOffset, endOffset);
    entries.push(createAstEntry(astNodeType(node, sourceMarkdown), node, startOffset, endOffset));
  }

  return entries.sort((left, right) => left.startOffset - right.startOffset);
}

function headingLabelFromNode(node) {
  return nodeToText(node).trim();
}

function astParse(normalized) {
  const { frontmatter, remainder, offset } = extractLeadingFrontmatter(normalized);
  const lines = normalized.split("\n");
  const lineOffsets = buildLineOffsets(lines);
  const tree = astRuntime.fromMarkdown(remainder, {
    extensions: [astRuntime.gfm()],
    mdastExtensions: [astRuntime.gfmFromMarkdown()]
  });

  const entries = buildAstEntries(tree, normalized, offset);
  const counters = {};
  const headingPath = [];
  const blocks = [];
  let order = 0;

  if (frontmatter) {
    const frontmatterStart = 0;
    const frontmatterEnd = frontmatter.length;
    const nextEntryStart = entries[0]?.startOffset ?? normalized.length;
    blocks.push(
      createBlock(
        "frontmatter",
        frontmatter,
        counters,
        headingPath,
        order++,
        normalized.slice(frontmatterEnd, nextEntryStart),
        buildSourceRangeFromOffsets(lines, lineOffsets, frontmatterStart, frontmatterEnd)
      )
    );
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const sourceMarkdown =
      entry.startOffset < entry.endOffset
        ? normalized.slice(entry.startOffset, entry.endOffset)
        : astRuntime.toMarkdown(entry.node).trimEnd();

    if (entry.type === "heading") {
      const level = Math.max(1, Math.min(6, entry.node.depth || 1));
      headingPath.splice(level - 1);
      headingPath[level - 1] = headingLabelFromNode(entry.node);
    }

    const nextStartOffset = entries[index + 1]?.startOffset ?? normalized.length;
    const separatorAfter = normalized.slice(entry.endOffset, nextStartOffset);

    blocks.push(
      createBlock(
        entry.type,
        sourceMarkdown,
        counters,
        headingPath,
        order++,
        separatorAfter,
        buildSourceRangeFromOffsets(lines, lineOffsets, entry.startOffset, entry.endOffset)
      )
    );
  }

  return {
    blocks,
    stats: buildStats(normalized, blocks),
    parser: {
      engine: "remark-mdast",
      version: PARSER_VERSION,
      astBacked: true,
      roundTripStrategy: "source-slice-reassembly",
      warnings: buildParserWarnings(normalized, { astBacked: true })
    }
  };
}

function astFallbackReason(normalized) {
  if (!astRuntime) {
    return createParserWarning("ast_parser_unavailable", "remark/mdast dependencies are not installed. Falling back to the heuristic parser.");
  }

  if (/\n\$\$\s*\n/.test(`\n${normalized}\n`)) {
    return createParserWarning("math_blocks_fallback", "Math fences are present. Falling back to the heuristic parser until remark-math is added.");
  }

  return null;
}

export function parseMarkdownDocument(markdown) {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const fallbackReason = astFallbackReason(normalized);

  if (!fallbackReason) {
    try {
      return astParse(normalized);
    } catch (error) {
      return heuristicParse(
        normalized,
        buildParserWarnings(normalized, {
          astBacked: false,
          parseError: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  return heuristicParse(
    normalized,
    buildParserWarnings(normalized, {
      astBacked: false,
      fallbackReason
    })
  );
}

export function mergeMarkdown(blocks) {
  return blocks
    .map((block) => {
      const text = block.shouldTranslate ? block.translatedMarkdown || block.sourceMarkdown : block.sourceMarkdown;
      return `${text}${block.separatorAfter || ""}`;
    })
    .join("");
}
