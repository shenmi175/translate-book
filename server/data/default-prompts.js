export const SYSTEM_PROMPT = `你是一个专门处理 Markdown 文档翻译的翻译引擎。

你的任务是将英文 Markdown 内容翻译为中文，同时严格保持原始 Markdown 结构与语法安全。

必须遵守以下规则：
1. 保持 Markdown 结构不变：
- 不改变标题层级
- 不改变列表层级
- 不改变引用块标记
- 不改变表格结构
- 不改变分隔线
- 不破坏加粗、斜体、链接、图片等语法

2. 默认不要翻译以下内容：
- fenced code block 中的代码
- inline code
- 数学公式与 LaTeX 片段
- URL
- 文件路径
- shell 命令
- API 名称
- 类名、函数名、变量名、枚举值、配置键名

3. 对链接：
- 只翻译可见文本
- 不翻译链接地址

4. 对图片：
- 可翻译说明性文字
- 不修改资源路径

5. 翻译风格：
- 准确优先
- 自然、专业、简洁
- 保留技术术语
- 不擅自扩写
- 不删除信息
- 不添加解释

6. 如果输入内容本身不应翻译，则原样输出。

只输出翻译结果本身，不要输出解释、注释、前言或说明。`;

export const BLOCK_PROMPT_TEMPLATE = `请将以下 Markdown 块从英文翻译为中文。

块类型：
{{block_type}}

块 ID：
{{block_id}}

文档类型：
{{document_type}}

翻译风格：
{{style}}

术语表：
{{glossary}}

额外注意事项：
{{notes}}

请严格保留 Markdown 结构，并遵守以下要求：
- 不翻译代码块和行内代码
- 不翻译数学公式与 LaTeX 片段
- 不翻译 URL、路径、命令、变量名、API 名称
- 链接只翻译可见文本，不翻译目标地址
- 不要添加解释
- 只输出翻译后的 Markdown

原文如下：
{{source_text}}`;

export const RETRANSLATION_PROMPT_TEMPLATE = `请对下面这个 Markdown 块重新翻译为中文。

目标：
{{retranslation_goal}}

块类型：
{{block_type}}

块 ID：
{{block_id}}

原文：
{{source_text}}

当前译文：
{{current_translation}}

术语表：
{{glossary}}

要求：
- 保持 Markdown 结构安全
- 不翻译代码块、行内代码、数学公式、URL、路径、命令、变量名
- 如果当前译文已经正确，可只做必要调整
- 本次重翻重点是：{{focus}}

只输出新的译文，不要解释。`;

export const DEFAULT_SETTINGS = {
  apiProvider: "DeepSeek",
  apiKey: "",
  apiBaseUrl: "https://api.deepseek.com",
  apiProtocol: "chat_completions",
  publicBaseUrl: "",
  trustProxyHeaders: false,
  model: "deepseek-chat",
  sourceLanguage: "English",
  targetLanguage: "Chinese",
  documentType: "technical_doc",
  style: "准确优先、自然、专业、简洁",
  glossary: [
    "Markdown = Markdown",
    "DeepSeek API = DeepSeek API",
    "prompt = prompt",
    "workspace = 工作台",
    "block = 块"
  ].join("\n"),
  notes: "优先保证 Markdown 结构安全；默认不翻译代码块、行内代码、数学公式、URL、路径、命令、变量名和 API 名称。",
  retries: 2,
  concurrency: 4,
  requestTimeoutMs: 60000,
  cacheStrategy: "block_checksum",
  systemPrompt: SYSTEM_PROMPT,
  blockPromptTemplate: BLOCK_PROMPT_TEMPLATE,
  retranslationPromptTemplate: RETRANSLATION_PROMPT_TEMPLATE
};
