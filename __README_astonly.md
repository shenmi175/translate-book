# Markdown Translator Backend

This repository is backend-only. It exposes REST APIs for Markdown parsing, parser diagnostics, live DeepSeek translation, batch retranslation, task control, annotations, status polling, and export.

## Parser stack

The backend is prepared to use `remark + unified + mdast-util-to-markdown` for AST-backed Markdown parsing. In this sandbox the npm registry is blocked, so the code currently falls back to the heuristic parser unless those dependencies are already installed.

## Translation mode

Block translation now uses the live DeepSeek-compatible chat completions API. If the API key or base URL is missing, translation requests fail explicitly instead of silently using mock data.

## PDF export

The `pdf` route is reserved, but it currently returns `501 Not Implemented` until a reliable renderer is added.

## Run

```bash
node server/index.js
```

Default local URLs:

- Service root: [http://localhost:8787/](http://localhost:8787/)
- Health: [http://localhost:8787/health](http://localhost:8787/health)
- JSON API docs: [http://localhost:8787/api/docs](http://localhost:8787/api/docs)
- OpenAPI 3.1 YAML: [http://localhost:8787/openapi.yaml](http://localhost:8787/openapi.yaml)

## Main endpoints

- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/{taskId}`
- `DELETE /api/tasks/{taskId}`
- `POST /api/tasks/{taskId}/parse`
- `GET /api/tasks/{taskId}/status`
- `POST /api/tasks/{taskId}/translate`
- `POST /api/tasks/{taskId}/pause`
- `POST /api/tasks/{taskId}/cancel`
- `GET /api/tasks/{taskId}/blocks/{blockId}`
- `GET /api/tasks/{taskId}/blocks/{blockId}/prompt`
- `POST /api/tasks/{taskId}/blocks/{blockId}/translate`
- `POST /api/tasks/{taskId}/blocks/{blockId}/retranslate`
- `POST /api/tasks/{taskId}/blocks/retranslate-batch`
- `PATCH /api/tasks/{taskId}/blocks/{blockId}`
- `POST /api/tasks/{taskId}/annotations`
- `GET /api/tasks/{taskId}/exports/{format}`

## Docs

- Markdown guide: [docs/markdown-translator-backend-api.md](F:/project/translate-books/docs/markdown-translator-backend-api.md)
- OpenAPI YAML: [docs/openapi.yaml](F:/project/translate-books/docs/openapi.yaml)
