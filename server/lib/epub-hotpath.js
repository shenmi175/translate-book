function escapeXmlText(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value = "") {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSegmentToken(index) {
  return `__MTS_SEG_${String(index).padStart(4, "0")}__`;
}

function buildPlaceholderToken(kind, index) {
  return `[[MTS_${kind}_${String(index).padStart(4, "0")}]]`;
}

function replaceAllLiteral(input, searchValue, replacement) {
  return String(input).split(searchValue).join(replacement);
}

function cleanModelTextOutput(rawTranslation = "") {
  return String(rawTranslation || "")
    .trim()
    .replace(/^```(?:text|txt)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function stripInternalPlaceholderTokens(value = "") {
  return String(value || "").replace(/\[\[MTS_(?:OPEN|CLOSE|KEEP)_\d{4}\]\]/g, "");
}

function sanitizeTranslatedSegments(translatedSegments) {
  if (!Array.isArray(translatedSegments) || !translatedSegments.length) {
    throw new Error("Translated EPUB segment list is empty.");
  }

  return translatedSegments.map((segment) => String(segment ?? "").trim());
}

function applyTemplate(template, segments, translatedSegments, options = {}) {
  let output = String(template || "");
  const forXml = options.forXml === true;

  for (let index = 0; index < segments.length; index += 1) {
    const descriptor = segments[index] || {};
    const token = descriptor.token || buildSegmentToken(index + 1);
    const translatedValue = translatedSegments[index] || "";
    const replacement = forXml
      ? (descriptor.kind === "attribute" ? escapeXmlAttribute(translatedValue) : escapeXmlText(translatedValue))
      : translatedValue;
    output = replaceAllLiteral(output, token, replacement);
  }

  return output;
}

function buildFallbackPreview(blockType, sourceMarkdown, translatedSegments) {
  const joined = translatedSegments.join(blockType === "table" ? " | " : " ").trim();
  if (!joined) {
    return "";
  }

  if (blockType === "heading") {
    const prefix = String(sourceMarkdown || "").match(/^(#+)\s*/)?.[1] || "#";
    return `${prefix} ${joined}`.trim();
  }
  if (blockType === "list_item") {
    return `- ${joined}`.trim();
  }
  if (blockType === "blockquote") {
    return `> ${joined}`.trim();
  }
  return joined;
}

function decodeBasicXmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function normalizePreviewWhitespace(value = "") {
  return String(value || "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function prefixBlockquotePreview(value = "") {
  return String(value || "")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
    .trim();
}

export function buildEpubPreviewFromNormalizedFragment(blockType, normalizedFragment) {
  let text = String(normalizedFragment || "")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|blockquote|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = normalizePreviewWhitespace(decodeBasicXmlEntities(text));
  if (blockType === "blockquote") {
    return prefixBlockquotePreview(text);
  }
  if (blockType === "list_item") {
    return `- ${text}`.trim();
  }
  return text;
}

function segmentParentPath(path = "") {
  return String(path || "").replace(/\/#text\[\d+\]$/, "");
}

function longestCommonPath(paths = []) {
  if (!paths.length) {
    return "";
  }

  const splitPaths = paths.map((item) => String(item || "").split("/").filter(Boolean));
  const common = [];
  const first = splitPaths[0] || [];

  for (let index = 0; index < first.length; index += 1) {
    const value = first[index];
    if (splitPaths.every((parts) => parts[index] === value)) {
      common.push(value);
    } else {
      break;
    }
  }

  return common.length ? `/${common.join("/")}` : "";
}

function isProtectedInlineSegment(segment = {}) {
  const sourceText = String(segment.sourceText || "").trim();
  const path = String(segment.path || "");
  return (
    /^(\d+|[ivxlcdm]+)$/i.test(sourceText) &&
    /\/(a|sup)\[\d+\]/i.test(path)
  );
}

function normalizeSourceText(value = "") {
  return String(value || "").trim();
}

function appendWithSpacing(parts, nextValue) {
  const value = String(nextValue || "");
  if (!value) {
    return;
  }
  const previous = parts[parts.length - 1] || "";
  if (
    previous &&
    !/\s$/.test(previous) &&
    !/^[,.;:!?，。；：！？、）】》”’]/.test(value) &&
    !/\[\[MTS_OPEN_\d{4}\]\]$/.test(previous)
  ) {
    parts.push(" ");
  }
  parts.push(value);
}

function createInlinePlaceholderPart(segment, commonParentPath) {
  const index = Number(segment?.index || 0);
  const parentPath = segmentParentPath(segment?.path);
  const directText = parentPath === commonParentPath;
  const protectedInline = isProtectedInlineSegment(segment);
  const inline = !directText && !protectedInline;

  if (protectedInline) {
    return {
      type: "keep",
      index,
      sourceText: normalizeSourceText(segment.sourceText),
      keepToken: buildPlaceholderToken("KEEP", index)
    };
  }

  if (inline) {
    return {
      type: "inline",
      index,
      sourceText: normalizeSourceText(segment.sourceText),
      openToken: buildPlaceholderToken("OPEN", index),
      closeToken: buildPlaceholderToken("CLOSE", index)
    };
  }

  return {
    type: "plain",
    index,
    sourceText: normalizeSourceText(segment.sourceText)
  };
}

export function buildEpubPlaceholderPlan(translationUnit, options = {}) {
  if (!translationUnit || typeof translationUnit !== "object") {
    return null;
  }

  const segments = Array.isArray(translationUnit.segments) ? translationUnit.segments : [];
  if (!translationUnit.segmentTemplate || segments.length < 2) {
    return null;
  }

  const commonParentPath = longestCommonPath(segments.map((segment) => segmentParentPath(segment.path)));
  if (!commonParentPath) {
    return null;
  }

  const parts = segments.map((segment) => createInlinePlaceholderPart(segment, commonParentPath));
  const markerParts = parts.filter((part) => part.type === "inline" || part.type === "keep");
  const minimumMarkers = Number.isInteger(options.minimumMarkers) ? options.minimumMarkers : 1;
  if (markerParts.length < minimumMarkers) {
    return null;
  }

  const sourceParts = [];
  for (const part of parts) {
    if (part.type === "keep") {
      appendWithSpacing(sourceParts, part.keepToken);
    } else if (part.type === "inline") {
      appendWithSpacing(sourceParts, `${part.openToken}${part.sourceText}${part.closeToken}`);
    } else {
      appendWithSpacing(sourceParts, part.sourceText);
    }
  }

  return {
    mode: "inline-placeholder",
    commonParentPath,
    sourceText: sourceParts.join("").replace(/\s+/g, " ").trim(),
    placeholderTokens: markerParts.flatMap((part) => (
      part.type === "keep" ? [part.keepToken] : [part.openToken, part.closeToken]
    )),
    parts
  };
}

function tokenizePlaceholderTranslation(rawTranslation = "") {
  const markerPattern = /\[\[MTS_(OPEN|CLOSE|KEEP)_(\d{4})\]\]/g;
  const tokens = [];
  const textChunks = [];
  let cursor = 0;
  let match;

  while ((match = markerPattern.exec(String(rawTranslation || "")))) {
    textChunks.push(String(rawTranslation || "").slice(cursor, match.index));
    tokens.push({
      token: match[0],
      kind: match[1],
      index: Number(match[2])
    });
    cursor = markerPattern.lastIndex;
  }

  textChunks.push(String(rawTranslation || "").slice(cursor));
  return { tokens, textChunks };
}

function appendTranslation(translations, segmentIndex, value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || !Number.isInteger(segmentIndex) || segmentIndex <= 0) {
    return;
  }

  const current = translations[segmentIndex - 1] || "";
  translations[segmentIndex - 1] = current ? `${current}${text}` : text;
}

function findPlainPartsBetween(parts, leftIndex, rightIndex) {
  return parts.filter((part) =>
    part.type === "plain" &&
    part.index > leftIndex &&
    part.index < rightIndex
  );
}

function appendUnanchoredText(translations, parts, leftIndex, rightIndex, value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return;
  }

  const plainParts = findPlainPartsBetween(parts, leftIndex, rightIndex);
  if (plainParts.length === 1) {
    appendTranslation(translations, plainParts[0].index, text);
    return;
  }

  if (plainParts.length > 1) {
    appendTranslation(translations, plainParts[0].index, text);
    for (const part of plainParts.slice(1)) {
      appendTranslation(translations, part.index, part.sourceText);
    }
    return;
  }

  const previousTranslatable = [...parts]
    .reverse()
    .find((part) => part.index <= leftIndex && part.type !== "keep");
  if (previousTranslatable) {
    appendTranslation(translations, previousTranslatable.index, text);
  }
}

function assignBestEffortPlaceholderText(translations, parts, leftIndex, rightIndex, value) {
  const text = stripInternalPlaceholderTokens(value).replace(/\s+/g, " ").trim();
  if (!text) {
    return;
  }

  const partsBetween = parts.filter((part) =>
    part.type !== "keep" &&
    part.index > leftIndex &&
    part.index < rightIndex
  );
  const targetPart = partsBetween.find((part) => part.type === "plain") ||
    partsBetween[0] ||
    parts.find((part) => part.type !== "keep" && part.index > leftIndex) ||
    [...parts].reverse().find((part) => part.type !== "keep" && part.index < rightIndex);

  if (targetPart) {
    appendTranslation(translations, targetPart.index, text);
  }
}

function expectedPlaceholderTokens(parts) {
  return parts.flatMap((part) => {
    if (part.type === "keep") {
      return [{ token: part.keepToken, kind: "KEEP", index: part.index }];
    }
    if (part.type === "inline") {
      return [
        { token: part.openToken, kind: "OPEN", index: part.index },
        { token: part.closeToken, kind: "CLOSE", index: part.index }
      ];
    }
    return [];
  });
}

export function parseEpubPlaceholderTranslation(rawTranslation, plan, providerLabel = "Provider") {
  if (!plan?.parts?.length) {
    throw new Error("EPUB placeholder plan is missing.");
  }

  const cleaned = cleanModelTextOutput(rawTranslation);

  if (!cleaned) {
    throw new Error(`${providerLabel} returned empty EPUB placeholder translation.`);
  }

  const expectedTokens = expectedPlaceholderTokens(plan.parts);
  const { tokens, textChunks } = tokenizePlaceholderTranslation(cleaned);

  if (tokens.length !== expectedTokens.length) {
    throw new Error(`${providerLabel} returned ${tokens.length} EPUB placeholders, expected ${expectedTokens.length}.`);
  }

  for (let index = 0; index < expectedTokens.length; index += 1) {
    if (tokens[index].token !== expectedTokens[index].token) {
      throw new Error(`${providerLabel} returned EPUB placeholders out of order near ${tokens[index]?.token || "end"}; expected ${expectedTokens[index].token}.`);
    }
  }

  const translations = Array(plan.parts.length).fill("");
  for (const part of plan.parts) {
    if (part.type === "keep") {
      translations[part.index - 1] = part.sourceText;
    }
  }

  let previousBoundaryIndex = 0;
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const nextToken = tokens[tokenIndex + 1] || null;
    const beforeText = textChunks[tokenIndex] || "";

    if (token.kind === "OPEN") {
      appendUnanchoredText(translations, plan.parts, previousBoundaryIndex, token.index, beforeText);
      if (!nextToken || nextToken.kind !== "CLOSE" || nextToken.index !== token.index) {
        throw new Error(`${providerLabel} returned malformed EPUB inline placeholder ${token.token}.`);
      }
      appendTranslation(translations, token.index, textChunks[tokenIndex + 1] || "");
      previousBoundaryIndex = token.index;
      tokenIndex += 1;
      continue;
    }

    if (token.kind === "KEEP") {
      appendUnanchoredText(translations, plan.parts, previousBoundaryIndex, token.index, beforeText);
      previousBoundaryIndex = token.index;
      continue;
    }
  }

  appendUnanchoredText(translations, plan.parts, previousBoundaryIndex, Number.POSITIVE_INFINITY, textChunks[textChunks.length - 1] || "");

  return plan.parts.map((part) => {
    const translated = translations[part.index - 1];
    return typeof translated === "string" && translated.trim() ? translated.trim() : part.sourceText;
  });
}

export function parseEpubPlaceholderBestEffortTranslation(rawTranslation, plan, providerLabel = "Provider") {
  if (!plan?.parts?.length) {
    throw new Error("EPUB placeholder plan is missing.");
  }

  const cleaned = cleanModelTextOutput(rawTranslation);
  if (!cleaned) {
    throw new Error(`${providerLabel} returned empty EPUB placeholder translation.`);
  }

  const translations = Array(plan.parts.length).fill("");
  const keepPartsByIndex = new Map();
  for (const part of plan.parts) {
    if (part.type === "keep") {
      translations[part.index - 1] = part.sourceText;
      keepPartsByIndex.set(part.index, part);
    }
  }

  const keepPattern = /\[\[MTS_KEEP_(\d{4})\]\]/g;
  let cursor = 0;
  let leftIndex = 0;
  let sawKeepToken = false;
  let match;

  while ((match = keepPattern.exec(cleaned))) {
    sawKeepToken = true;
    const keepIndex = Number(match[1]);
    assignBestEffortPlaceholderText(translations, plan.parts, leftIndex, keepIndex, cleaned.slice(cursor, match.index));
    if (keepPartsByIndex.has(keepIndex)) {
      translations[keepIndex - 1] = keepPartsByIndex.get(keepIndex).sourceText;
    }
    leftIndex = keepIndex;
    cursor = keepPattern.lastIndex;
  }

  assignBestEffortPlaceholderText(translations, plan.parts, leftIndex, Number.POSITIVE_INFINITY, cleaned.slice(cursor));

  if (!sawKeepToken && !translations.some((value, index) => plan.parts[index]?.type !== "keep" && String(value || "").trim())) {
    assignBestEffortPlaceholderText(translations, plan.parts, 0, Number.POSITIVE_INFINITY, cleaned);
  }

  return plan.parts.map((part) => {
    if (part.type === "keep") {
      return part.sourceText;
    }
    const translated = translations[part.index - 1];
    return typeof translated === "string" ? translated.trim() : "";
  });
}

export function applyEpubTranslationUnit({ blockType, sourceMarkdown, translationUnit, translatedSegments }) {
  if (!translationUnit || typeof translationUnit !== "object") {
    throw new Error("EPUB translation metadata is missing.");
  }

  const segments = Array.isArray(translationUnit.segments) ? translationUnit.segments : [];
  const normalizedSegments = sanitizeTranslatedSegments(translatedSegments);

  if (segments.length !== normalizedSegments.length) {
    throw new Error(`Translated EPUB segment count mismatch: expected ${segments.length}, received ${normalizedSegments.length}.`);
  }

  if (!translationUnit.segmentTemplate) {
    throw new Error("EPUB block is missing segment template metadata.");
  }

  const normalizedFragment = applyTemplate(translationUnit.segmentTemplate, segments, normalizedSegments, { forXml: true });
  const previewText = /<br\b/i.test(String(translationUnit.segmentTemplate || ""))
    ? buildEpubPreviewFromNormalizedFragment(blockType, normalizedFragment)
    : translationUnit.previewTemplate
    ? applyTemplate(translationUnit.previewTemplate, segments, normalizedSegments, { forXml: false })
    : buildFallbackPreview(blockType, sourceMarkdown, normalizedSegments);

  return {
    normalizedFragment,
    previewText,
    structureSignature: translationUnit.structureSignature || "segment-template"
  };
}

export function applyEpubPlaceholderBestEffortTranslation({ blockType, sourceMarkdown, translationUnit, rawTranslation, providerLabel }) {
  const plan = buildEpubPlaceholderPlan(translationUnit);
  if (!plan) {
    throw new Error("EPUB block is not eligible for placeholder translation.");
  }

  const translatedSegments = parseEpubPlaceholderBestEffortTranslation(rawTranslation, plan, providerLabel);
  const applied = applyEpubTranslationUnit({
    blockType,
    sourceMarkdown,
    translationUnit,
    translatedSegments
  });

  return {
    ...applied,
    placeholderPlan: plan,
    structureSignature: "inline-placeholder-best-effort"
  };
}

export function applyEpubPlaceholderTranslation({ blockType, sourceMarkdown, translationUnit, rawTranslation, providerLabel }) {
  const plan = buildEpubPlaceholderPlan(translationUnit);
  if (!plan) {
    throw new Error("EPUB block is not eligible for placeholder translation.");
  }

  const translatedSegments = parseEpubPlaceholderTranslation(rawTranslation, plan, providerLabel);
  const applied = applyEpubTranslationUnit({
    blockType,
    sourceMarkdown,
    translationUnit,
    translatedSegments
  });

  return {
    ...applied,
    placeholderPlan: plan,
    structureSignature: translationUnit.structureSignature || "inline-placeholder"
  };
}
