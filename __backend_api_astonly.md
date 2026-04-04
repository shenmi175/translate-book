# Markdown Translator Backend API

## Base

- Base URL: `http://localhost:8787`
- Content-Type: `application/json`
- Envelope:

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

Returns backend settings. `apiKey` is always masked in responses.

### `PUT /api/settings`

Updates backend settings.

Important translation settings:

- `apiProvider`
- `apiKey`
- `apiBaseUrl`
- `model`
- `requestTimeoutMs`

## Tasks

### `GET /api/tasks`

Returns task summaries. Each task summary includes `parser` metadata.

### `POST /api/tasks`

Creates a task and parses Markdown immediately.

Request body:

```json
{
  "filename": "guide.md",
  "content": "# Title\n\nHello world.",
  "config": {
    "model": "deepseek-chat",
    "style": "accurate, professional, concise"
  }
}
```

### `GET /api/tasks/:taskId`

Returns the full task, including blocks, parser metadata, summary, activity, exports, and task config.

### `DELETE /api/tasks/:taskId`

Deletes one task and clears any scheduled timers.

### `POST /api/tasks/:taskId/parse`

Reparses the task. Useful after replacing Markdown content or changing task-level config.

### `GET /api/tasks/:taskId/status`

Polling endpoint. It stays lighter than `GET /api/tasks/:taskId`, but includes live metrics in `summary`.

Important `summary` fields:

- `progress`
- `activeBlocks`
- `translatedWordCount`
- `translationSpeed`
- `estimatedTimeRemaining`
- `totalSourceCharacterCount`
- `translatedSourceCharacterCount`
- `translatedTargetCharacterCount`
- `counts`

### Parsing metadata

`GET /api/tasks/:taskId` and `GET /api/tasks` expose:

- `parser.engine`
- `parser.version`
- `parser.astBacked`
- `parser.roundTripStrategy`
- `parser.warnings`

### `POST /api/tasks/:taskId/translate`

Starts full-document translation for eligible blocks.

This route now uses the live DeepSeek-compatible chat completions API. If the provider is not configured correctly, the request fails instead of returning mock translations.

### `POST /api/tasks/:taskId/pause`

Pauses all `queued` or `translating` blocks in the task. Matching blocks move to `paused`.

### `POST /api/tasks/:taskId/cancel`

Cancels all `queued`, `translating`, or `paused` blocks in the task. Matching blocks move to `cancelled`.

## Blocks

### `GET /api/tasks/:taskId/blocks/:blockId`

Returns one block only. Use this when `status` polling tells you a block changed and you want fresh Markdown content without reloading the whole task.

Example:

```json
{
  "success": true,
  "data": {
    "taskId": "uuid",
    "updatedAt": "2026-03-22T00:00:00.000Z",
    "block": {
      "id": "p-001",
      "type": "paragraph",
      "sourceMarkdown": "Hello world.",
      "translatedMarkdown": "你好，世界。",
      "status": "translated",
      "sourceRange": {
        "startLine": 3,
        "endLine": 3,
        "startOffset": 10,
        "endOffset": 22
      }
    }
  },
  "error": null
}
```

### `GET /api/tasks/:taskId/blocks/:blockId/prompt`

Returns `systemPrompt`, `translationPrompt`, `retranslationPrompt`, and `rawPayload`.

### `POST /api/tasks/:taskId/blocks/:blockId/translate`

Starts translation for one block.

### `POST /api/tasks/:taskId/blocks/:blockId/retranslate`

Starts retranslation for one block.

### `POST /api/tasks/:taskId/blocks/retranslate-batch`

Schedules retranslation for multiple blocks in one request.

Request body:

```json
{
  "blockIds": ["p-001", "li-003", "tbl-001"],
  "retranslationGoal": "more_accurate",
  "focus": "terminology consistency"
}
```

### `PATCH /api/tasks/:taskId/blocks/:blockId`

Updates translated content or lock state.

## Annotations

### `POST /api/tasks/:taskId/annotations`

Adds one annotation to one block.

## Exports

### `GET /api/tasks/:taskId/exports/:format`

Supported formats:

- `markdown`
- `records`
- `annotations`
- `mapping`
- `pdf`

`pdf` is currently a reserved route and returns `501 Not Implemented` in the live backend.

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

## Parser strategy note

Moving from handwritten parsing rules to `remark` / `mdast` is the right direction, but AST parsing still needs source positions and careful reassembly if you want to preserve Markdown formatting instead of normalizing it.
