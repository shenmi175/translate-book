import axios from 'axios';

const api = axios.create({
  baseURL: '/api'
});

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error: any;
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
  summary: {
    translatedWordCount?: number;
    sourceWordCount?: number;
    translationSpeed?: number;
    estimatedTimeRemaining?: number | null;
    activeBlocks?: number;
    [key: string]: any;
  };
  blocks: BlockStatus[];
  pageBlocks: TaskPageBlock[];
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

export interface ConnectionTestResult {
  testedAt: string;
  effectiveApiEndpoint: string;
  keySource: 'none' | 'dotenv' | 'session';
  keyStorageKey?: string;
  result: {
    ok: boolean;
    provider: string;
    model: string;
    url: string;
    status: number;
    latencyMs: number;
    preview?: string;
    error?: string;
    raw?: any;
  };
}

export const Client = {
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
  async clearApiKey(options: { scope?: 'session' | 'dotenv' | 'all' } = {}) {
    const params = new URLSearchParams();
    if (options.scope) {
      params.set('scope', options.scope);
    }
    const suffix = params.toString() ? '?' + params.toString() : '';
    const { data } = await api.delete('/settings/api-key' + suffix);
    return data as ApiResponse<any>;
  },
  async getHealth() {
    const { data } = await axios.get('/health');
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
    const params = new URLSearchParams();
    if (options.layout) {
      params.set('layout', options.layout);
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const { data } = await api.get(`/tasks/${taskId}/exports/${format}${suffix}`);
    return data as ApiResponse<any>;
  }
};


