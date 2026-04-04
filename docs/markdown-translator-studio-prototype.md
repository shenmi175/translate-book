# Markdown Translator Studio 应用原型方案

## 1. 应用整体信息架构

### 1.1 产品定位

Markdown Translator Studio 是一个面向技术用户、写作者、开发者的 Markdown 文档翻译工作台。它不是单按钮翻译器，而是“导入 -> 解析 -> 分块翻译 -> 审校 -> 导出”的结构化工作流。

### 1.2 一级信息架构

- Landing
- Import
- Parse Preview
- Translation Workspace
- Export
- Settings

### 1.3 核心对象

- 文档任务 `TranslationTask`
- Markdown 块 `TranslationBlock`
- 翻译配置 `TranslationConfig`
- Prompt 快照 `PromptSnapshot`
- 批注 `Annotation`
- 导出产物 `ExportBundle`

## 2. 页面结构与导航关系

### 2.1 路由

- `/`
- `#/import`
- `#/preview/:taskId`
- `#/workspace/:taskId`
- `#/export/:taskId`
- `#/settings`

### 2.2 导航关系

1. Landing 进入 Import 或直接打开 Demo Workspace。
2. Import 完成上传和配置后进入 Parse Preview。
3. Parse Preview 确认块结构后进入 Workspace。
4. Workspace 可随时跳转 Export 或 Settings。
5. Settings 为全局配置页，可返回 Import/Workspace 继续操作。

## 3. 每个页面的功能说明

### 3.1 首页 / Landing

- 展示产品定位：Markdown 翻译、DeepSeek 驱动、保留原格式、支持局部重翻、支持审校与批注
- 说明工作流：导入 -> 解析 -> 翻译 -> 审校 -> 导出
- 提供两条 CTA：导入 Markdown、打开示例工作台

### 3.2 文档导入页 / Import

- 上传 `.md` 文件
- 拖拽上传
- 显示文件名、大小、字符数、段落数
- 选择翻译配置：模型、语言方向、术语表、风格、注意事项
- 调用上传与解析接口，创建翻译任务

### 3.3 文档解析预览页 / Parse Preview

- 显示 Markdown 被拆分的块列表
- 标示块类型：标题、段落、列表项、引用、代码块、表格、图片等
- 标识每个块是否翻译，若跳过则显示跳过原因
- 显示块 ID、Heading Path、状态、Token 估算
- 提供“开始全文翻译”“进入工作台”

### 3.4 翻译工作台 / Translation Workspace

- 左侧原文、右侧译文
- 按块一一对应，支持单块选中
- 支持全文翻译、单块翻译、单块重翻
- 支持锁定当前译文
- 支持查看 Prompt 快照
- 支持复制块内容
- 支持高亮、下划线、删除线、批注
- 显示块状态：待翻译、已排队、翻译中、已翻译、失败、人工修改、已重翻、已跳过

### 3.5 导出页 / Export

- 导出译后 `.md`
- 导出翻译记录 JSON
- 导出批注数据 JSON
- 导出块映射 JSON
- 支持导出前预览

### 3.6 设置页 / Settings

- 配置 DeepSeek API Key
- 配置模型名
- 配置 system prompt
- 配置块翻译 prompt 与重翻 prompt
- 配置翻译风格
- 配置术语表
- 配置重试次数、并发数、缓存策略

## 4. 用户操作流程

1. 用户进入 Landing，了解产品定位并点击“导入 Markdown”。
2. 在 Import 上传 `.md` 文件，填写模型、术语表和风格。
3. 系统创建任务并进入 Parse Preview。
4. 用户检查块级拆分是否合理，确认哪些块会翻译、哪些块会跳过。
5. 用户开始全文翻译，进入 Workspace。
6. 系统按块更新翻译状态；用户可逐块查看原文与译文。
7. 对失败块或不满意的块执行“重翻”；对满意块执行“锁定当前译文”。
8. 用户对译文添加高亮、下划线、删除线或批注，并保存人工修改。
9. 用户进入 Export 下载 `.md`、翻译记录、批注和映射 JSON。

## 5. 状态设计

### 5.1 任务状态

- `parsed`
- `translating`
- `review`
- `export_ready`

### 5.2 块状态

- `idle`
- `queued`
- `translating`
- `translated`
- `failed`
- `edited`
- `retranslated`
- `skipped`

### 5.3 独立布尔状态

- `locked`
- `shouldTranslate`

### 5.4 UI 状态

- 当前过滤器：按状态 / 按块类型
- 当前选中块
- 当前 Prompt Modal Tab
- 当前导出预览类型
- 当前文件上传草稿

