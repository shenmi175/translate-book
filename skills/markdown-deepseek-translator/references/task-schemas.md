# Task Schemas

## Document-Level Input

Recommended shape:

```json
{
  "source_markdown": "...",
  "source_language": "English",
  "target_language": "Chinese",
  "glossary": [
    { "source": "Markdown", "target": "Markdown", "locked": true },
    { "source": "frontmatter", "target": "frontmatter", "locked": true },
    { "source": "API", "target": "API", "locked": true },
    { "source": "endpoint", "target": "端点" },
    { "source": "workflow", "target": "工作流" },
    { "source": "cache", "target": "缓存" }
  ],
  "document_type": "technical_doc",
  "style": "accurate-professional",
  "model_preference": "deepseek-chat",
  "skip_code_blocks": true,
  "skip_inline_code": true
}
```

Field notes:
- `glossary` should be normalized to an array of `{source, target, locked?, notes?}` records.
- `locked=true` means preserve the mapping exactly.
- `document_type` should usually be one of `technical_doc`, `blog`, `tutorial`, or `readme`.

## Block-Level Input

Recommended shape:

```json
{
  "block_id": "p-002",
  "block_type": "paragraph",
  "source_text": "The cache stores compiled templates.",
  "previous_translation": "",
  "glossary": [
    { "source": "cache", "target": "缓存" }
  ],
  "style": "accurate-professional",
  "retry_reason": ""
}
```

## Retranslation Input

Recommended shape:

```json
{
  "block_id": "p-002",
  "block_type": "paragraph",
  "source_text": "The cache stores compiled templates.",
  "current_translation": "缓存会保存编译后的模板。",
  "retranslation_goal": "more_technical_doc",
  "glossary": [
    { "source": "cache", "target": "缓存" }
  ],
  "stricter_prompt": false,
  "freer_prompt": false,
  "keep_terms": ["cache"],
  "notes": "Keep the sentence concise."
}
```

## Structured Output Schema

Emit one task unit per block.

```json
{
  "block_id": "p-002",
  "block_type": "paragraph",
  "should_translate": true,
  "skip_reason": "",
  "source_text": "The cache stores compiled templates.",
  "translation_prompt": "Rendered DeepSeek user prompt",
  "translated_text": "缓存存储已编译的模板。",
  "terminology_notes": [
    "cache -> 缓存"
  ],
  "formatting_warnings": [],
  "retry_suggestion": "none"
}
```

Field meanings:
- `should_translate`: `true` for translatable prose or mixed blocks that need partial translation.
- `skip_reason`: empty when translating; otherwise describe why the block must remain unchanged.
- `translation_prompt`: populated before the model call.
- `translated_text`: populated after the model call or left empty during planning.
- `terminology_notes`: record glossary hits, misses, or conflicts.
- `formatting_warnings`: record any structure risk, ambiguity, or validation issue.
- `retry_suggestion`: one of `none`, `use_stricter_prompt`, `split_block`, `use_conservative_prompt`, `check_glossary`, or `preserve_source`.

## Block Decision Matrix

- `frontmatter`: partial translation only; translate clearly human-facing string values and keep machine fields unchanged.
- `heading`: translate if the visible text is natural language.
- `paragraph`: translate unless it is obviously a command snippet, path list, or identifier-only content.
- `list_item`: translate natural-language text; preserve commands, paths, and inline code segments.
- `blockquote`: translate natural-language text and preserve the `>` markers.
- `table`: translate only natural-language cells; preserve pipes, alignment row, and non-linguistic tokens.
- `image`: translate descriptive alt text or caption text; preserve resource paths.
- `fenced_code`: do not translate.
- `html_block`: usually skip unless the tags can be preserved exactly and the inner text is isolated natural language.
- `math_block`: do not translate.
- `thematic_break`: do not translate.

## Suggested Block ID Scheme

Use short prefixes with zero-padded counters:

- `fm-001`: frontmatter
- `h-001`: heading
- `p-001`: paragraph
- `li-001`: list item
- `bq-001`: blockquote
- `tbl-001`: table
- `img-001`: image
- `code-001`: fenced code
- `html-001`: HTML block
- `math-001`: math block
- `hr-001`: thematic break

Keep IDs stable across retries and retranslation.

## Warning Heuristics

Add a formatting warning when:
- a translated table row has a different column count than the source row
- a link destination changed
- a code fence marker changed
- inline code backticks changed
- heading markers changed
- list indentation changed
- frontmatter scalar types changed
- a supposedly untranslated token was localized

Add a terminology warning when:
- the glossary contains duplicate source terms with different targets
- a locked term was translated differently
- a retranslation request conflicts with `keep_terms`

## Retry Strategy

Use this decision order:

1. `use_stricter_prompt` when structure is wrong but the block size is reasonable.
2. `split_block` when the block is long or semantically mixed.
3. `use_conservative_prompt` when the content is highly technical or the model translates protected tokens.
4. `check_glossary` when terminology drift is the main defect.
5. `preserve_source` when retries still break Markdown safety.

## Merge Rules

After all blocks are translated:

- reassemble blocks in original order
- preserve original blank-line spacing where possible
- do not normalize punctuation across unrelated blocks
- do not rewrite untouched blocks
- keep skipped blocks byte-stable whenever practical
