---
name: markdown-deepseek-translator
description: Block-level Markdown translation and retranslation workflow for turning English Markdown into Chinese while preserving Markdown syntax, generating DeepSeek-ready prompts, enforcing glossary and style consistency, and retrying unsafe blocks conservatively. Use when Codex needs to translate or retranslate README files, blogs, tutorials, or technical Markdown documents without breaking code, links, tables, frontmatter, or formatting.
---

# Markdown DeepSeek Translator

## Overview

Use this skill to translate Markdown as a sequence of retry-safe blocks instead of one large prompt. Preserve Markdown structure, skip protected syntax, generate DeepSeek-ready prompts, and support block-level retranslation with glossary and style control.

## Workflow

### 1. Collect inputs

Accept either a document-level job or a single block job.

Required document inputs:
- `source_markdown`
- `source_language`
- `target_language`
- `document_type`
- `glossary`
- `style`
- `model_preference`
- `skip_code_blocks`
- `skip_inline_code`

Required block inputs:
- `block_id`
- `block_type`
- `source_text`

Optional block inputs:
- `previous_translation`
- `glossary`
- `style`
- `retry_reason`

Required retranslation inputs:
- `block_id`
- `source_text`
- `current_translation`
- `retranslation_goal`

Optional retranslation inputs:
- `stricter_prompt`
- `freer_prompt`
- `keep_terms`
- `notes`

Default assumptions:
- translate `English -> Chinese` unless the caller overrides it
- set `skip_code_blocks=true` and `skip_inline_code=true` unless the caller explicitly asks otherwise
- treat `README`, tutorial, blog, and technical doc content as structure-sensitive

### 2. Segment the Markdown into retry-safe blocks

Prefer blocks that are semantically complete and can be retried independently. Use stable IDs such as `h-001`, `p-002`, `li-003`, `tbl-004`, and `code-005`.

Recommended block types:
- `frontmatter`
- `heading`
- `paragraph`
- `list_item`
- `blockquote`
- `table`
- `image`
- `fenced_code`
- `html_block`
- `math_block`
- `thematic_break`

Prefer one block per:
- heading line
- paragraph
- list item
- blockquote paragraph
- table
- image line
- fenced code block

Split again when a block:
- exceeds about 1200 English words
- mixes unrelated subtopics
- contains multiple long paragraphs
- combines prose and a large table
- repeatedly fails structure validation

Do not merge code blocks with surrounding prose.

### 3. Decide what to translate and what to skip

Translate:
- headings
- prose paragraphs
- natural-language list items
- natural-language blockquote text
- natural-language table cells
- image alt text or caption text
- other plain explanatory text

Skip by default:
- fenced code block contents
- inline code
- URLs
- file paths
- shell commands
- API endpoints
- class names, function names, variable names, and enum values
- configuration keys, IDs, tokens, and obvious machine values
- math formulas
- frontmatter fields that are not clearly natural language

Partially translate when needed:
- links: translate only visible text, never the destination
- images: translate descriptive text, never the asset path
- frontmatter: translate only clearly human-facing string values such as `title`, `description`, `summary`, or `excerpt`; keep keys, quotes, scalar types, and machine-oriented fields unchanged

When a block should not be translated, output the source block verbatim.

### 4. Build structured translation task units

For each block, emit a structured task unit using the schema in [references/task-schemas.md](./references/task-schemas.md).

Minimum fields:
- `block_id`
- `block_type`
- `should_translate`
- `skip_reason`
- `source_text`
- `translation_prompt`
- `translated_text`
- `terminology_notes`
- `formatting_warnings`
- `retry_suggestion`

Keep `translated_text` empty until the model returns output.

### 5. Generate DeepSeek prompts

Use the templates in [references/prompt-templates.md](./references/prompt-templates.md).

Prompt rules:
- keep one stable system prompt for the whole document
- render one user prompt per block
- include glossary terms one mapping per line
- inject block metadata exactly as provided
- switch to a stricter or more conservative variant for highly technical or failure-prone blocks
- require translation-only output with no explanations

### 6. Validate the translated block before merging

Reject or retry a block when the output:
- changes heading level markers
- changes list indentation or marker style without need
- changes blockquote markers
- changes table column count or alignment row structure
- modifies link destinations
- modifies code fences or inline code spans
- changes math formulas
- adds notes, explanations, or commentary
- drops important qualifiers, numbers, warnings, or conditions

If validation fails, retry with a stricter prompt or smaller block before accepting the result.

### 7. Retranslate individual blocks

Use retranslation when structure is safe but quality is weak. Treat the previous translation as reference, not ground truth.

Supported retranslation goals:
- `more_accurate`
- `more_natural`
- `more_technical_doc`
- `more_concise`
- `more_conservative`
- `more_terminology_consistent`

Map the goal to the focus preset in [references/prompt-templates.md](./references/prompt-templates.md). Keep the original `block_id` stable across retries.

## Glossary and style rules

Glossary rules:
- obey explicit glossary mappings before model preference
- preserve source terms unchanged when the glossary says so, for example `Markdown -> Markdown`
- surface a terminology warning when the same source term maps to multiple targets
- if glossary entries conflict, prefer the most explicit user-provided mapping and record the conflict in `terminology_notes`
- when no glossary entry exists, prefer established technical Chinese usage and keep widely used English technical terms when translation would reduce precision

Style rules:
- prioritize accuracy over elegance
- keep Chinese natural, professional, and concise
- do not add or delete information
- do not expand examples or explanations
- keep terminology consistent across sibling blocks
- keep tone aligned with the document type:
  - `technical_doc`: conservative and precise
  - `blog`: natural but not chatty
  - `tutorial`: direct and instructional
  - `readme`: concise and actionable

## Failure handling and fallback

Use this retry order:
1. Retry the same block with a stricter prompt.
2. Split the block at paragraph or list boundaries and retry smaller units.
3. Switch to a more conservative focus preset for technical content.
4. If structure still breaks, return the source block unchanged and record a warning.

Add warnings when:
- a block is too long and should be split
- Markdown structure looks damaged
- glossary conflicts appear
- frontmatter contains ambiguous human-language fields
- the model appears to translate identifiers or URLs
- a retranslation request conflicts with a keep-term constraint

When unsure whether a token is natural language or an identifier, keep it unchanged.

## Typical requests

Use this skill for requests like:
- "Translate this README.md into Chinese without touching code blocks."
- "Split this Markdown tutorial into blocks and generate DeepSeek prompts for each block."
- "Retranslate block `p-014` to be more concise and keep `workflow` as `工作流`."
- "Check whether this translated Markdown block broke links, tables, or inline code."

## Output discipline

Always return structure-safe Markdown for actual translation output. Do not add explanations around the translated block.

When producing structured task units or planning data, keep JSON or YAML outside the translated Markdown payload.

## Resources

Use these bundled references as needed:
- [references/prompt-templates.md](./references/prompt-templates.md): system prompt, block prompt, retranslation prompt, and focus presets
- [references/task-schemas.md](./references/task-schemas.md): document/block schemas, block decision rules, warnings, and retry suggestions
