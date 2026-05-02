import axios from 'axios';
import { emitAuthRequired, getStoredAccessToken } from './auth';
import { getAppRuntimeConfig } from './runtime';

const runtime = getAppRuntimeConfig();

const api = axios.create({
  baseURL: runtime.apiBasePath
});

api.interceptors.request.use((config) => {
  const accessToken = getStoredAccessToken();
  if (accessToken) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      emitAuthRequired();
    }
    return Promise.reject(error);
  }
);

function buildTaskExportPath(taskId: string, format: string, options: ExportTaskOptions = {}, download = false) {
  const params = new URLSearchParams();
  if (options.layout) {
    params.set('layout', options.layout);
  }
  if (download) {
    params.set('download', '1');
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return `/tasks/${taskId}/exports/${format}${suffix}`;
}

function buildApiUrl(path: string) {
  const basePath = runtime.apiBasePath.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${basePath}${normalizedPath}`;
}

function buildAuthHeaders(headers?: HeadersInit) {
  const resolved = new Headers(headers);
  const accessToken = getStoredAccessToken();
  if (accessToken) {
    resolved.set('Authorization', `Bearer ${accessToken}`);
  }
  return resolved;
}

async function buildFetchError(response: Response, fallbackMessage: string) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json();
      return payload?.error?.message || fallbackMessage;
    } catch {
      return fallbackMessage;
    }
  }

  try {
    const text = (await response.text()).trim();
    return text || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error: any;
}

export interface ServiceOverview {
  authRequired?: boolean;
  adminAuth?: AdminAuthState;
  [key: string]: any;
}

export interface AdminAuthState {
  configured: boolean;
  username: string;
  locked: boolean;
  lockedAt?: string;
  failedAttempts: number;
  maxFailedAttempts: number;
}

export interface AuthSessionResponse {
  token: string;
  auth: AdminAuthState;
}

export interface BlockStatus {
  id: string;
  type: string;
  status: string;
  shouldTranslate: boolean;
  locked: boolean;
  errorMessage: string | null;
  reviewState?: 'none' | 'pending_confirmation' | 'confirmed' | 'ignored';
  reviewCandidateTranslation?: string;
  reviewErrorMessage?: string | null;
  lastTranslatedAt: string | null;
  lastEditedAt: string | null;
}

export interface TaskPageBlock extends BlockStatus {
  order: number;
  headingPath: string[];
  sourceMarkdown: string;
  translatedMarkdown: string;
  tokenEstimate?: number;
  skipReason?: string;
}

export interface FailedBlockRef {
  id: string;
  order: number;
  page?: number;
}

export interface TaskSearchMatch {
  id: string;
  order: number;
  page: number;
  status: string;
  reviewState: 'none' | 'pending_confirmation' | 'confirmed' | 'ignored';
  sourceExcerpt: string;
  translatedExcerpt: string;
}

export interface TaskSearchResponse {
  taskId: string;
  query: string;
  limit: number;
  totalMatches: number;
  matches: TaskSearchMatch[];
}

export interface TaskStatusResponse {
  taskId: string;
  filename: string;
  documentFormat: 'markdown' | 'epub';
  updatedAt: string;
  stage: string;
  providerLabel: string;
  page: number;
  pageSize: number;
  totalPages: number;
  totalBlocks: number;
  failedBlocks: FailedBlockRef[];
  attentionBlocks: FailedBlockRef[];
  summary: {
    translatedWordCount?: number;
    sourceWordCount?: number;
    translationSpeed?: number;
    estimatedTimeRemaining?: number | null;
    activeBlocks?: number;
    completedBlocks?: number;
    translatableBlocks?: number;
    counts?: Record<string, number>;
    [key: string]: any;
  };
  exportJobs: ExportJobStatus[];
  blocks?: BlockStatus[];
  pageBlocks: TaskPageBlock[];
}

export interface ExportJobStatus {
  id: string;
  format: string;
  options: {
    layout?: 'translation-only' | 'bilingual';
    [key: string]: any;
  };
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: {
    percent: number;
    stage: string;
    detail?: string;
    currentStep?: number;
    totalSteps?: number;
  };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  renderer?: string;
  generatedAt?: string;
  stale: boolean;
  canDownload: boolean;
}

export interface CreateTaskPayload {
  filename: string;
  documentFormat?: 'markdown' | 'epub';
  content?: string;
  contentBase64?: string;
  config?: any;
}

export interface ExportTaskOptions {
  layout?: 'translation-only' | 'bilingual';
}

export interface CreateExportJobPayload extends ExportTaskOptions {
  format: string;
}

export interface ConnectionTestResult {
  testedAt: string;
  effectiveApiEndpoint: string;
  keySource: 'none' | 'dotenv' | 'session';
  keyStorageKey?: string;
  result: {
    ok: boolean;
    provider: string;
    model: string;
    apiProtocol?: string;
    url: string;
    status: number;
    latencyMs: number;
    preview?: string;
    error?: string;
    raw?: any;
  };
}

function filenameFromDisposition(headerValue = '', fallback = 'download.bin') {
  const encodedMatch = headerValue.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    return decodeURIComponent(encodedMatch[1]);
  }

  const quotedMatch = headerValue.match(/filename="([^"]+)"/i);
  if (quotedMatch) {
    return decodeURIComponent(quotedMatch[1]);
  }

  return fallback;
}

function buildTaskExportJobDownloadPath(taskId: string, jobId: string) {
  return `/tasks/${taskId}/exports/jobs/${jobId}/download`;
}

export const Client = {
  async getServiceOverview() {
    const { data } = await axios.get(`${runtime.basePath || ''}/api`);
    return data as ApiResponse<ServiceOverview>;
  },
  async getAuthStatus() {
    const { data } = await axios.get(`${runtime.basePath || ''}/api/auth/status`);
    return data as ApiResponse<AdminAuthState>;
  },
  async registerAdmin(payload: { username: string; password: string }) {
    const { data } = await axios.post(`${runtime.basePath || ''}/api/auth/register`, payload);
    return data as ApiResponse<AuthSessionResponse>;
  },
  async loginAdmin(payload: { username: string; password: string }) {
    const { data } = await axios.post(`${runtime.basePath || ''}/api/auth/login`, payload);
    return data as ApiResponse<AuthSessionResponse>;
  },
  async logoutAdmin() {
    const { data } = await api.post('/auth/logout');
    return data as ApiResponse<{ ok: boolean }>;
  },
  async updateAdminAccount(payload: { currentPassword: string; username?: string; password?: string }) {
    const { data } = await api.put('/auth/account', payload);
    return data as ApiResponse<{ auth: AdminAuthState }>;
  },
  async getSettings() {
    const { data } = await api.get('/settings');
    return data as ApiResponse<any>;
  },
  async updateSettings(payload: any) {
    const { data } = await api.put('/settings', payload);
    return data as ApiResponse<any>;
  },
  async testConnection() {
    const { data } = await api.post('/settings/test-connection');
    return data as ApiResponse<ConnectionTestResult>;
  },
  async persistApiKeyToDotenv(payload: { apiKey: string }) {
    const { data } = await api.post('/settings/api-key/dotenv', payload);
    return data as ApiResponse<any>;
  },
  async persistAccessTokenToDotenv(payload: { accessToken: string }) {
    const { data } = await api.post('/settings/access-token/dotenv', payload);
    return data as ApiResponse<any>;
  },
  async clearApiKey(options: { scope?: 'session' | 'database' | 'dotenv' | 'all' } = {}) {
    const params = new URLSearchParams();
    if (options.scope) {
      params.set('scope', options.scope);
    }
    const suffix = params.toString() ? '?' + params.toString() : '';
    const { data } = await api.delete('/settings/api-key' + suffix);
    return data as ApiResponse<any>;
  },
  async clearAccessToken(options: { scope?: 'session' | 'database' | 'dotenv' | 'all' } = {}) {
    const params = new URLSearchParams();
    if (options.scope) {
      params.set('scope', options.scope);
    }
    const suffix = params.toString() ? '?' + params.toString() : '';
    const { data } = await api.delete('/settings/access-token' + suffix);
    return data as ApiResponse<any>;
  },
  async getHealth() {
    const { data } = await axios.get(`${runtime.basePath || ''}/health`);
    return data as ApiResponse<any>;
  },
  async getTasks() {
    const { data } = await api.get('/tasks');
    return data as ApiResponse<any[]>;
  },
  async getTask(id: string) {
    const { data } = await api.get(`/tasks/${id}`);
    return data as ApiResponse<any>;
  },
  async createTask(payload: CreateTaskPayload) {
    const { data } = await api.post('/tasks', payload);
    return data as ApiResponse<any>;
  },
  async createBinaryTask(file: File, options: { filename?: string; documentFormat?: 'epub' | 'markdown' } = {}) {
    const filename = options.filename || file.name || 'untitled.epub';
    const documentFormat = options.documentFormat || (filename.toLowerCase().endsWith('.epub') ? 'epub' : 'markdown');
    const params = new URLSearchParams({
      filename,
      documentFormat
    });
    const buffer = await file.arrayBuffer();
    const { data } = await api.post(`/tasks?${params.toString()}`, buffer, {
      headers: {
        'Content-Type': documentFormat === 'epub' ? 'application/epub+zip' : 'application/octet-stream'
      }
    });
    return data as ApiResponse<any>;
  },
  async deleteTask(id: string) {
    const { data } = await api.delete(`/tasks/${id}`);
    return data as ApiResponse<any>;
  },
  async startTranslation(id: string) {
    const { data } = await api.post(`/tasks/${id}/translate`);
    return data as ApiResponse<any>;
  },
  async pauseTask(id: string) {
    const { data } = await api.post(`/tasks/${id}/pause`);
    return data as ApiResponse<any>;
  },
  async resumeTask(id: string) {
    const { data } = await api.post(`/tasks/${id}/resume`);
    return data as ApiResponse<any>;
  },
  async cancelTask(id: string) {
    const { data } = await api.post(`/tasks/${id}/cancel`);
    return data as ApiResponse<any>;
  },
  async getTaskStatus(id: string, options: { page?: number; pageSize?: number | 'all' } = {}) {
    const params = new URLSearchParams();
    if (options.page) {
      params.set('page', String(options.page));
    }
    if (options.pageSize) {
      params.set('pageSize', String(options.pageSize));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const { data } = await api.get(`/tasks/${id}/status${suffix}`);
    return data as ApiResponse<TaskStatusResponse>;
  },
  async searchTaskBlocks(id: string, options: { query: string; pageSize?: number; limit?: number } ) {
    const params = new URLSearchParams();
    params.set('q', options.query);
    if (options.pageSize) {
      params.set('pageSize', String(options.pageSize));
    }
    if (options.limit) {
      params.set('limit', String(options.limit));
    }
    const { data } = await api.get(`/tasks/${id}/search?${params.toString()}`);
    return data as ApiResponse<TaskSearchResponse>;
  },
  async startBlockTranslation(taskId: string, blockId: string) {
    const { data } = await api.post(`/tasks/${taskId}/blocks/${blockId}/translate`);
    return data as ApiResponse<any>;
  },
  async retranslateBlock(taskId: string, blockId: string, payload: any) {
    const { data } = await api.post(`/tasks/${taskId}/blocks/${blockId}/retranslate`, payload);
    return data as ApiResponse<any>;
  },
  async updateBlock(taskId: string, blockId: string, payload: { translatedMarkdown?: string; locked?: boolean; reviewState?: 'confirmed' | 'ignored' | 'none' }) {
    const { data } = await api.patch(`/tasks/${taskId}/blocks/${blockId}`, payload);
    return data as ApiResponse<any>;
  },
  async getBlock(taskId: string, blockId: string) {
    const { data } = await api.get(`/tasks/${taskId}/blocks/${blockId}`);
    return data as ApiResponse<any>;
  },
  async retranslateBlocksBatch(taskId: string, payload: { blockIds: string[]; retranslationGoal?: string; focus?: string }) {
    const { data } = await api.post(`/tasks/${taskId}/blocks/retranslate-batch`, payload);
    return data as ApiResponse<any>;
  },
  async exportTask(taskId: string, format: string, options: ExportTaskOptions = {}) {
    const { data } = await api.get(buildTaskExportPath(taskId, format, options));
    return data as ApiResponse<any>;
  },
  async downloadTaskExport(taskId: string, format: string, options: ExportTaskOptions = {}) {
    const response = await fetch(buildApiUrl(buildTaskExportPath(taskId, format, options, true)), {
      method: 'GET',
      headers: buildAuthHeaders(),
      credentials: 'same-origin'
    });

    if (response.status === 401) {
      emitAuthRequired();
    }

    if (!response.ok) {
      throw new Error(await buildFetchError(response, `Failed to export ${format} (${response.status})`));
    }

    const disposition = String(response.headers.get('content-disposition') || '');
    return {
      blob: await response.blob(),
      filename: filenameFromDisposition(disposition, `${taskId}.${format}`)
    };
  },
  async createExportJob(taskId: string, payload: CreateExportJobPayload) {
    const { data } = await api.post(`/tasks/${taskId}/exports/jobs`, payload);
    return data as ApiResponse<{ taskId: string; filename: string; job: ExportJobStatus }>;
  },
  async getExportJob(taskId: string, jobId: string) {
    const { data } = await api.get(`/tasks/${taskId}/exports/jobs/${jobId}`);
    return data as ApiResponse<{ taskId: string; filename: string; job: ExportJobStatus }>;
  },
  async downloadExportJob(taskId: string, jobId: string) {
    const response = await fetch(buildApiUrl(buildTaskExportJobDownloadPath(taskId, jobId)), {
      method: 'GET',
      headers: buildAuthHeaders(),
      credentials: 'same-origin'
    });

    if (response.status === 401) {
      emitAuthRequired();
    }

    if (!response.ok) {
      throw new Error(await buildFetchError(response, `Failed to download export job ${jobId} (${response.status})`));
    }

    const disposition = String(response.headers.get('content-disposition') || '');
    return {
      blob: await response.blob(),
      filename: filenameFromDisposition(disposition, jobId)
    };
  },
  getTaskExportDownloadUrl(taskId: string, format: string, options: ExportTaskOptions = {}) {
    return buildApiUrl(buildTaskExportPath(taskId, format, options, true));
  }
};
