# Markdown Translator Backend

This repository exposes a REST backend for Markdown and EPUB translation workflows.

Supported capabilities:

- AST-backed Markdown parsing with `remark + unified + mdast`
- EPUB archive parsing through OPF/spine/XHTML traversal
- Live DeepSeek-compatible block translation
- Batch retranslation and task control
- Block annotations and task polling
- Markdown / PDF / EPUB export

## Parser stack

### Markdown

Markdown parsing is AST-only and uses `remark`, GFM extensions, and `remark-math` when installed. There is no handwritten fallback parser.

### EPUB

EPUB tasks are unpacked, resolved through `META-INF/container.xml` and the OPF package document, then mapped block-by-block from XHTML spine content. Export rewrites validated XHTML fragments back into the source EPUB tree before repacking.

## Translation mode

Block translation uses the live DeepSeek-compatible chat completions API. Missing API credentials or provider failures are returned explicitly.

## Secrets and deployment

API keys are no longer persisted to `server/data/db.json` or returned in plaintext from the settings API.

- `PUT /api/settings` with `apiKey` only injects the key into the current server process memory
- `POST /api/settings/api-key/dotenv` writes the key into the local `.env` file as `MARKDOWN_TRANSLATOR_API_KEY` and activates it immediately
- `DELETE /api/settings/api-key?scope=session|dotenv|all` clears the session key and/or removes it from `.env`
- The local `.env` file is already ignored by Git via `.gitignore`
- To survive restarts locally, keep the key in `.env` rather than in the task database

Example `.env`:

```dotenv
MARKDOWN_TRANSLATOR_API_KEY=sk-your-key
PORT=8787
```

## Export formats

- `markdown`
- `markdown_bilingual`
- `pdf`
- `pdf_bilingual`
- `epub` (EPUB tasks only)
- `records`
- `annotations`
- `mapping`

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
- `POST /api/settings/api-key/dotenv`
- `DELETE /api/settings/api-key?scope=session|dotenv|all`
- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/{taskId}`
- `DELETE /api/tasks/{taskId}`
- `POST /api/tasks/{taskId}/parse`
- `GET /api/tasks/{taskId}/status`
- `POST /api/tasks/{taskId}/translate`
- `POST /api/tasks/{taskId}/pause`
- `POST /api/tasks/{taskId}/resume`
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

