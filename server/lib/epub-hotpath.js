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

function replaceAllLiteral(input, searchValue, replacement) {
  return String(input).split(searchValue).join(replacement);
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
  const previewText = translationUnit.previewTemplate
    ? applyTemplate(translationUnit.previewTemplate, segments, normalizedSegments, { forXml: false })
    : buildFallbackPreview(blockType, sourceMarkdown, normalizedSegments);

  return {
    normalizedFragment,
    previewText,
    structureSignature: translationUnit.structureSignature || "segment-template"
  };
}
