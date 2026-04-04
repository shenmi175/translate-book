# Markdown Translator Backend API

## Base

- Base URL: `http://localhost:8787`
- Content-Type: `application/json`
- Response envelope:

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

Error shape:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "task_not_found",
    "message": "Task xxx was not found.",
    "details": null
  }
}
```

## System

### `GET /health`

Returns service health.

### `GET /api`

Returns service overview.

### `GET /api/docs`

Returns machine-readable JSON docs.

### `GET /openapi.yaml`

Returns the OpenAPI 3.1 YAML document.

## Settings

### `GET /api/settings`

Returns backend settings. `apiKey` is always blank in responses. Use `hasApiKey`, `maskedApiKey`, `apiKeySource`, `apiKeyStorageKey`, `apiKeyPersistence`, and `apiKeyDotenvPath` to understand whether credentials are available.

### `PUT /api/settings`

Updates backend settings.

Security behavior:

- `apiKey` is accepted but never persisted to `server/data/db.json`
- Sending `apiKey` injects it into the current server process only
- `POST /api/settings/api-key/dotenv` writes the key into the local `.env` file as `MARKDOWN_TRANSLATOR_API_KEY` and activates it immediately
- `DELETE /api/settings/api-key?scope=session|dotenv|all` clears the session key and/or removes it from `.env`
- The `.env` file is ignored by Git and is the restart-safe local persistence mechanism

Important fields:

- `apiProvider`
- `apiKey`
- `apiBaseUrl`
- `model`
- `requestTimeoutMs`
- `style`
- `glossary`
- `notes`
- `concurrency`
- `retries`

## Task formats

The backend supports two task formats:

- `markdown`
- `epub`

Format is inferred from `filename` when `documentFormat` is omitted, but the frontend should send it explicitly.

## Tasks

### `GET /api/tasks`

Returns task summaries.

Each summary includes:

- `documentFormat`
- `parser`
- `stats`
- `summary`

### `POST /api/tasks`

Creates a task and parses it immediately.

Markdown request example:

```json
{
  "filename": "guide.md",
  "documentFormat": "markdown",
  "content": "# Title\n\nHello world."
}
```

EPUB request example:

```json
{
  "filename": "book.epub",
  "documentFormat": "epub",
  "contentBase64": "UEsDB..."
}
```

Rules:

- Markdown tasks require `content`
- EPUB tasks require `contentBase64`
- There is no mock parser fallback for Markdown; Markdown parse failures return `422 markdown_parse_failed`

### `GET /api/tasks/:taskId`

Returns the full task.

Important top-level fields:

- `documentFormat`
- `parser`
- `stats`
- `summary`
- `blocks`
- `exports`
- `asset`

For EPUB tasks, `asset` is a sanitized summary:

- `packagePath`
- `title`
- `language`
- `spineCount`

### `DELETE /api/tasks/:taskId`

Deletes one task.

For EPUB tasks, server-side unpacked artifacts are removed together with the task.

### `POST /api/tasks/:taskId/parse`

Reparses the existing task using the same document format.

Markdown reparse example:

```json
{
  "content": "# Updated\n\nNew body"
}
```

EPUB reparse example:

```json
{
  "contentBase64": "UEsDB..."
}
```

Notes:

- Format switching is not supported during reparse
- EPUB reparsing without `contentBase64` reuses the stored source archive

### `GET /api/tasks/:taskId/status`

Polling endpoint.

Returned top-level fields:

- `taskId`
- `filename`
- `documentFormat`
- `updatedAt`
- `stage`
- `summary`
- `blocks`

Important `summary` metrics:

- `progress`
- `activeBlocks`
- `sourceWordCount`
- `translatedWordCount`
- `translationSpeed`
- `estimatedTimeRemaining`
- `totalSourceCharacterCount`
- `translatedSourceCharacterCount`
- `translatedTargetCharacterCount`
- `counts`

### Parsing metadata

`GET /api/tasks` and `GET /api/tasks/:taskId` expose parser metadata.

Markdown parser:

- `engine = remark-mdast`
- `roundTripStrategy = source-slice-reassembly`

EPUB parser:

- `engine = epub-xhtml-xml`
- `roundTripStrategy = validated-xhtml-fragment-rewrite`

EPUB parsing flow:

1. Save uploaded archive
2. Unpack EPUB container
3. Read `META-INF/container.xml`
4. Resolve OPF package document
5. Read manifest and spine order
6. Traverse each XHTML body in spine order
7. Extract stable block mappings by element path
8. Store per-block XHTML fragment metadata for translation and export

### `POST /api/tasks/:taskId/translate`

Starts full-document translation for eligible blocks.

This route uses the live DeepSeek-compatible chat completions API.

### `POST /api/tasks/:taskId/pause`

Pauses all queued or translating blocks.

### `POST /api/tasks/:taskId/resume`

Resumes all paused blocks.

### `POST /api/tasks/:taskId/cancel`

Cancels queued, translating, or paused blocks.

## Blocks

### `GET /api/tasks/:taskId/blocks/:blockId`

Returns the latest content for one block.

### `GET /api/tasks/:taskId/blocks/:blockId/prompt`

Returns:

- `systemPrompt`
- `translationPrompt`
- `retranslationPrompt`
- `rawPayload`

For EPUB blocks, the payload is built from the XHTML fragment, not from the preview Markdown text.

### `POST /api/tasks/:taskId/blocks/:blockId/translate`

Starts translation for one block.

### `POST /api/tasks/:taskId/blocks/:blockId/retranslate`

Starts retranslation for one block.

### `POST /api/tasks/:taskId/blocks/retranslate-batch`

Schedules retranslation for multiple blocks in one request.

Example:

```json
{
  "blockIds": ["p-001", "li-003", "tbl-001"],
  "retranslationGoal": "more_accurate",
  "focus": "terminology consistency"
}
```

### `PATCH /api/tasks/:taskId/blocks/:blockId`

Updates translated content or lock state.

Rules:

- Markdown tasks support `translatedMarkdown` manual edits
- EPUB tasks do not support manual block text edits; use retranslation instead
- Both formats support `locked`

### EPUB block mapping

EPUB blocks contain `translationUnit` for stable export round-tripping.

Important fields:

- `chapterPath`
- `chapterIndex`
- `nodePath`
- `sourceFragment`
- `translatedFragment`
- `structureSignature`
- `rootTag`

`sourceRange` for EPUB blocks also includes:

- `documentPath`
- `nodePath`

## Annotations

### `POST /api/tasks/:taskId/annotations`

Adds one annotation to one block.

Supported annotation types:

- `highlight`
- `underline`
- `strike`
- `comment`

## Exports

### `GET /api/tasks/:taskId/exports/:format`

Supported formats:

- `markdown`
- `markdown_bilingual`
- `records`
- `annotations`
- `mapping`
- `pdf`
- `pdf_bilingual`
- `epub`

Query parameters:

- `layout=translation-only|bilingual`
- `download=true`

Notes:

- `pdf` and `pdf_bilingual` return base64 PDF bytes in JSON by default
- `epub` is available only for EPUB tasks
- `download=true` returns raw file bytes directly instead of JSON wrapping

### EPUB export and validation chain

EPUB export is not produced by reserializing preview Markdown.

Actual chain:

1. Load stored unpacked EPUB assets
2. Copy source EPUB tree to a temporary build directory
3. For each translated EPUB block, locate the target XHTML node by `chapterPath + nodePath`
4. Parse the translated XHTML fragment
5. Validate root tag and structure signature against the source fragment
6. Merge only text and translatable `alt/title` values back into the source XHTML tree
7. Repack EPUB with correct `mimetype`
8. Re-open the generated EPUB and validate package / spine XHTML well-formedness

## Block statuses

Block `status` values:

- `idle`
- `queued`
- `translating`
- `paused`
- `translated`
- `failed`
- `edited`
- `retranslated`
- `skipped`
- `cancelled`