## 6. 组件清单

### 6.1 布局组件

- `TopNav`
- `AppShell`
- `Sidebar`
- `Toolbar`
- `ProgressPanel`

### 6.2 页面组件

- `LandingHero`
- `UploadDropzone`
- `ParseTable`
- `BlockRow`
- `TranslationEditor`
- `AnnotationToolbar`
- `PromptPreviewModal`
- `ExportCard`
- `SettingsForm`

### 6.3 工作台组件

- `BlockStatusChip`
- `BlockMetaPills`
- `SourcePane`
- `TargetPane`
- `AnnotatedPreview`
- `CommentDrawer`

## 7. 数据实体设计

### 7.1 TranslationTask

```ts
type TranslationTask = {
  id: string;
  filename: string;
  sourceMarkdown: string;
  createdAt: string;
  updatedAt: string;
  source: "upload" | "demo";
  config: TranslationConfig;
  stats: {
    characters: number;
    paragraphs: number;
    blocks: number;
    translatableBlocks: number;
    skippedBlocks: number;
  };
  summary: TaskSummary;
  blocks: TranslationBlock[];
  annotations: Annotation[];
  comments: Annotation[];
  exports: ExportBundle;
};
```

### 7.2 TranslationBlock

```ts
type TranslationBlock = {
  id: string;
  type: string;
  order: number;
  headingPath: string[];
  sourceMarkdown: string;
  translatedMarkdown: string;
  status: "idle" | "queued" | "translating" | "translated" | "failed" | "edited" | "retranslated" | "skipped";
  shouldTranslate: boolean;
  skipped: boolean;
  skipReason: string;
  locked: boolean;
  tokenEstimate: number;
  retryCount: number;
  failureCount: number;
  separatorAfter: string;
  errorMessage: string;
  promptSnapshot: PromptSnapshot;
  annotations: Annotation[];
  comments: Annotation[];
};
```

### 7.3 其他实体

```ts
type TranslationConfig = {
  apiProvider: "DeepSeek";
  apiKey: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  documentType: string;
  style: string;
  glossary: string;
  notes: string;
  retries: number;
  concurrency: number;
  cacheStrategy: string;
  systemPrompt: string;
  blockPromptTemplate: string;
  retranslationPromptTemplate: string;
};

type PromptSnapshot = {
  systemPrompt: string;
  translationPrompt: string;
  retranslationPrompt: string;
  rawPayload: Record<string, string>;
};

type Annotation = {
  id: string;
  blockId: string;
  type: "highlight" | "underline" | "strike" | "comment";
  scope: "source" | "translation";
  start: number;
  end: number;
  text: string;
  note: string;
  createdAt: string;
};
```

### 7.4 接口预留设计

已在原型中预留以下接口能力：

- `POST /api/tasks/upload`
- `POST /api/tasks/:taskId/parse`
- `POST /api/tasks/:taskId/translate`
- `POST /api/tasks/:taskId/blocks/:blockId/translate`
- `POST /api/tasks/:taskId/blocks/:blockId/retranslate`
- `POST /api/tasks/:taskId/annotations`
- `GET /api/tasks/:taskId/export/:format`
- `GET /api/tasks/:taskId/status`

同时提供 Apps 风格工具面：

- `open_translator_studio`
- `upload_markdown`
- `parse_markdown`
- `start_translation`
- `translate_block`
- `retranslate_block`
- `save_annotations`
- `export_markdown`
- `get_task_status`

## 8. 应用 MVP 范围

### 8.1 本次原型包含

- 6 个核心页面
- Markdown 基础块解析
- 任务创建与块状态管理
- 全文翻译与单块重翻 mock 流程
- Prompt 预览
- 批注与人工修改
- 4 种导出形式
- `/mcp` + REST mock backend 双通路

### 8.2 MVP 刻意不做

- 真实 DeepSeek API 调用
- 数据库存储与多用户协作
- 真正的 Markdown AST 级精确渲染
- 差异比对算法
- 复杂权限、登录、团队空间

## 9. 后续增强功能建议

1. 用 FastAPI 接管当前 mock handler，落真实任务队列、缓存与持久化。
2. 用 Markdown AST 解析器替换轻量 parser，提高表格、嵌套列表、frontmatter 的结构保真度。
3. 接入真实 DeepSeek API，并将当前 Prompt 模板升级为可版本化配置。
4. 增加术语冲突检测、结构校验、失败重试策略与自动回退机制。
5. 增加原文 / 译文 diff、术语一致性报告、质量评分与审校工作流。
6. 增加团队协作、批注归档、版本历史与导出模板。
