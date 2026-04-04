import { DOCUMENT_FORMATS, EXPORT_FORMATS, SERVICE_INFO } from './task-service.js';

export function buildApiDocs(origin) {
  const baseUrl = `${origin}/api`;

  return {
    service: SERVICE_INFO,
    baseUrl,
    docsPath: '/api/docs',
    openApiPath: '/openapi.yaml',
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
    settings: {
      secretHandling: 'apiKey is never persisted to db.json; send it per session or persist it into the local .env file as MARKDOWN_TRANSLATOR_API_KEY.',
      responseFields: ['hasApiKey', 'maskedApiKey', 'apiKeySource', 'apiKeyStorageKey', 'apiKeyPersistence', 'apiKeyDotenvPath', 'apiKeyMutationGuard'],
      secretMutationEndpoints: [
        { method: 'POST', path: '/api/settings/api-key/dotenv', summary: 'Persist apiKey into the local .env file and activate it for the current process. Loopback requests only.' },
        { method: 'DELETE', path: '/api/settings/api-key?scope=session|dotenv|all', summary: 'Clear the session key and/or remove it from the local .env file. Loopback requests only.' }
      ]
    },
    taskFormats: DOCUMENT_FORMATS,
    exportFormats: EXPORT_FORMATS,
    endpoints: [
      { method: 'GET', path: '/health', summary: 'Health check' },
      { method: 'GET', path: '/api', summary: 'Service overview' },
      { method: 'GET', path: '/api/docs', summary: 'Machine-readable API description' },
      { method: 'GET', path: '/openapi.yaml', summary: 'OpenAPI 3.1 YAML document' },
      { method: 'GET', path: '/api/settings', summary: 'Get backend settings' },
      { method: 'PUT', path: '/api/settings', summary: 'Update backend settings' },
      { method: 'POST', path: '/api/settings/api-key/dotenv', summary: 'Persist the apiKey into the local .env file (loopback only)' },
      { method: 'DELETE', path: '/api/settings/api-key', summary: 'Clear the session key and/or remove it from the local .env file (loopback only)' },
      { method: 'GET', path: '/api/tasks', summary: 'List Markdown and EPUB tasks' },
      { method: 'POST', path: '/api/tasks', summary: 'Create a Markdown or EPUB task and parse it immediately' },
      { method: 'GET', path: '/api/tasks/:taskId', summary: 'Get full task detail' },
      { method: 'DELETE', path: '/api/tasks/:taskId', summary: 'Delete one task and remove EPUB artifacts if present' },
      { method: 'POST', path: '/api/tasks/:taskId/parse', summary: 'Reparse an existing task using the same document format' },
      { method: 'GET', path: '/api/tasks/:taskId/status', summary: 'Get task status and live metrics' },
      { method: 'POST', path: '/api/tasks/:taskId/translate', summary: 'Start full-document translation via the live DeepSeek provider' },
      { method: 'POST', path: '/api/tasks/:taskId/pause', summary: 'Pause queued or translating blocks for a task' },
      { method: 'POST', path: '/api/tasks/:taskId/resume', summary: 'Resume paused blocks for a task' },
      { method: 'POST', path: '/api/tasks/:taskId/cancel', summary: 'Cancel queued or active blocks for a task' },
      { method: 'GET', path: '/api/tasks/:taskId/blocks/:blockId', summary: 'Get the latest content for a single block' },
      { method: 'GET', path: '/api/tasks/:taskId/blocks/:blockId/prompt', summary: 'Get prompt snapshot for one block' },
      { method: 'POST', path: '/api/tasks/:taskId/blocks/:blockId/translate', summary: 'Start translation for one block' },
      { method: 'POST', path: '/api/tasks/:taskId/blocks/:blockId/retranslate', summary: 'Start retranslation for one block' },
      { method: 'POST', path: '/api/tasks/:taskId/blocks/retranslate-batch', summary: 'Start retranslation for multiple blocks in one request' },
      { method: 'PATCH', path: '/api/tasks/:taskId/blocks/:blockId', summary: 'Update translated content or lock state for one block (Markdown only for manual text edits)' },
      { method: 'POST', path: '/api/tasks/:taskId/annotations', summary: 'Save an annotation for one block' },
      {
        method: 'GET',
        path: '/api/tasks/:taskId/exports/:format',
        summary: 'Export task artifacts. `pdf` supports layout=translation-only|bilingual, `epub` is available for EPUB tasks, and `download=true` returns raw bytes.',
        pathParams: { format: EXPORT_FORMATS }
      }
    ]
  };
}
