const LANGUAGE_ALIASES = [
  { pattern: /^(zh|zh-cn|zh-hans|chinese|simplified chinese|中文|简体中文|汉语|普通话)$/i, suffix: "zh-CN", tag: "zh-CN" },
  { pattern: /^(en|en-us|en-gb|english|英文|英语)$/i, suffix: "en", tag: "en" },
  { pattern: /^(ja|ja-jp|japanese|日文|日语|日本語)$/i, suffix: "ja", tag: "ja" },
  { pattern: /^(ko|ko-kr|korean|韩文|韩语|한국어)$/i, suffix: "ko", tag: "ko" },
  { pattern: /^(de|de-de|german|德文|德语)$/i, suffix: "de", tag: "de" },
  { pattern: /^(fr|fr-fr|french|法文|法语)$/i, suffix: "fr", tag: "fr" },
  { pattern: /^(es|es-es|spanish|西班牙文|西班牙语)$/i, suffix: "es", tag: "es" },
  { pattern: /^(ru|ru-ru|russian|俄文|俄语)$/i, suffix: "ru", tag: "ru" }
];

function normalizeTagCase(tag = "") {
  return String(tag || "")
    .replace(/_/g, "-")
    .split("-")
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) {
        return part.toLowerCase();
      }
      return part.length <= 3 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
    })
    .join("-");
}

function normalizeAsciiSlug(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveExportLanguage(targetLanguage = "") {
  const raw = String(targetLanguage || "").trim();
  if (!raw) {
    return {
      source: "",
      suffix: "translation",
      tag: "und",
      label: "translation"
    };
  }

  const alias = LANGUAGE_ALIASES.find((entry) => entry.pattern.test(raw));
  if (alias) {
    return {
      source: raw,
      suffix: alias.suffix,
      tag: alias.tag,
      label: raw
    };
  }

  const normalizedTag = normalizeTagCase(raw);
  if (/^[a-z]{2,3}(?:-[A-Z0-9][A-Za-z0-9]{1,7})*$/u.test(normalizedTag)) {
    return {
      source: raw,
      suffix: normalizedTag,
      tag: normalizedTag,
      label: raw
    };
  }

  const slug = normalizeAsciiSlug(raw) || "translation";
  return {
    source: raw,
    suffix: slug,
    tag: "und",
    label: raw
  };
}
