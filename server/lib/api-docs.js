import { DOCUMENT_FORMATS, EXPORT_FORMATS, SERVICE_INFO } from './task-service.js';

function normalizeBasePath(value = '') {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') {
    return '';
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return normalized.replace(/\/+$/, '') || '';
}

function buildPath(basePath, suffix) {
  return `${basePath}${suffix}` || suffix;
}

export function buildApiDocs(origin) {
  const publicBaseUrl = String(origin || '').trim().replace(/\/+$/, '');
  let basePath = '';
  try {
    basePath = publicBaseUrl ? normalizeBasePath(new URL(publicBaseUrl).pathname) : '';
  } catch {
    basePath = '';
  }

  const baseUrl = publicBaseUrl ? `${publicBaseUrl}/api` : '';
  const docsPath = buildPath(basePath, '/api/docs');
  const openApiPath = buildPath(basePath, '/openapi.yaml');
  const healthPath = buildPath(basePath, '/health');

  return {
    service: SERVICE_INFO,
    baseUrl,
    docsPath,
    openApiPath,
    responseEnvelope: {
      success: 'boolean',
      data: 'object | array | string | null',
      error: {
        code: 'string',
        message: 'string',
        details: 'object | null'
      }
    },
    keyStatusMetrics: [
      'progress',
      'sourceWordCount',
      'translatedWordCount',
      'translationSpeed',
      'estimatedTimeRemaining',
      'translatedSourceCharacterCount',
      'translatedTargetCharacterCount',
      'activeBlocks'
    ],
    parsing: {
      markdownEngine: 'remark-mdast',
      epubEngine: 'xhtml-fragment XML traversal over EPUB spine documents',
      astBacked: true,
      roundTripStrategy: {
        markdown: 'source-slice-reassembly',
        epub: 'validated-xhtml-fragment-rewrite'
      },
      note: 'Markdown tasks use remark/mdast with GFM and remark-math. EPUB tasks unpack the archive, walk OPF manifest/spine, parse XHTML chapters, map stable node paths, and validate translated fragments before export.'
    },
    translation: {
      mode: 'live',
      provider: 'DeepSeek-compatible chat completions API',
      note: 'The backend does not fall back to mock translation. Missing API credentials or provider failures are returned as task errors.'
    },
    authentication: {
      mode: 'optional bearer token',
      note: 'When MARKDOWN_TRANSLATOR_ACCESS_TOKEN is configured, every /api/* endpoint except /api, /api/docs, and /api/openapi.yaml requires Authorization: Bearer <token> or X-Access-Token.',
      headerNames: ['Authorization: Bearer <token>', 'X-Access-Token: <token>']
    },
    settings: {
      secretHandling: 'apiKey and accessToken are never persisted to db.json; send them per session or persist them into the local .env file as MARKDOWN_TRANSLATOR_API_KEY and MARKDOWN_TRANSLATOR_ACCESS_TOKEN.',
      responseFields: [
        'hasApiKey',
        'maskedApiKey',
        'apiKeySource',
        'apiKeyStorageKey',
        'apiKeyPersistence',
        'apiKeyDotenvPath',
        'apiKeyMutationGuard',
        'hasAccessToken',
        'maskedAccessToken',
        'accessTokenSource',
        'accessTokenStorageKey',
        'accessTokenPersistence',
        'accessTokenDotenvPath',
        'accessTokenMutationGuard',
        'authRequired'
      ],
      secretMutationEndpoints: [
        { method: 'POST', path: buildPath(basePath, '/api/settings/api-key/dotenv'), summary: 'Persist apiKey into the local .env file and activate it for the current process. Loopback requests only.' },
        { method: 'DELETE', path: buildPath(basePath, '/api/settings/api-key?scope=session|dotenv|all'), summary: 'Clear the session key remotely, or remove it from the local .env file when called from loopback.' },
        { method: 'POST', path: buildPath(basePath, '/api/settings/access-token/dotenv'), summary: 'Persist accessToken into the local .env file and activate API protection after restart. Loopback requests only.' },
        { method: 'DELETE', path: buildPath(basePath, '/api/settings/access-token?scope=session|dotenv|all'), summary: 'Clear the session access token remotely, or remove it from the local .env file when called from loopback.' }
      ]
    },
    taskFormats: DOCUMENT_FORMATS,
    exportFormats: EXPORT_FORMATS,
    endpoints: [
      { method: 'GET', path: healthPath, summary: 'Health check' },
      { method: 'GET', path: buildPath(basePath, '/api'), summary: 'Service overview' },
      { method: 'GET', path: docsPath, summary: 'Machine-readable API description' },
      { method: 'GET', path: openApiPath, summary: 'OpenAPI 3.1 YAML document' },
      { method: 'GET', path: buildPath(basePath, '/api/settings'), summary: 'Get backend settings' },
      { method: 'PUT', path: buildPath(basePath, '/api/settings'), summary: 'Update backend settings' },
      { method: 'POST', path: buildPath(basePath, '/api/settings/api-key/dotenv'), summary: 'Persist the apiKey into the local .env file (loopback only)' },
      { method: 'DELETE', path: buildPath(basePath, '/api/settings/api-key'), summary: 'Clear the session key, or remove it from the local .env file when called from loopback' },
      { method: 'POST', path: buildPath(basePath, '/api/settings/access-token/dotenv'), summary: 'Persist the access token into the local .env file (loopback only)' },
      { method: 'DELETE', path: buildPath(basePath, '/api/settings/access-token'), summary: 'Clear the session access token, or remove it from the local .env file when called from loopback' },
      { method: 'GET', path: buildPath(basePath, '/api/tasks'), summary: 'List Markdown and EPUB tasks' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks'), summary: 'Create a Markdown or EPUB task and parse it immediately' },
      { method: 'GET', path: buildPath(basePath, '/api/tasks/:taskId'), summary: 'Get full task detail' },
      { method: 'DELETE', path: buildPath(basePath, '/api/tasks/:taskId'), summary: 'Delete one task and remove EPUB artifacts if present' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/parse'), summary: 'Reparse an existing task using the same document format' },
      { method: 'GET', path: buildPath(basePath, '/api/tasks/:taskId/status'), summary: 'Get task status and live metrics' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/translate'), summary: 'Start full-document translation via the live DeepSeek provider' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/pause'), summary: 'Pause queued or translating blocks for a task' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/resume'), summary: 'Resume paused blocks for a task' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/cancel'), summary: 'Cancel queued or active blocks for a task' },
      { method: 'GET', path: buildPath(basePath, '/api/tasks/:taskId/blocks/:blockId'), summary: 'Get the latest content for a single block' },
      { method: 'GET', path: buildPath(basePath, '/api/tasks/:taskId/blocks/:blockId/prompt'), summary: 'Get prompt snapshot for one block' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/blocks/:blockId/translate'), summary: 'Start translation for one block' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/blocks/:blockId/retranslate'), summary: 'Start retranslation for one block' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/blocks/retranslate-batch'), summary: 'Start retranslation for multiple blocks in one request' },
      { method: 'PATCH', path: buildPath(basePath, '/api/tasks/:taskId/blocks/:blockId'), summary: 'Update translated content or lock state for one block (Markdown only for manual text edits)' },
      { method: 'POST', path: buildPath(basePath, '/api/tasks/:taskId/annotations'), summary: 'Save an annotation for one block' },
      {
        method: 'GET',
        path: buildPath(basePath, '/api/tasks/:taskId/exports/:format'),
        summary: 'Export task artifacts. `pdf` supports layout=translation-only|bilingual, `epub` and `epub_bilingual` are available for EPUB tasks, and `download=true` returns raw bytes.',
        pathParams: { format: EXPORT_FORMATS }
      }
    ]
  };
}
