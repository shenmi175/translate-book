import { EXPORT_FORMATS, SERVICE_INFO } from "./task-service.js";

export function buildApiDocs(origin) {
  const baseUrl = `${origin}/api`;

  return {
    service: SERVICE_INFO,
    baseUrl,
    docsPath: "/api/docs",
    openApiPath: "/openapi.yaml",
    responseEnvelope: {
      success: "boolean",
      data: "object | array | string | null",
      error: {
        code: "string",
        message: "string",
        details: "object | null"
      }
    },
    keyStatusMetrics: [
      "progress",
      "translatedWordCount",
      "translationSpeed",
      "estimatedTimeRemaining",
      "translatedSourceCharacterCount",
      "translatedTargetCharacterCount",
      "activeBlocks"
    ],
    parsing: {
      currentEngine: "remark-mdast when dependencies are installed, otherwise heuristic fallback",
      astBacked: "dynamic",
      migrationRecommendation: "Install the remark/mdast stack to enable AST-backed parsing with source-slice round-tripping."
    },
    translation: {
      mode: "live",
      provider: "DeepSeek-compatible chat completions API",
      note: "The backend no longer falls back to mock translation. Missing API credentials or provider failures are returned as task errors."
    },
    endpoints: [
      { method: "GET", path: "/health", summary: "Health check" },
      { method: "GET", path: "/api", summary: "Service overview" },
      { method: "GET", path: "/api/docs", summary: "Machine-readable API description" },
      { method: "GET", path: "/openapi.yaml", summary: "OpenAPI 3.1 YAML document" },
      { method: "GET", path: "/api/settings", summary: "Get backend settings" },
      {
        method: "PUT",
        path: "/api/settings",
        summary: "Update backend settings"
      },
      { method: "GET", path: "/api/tasks", summary: "List tasks" },
      { method: "POST", path: "/api/tasks", summary: "Create a task and parse Markdown" },
      { method: "GET", path: "/api/tasks/:taskId", summary: "Get full task detail" },
      { method: "DELETE", path: "/api/tasks/:taskId", summary: "Delete one task" },
      { method: "POST", path: "/api/tasks/:taskId/parse", summary: "Reparse an existing task" },
      { method: "GET", path: "/api/tasks/:taskId/status", summary: "Get task status and live metrics" },
      { method: "POST", path: "/api/tasks/:taskId/translate", summary: "Start full-document translation via the live DeepSeek provider" },
      { method: "POST", path: "/api/tasks/:taskId/pause", summary: "Pause queued or translating blocks for a task" },
      { method: "POST", path: "/api/tasks/:taskId/cancel", summary: "Cancel queued or active blocks for a task" },
      { method: "GET", path: "/api/tasks/:taskId/blocks/:blockId", summary: "Get the latest content for a single block" },
      { method: "GET", path: "/api/tasks/:taskId/blocks/:blockId/prompt", summary: "Get prompt snapshot for one block" },
      { method: "POST", path: "/api/tasks/:taskId/blocks/:blockId/translate", summary: "Start translation for one block" },
      { method: "POST", path: "/api/tasks/:taskId/blocks/:blockId/retranslate", summary: "Start retranslation for one block" },
      { method: "POST", path: "/api/tasks/:taskId/blocks/retranslate-batch", summary: "Start retranslation for multiple blocks in one request" },
      { method: "PATCH", path: "/api/tasks/:taskId/blocks/:blockId", summary: "Update translated content or lock state for one block" },
      { method: "POST", path: "/api/tasks/:taskId/annotations", summary: "Save an annotation for one block" },
      {
        method: "GET",
        path: "/api/tasks/:taskId/exports/:format",
        summary: "Export task artifacts (`pdf` is reserved and currently returns 501)",
        pathParams: { format: EXPORT_FORMATS }
      }
    ]
  };
}
