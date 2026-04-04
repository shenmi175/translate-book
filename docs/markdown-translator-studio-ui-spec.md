# Markdown Translator Studio 前端页面方案

## 1. 产品目标与设计原则

### 1.1 产品定位

Markdown Translator Studio 是一个面向开发者、技术作者、研究人员的 Markdown 翻译工作台，核心关注点不是“翻译结果展示”，而是“可审校、可追踪、可导出的结构化翻译流程”。

关键能力：

- 导入英文 Markdown 文档并进行块级解析
- 调用 DeepSeek API 进行块级翻译
- 保留 Markdown 原始结构与语法安全
- 支持块级重新翻译、锁定与跳过
- 支持审校标注：高亮、下划线、删除线、批注
- 导出新的 `.md` 文件及配套元数据

### 1.2 设计原则

- 深色优先，浅色兼容
- 信息密度中高，但层级明确
- 更像“工程工作台”而非营销官网
- 强调块级映射、状态反馈、可操作性
- 所有关键动作都要有明确状态、来源、结果
- 页面布局优先桌面端，移动端只做轻量查看，不作为主工作场景

### 1.3 视觉方向

- 参考气质：Notion 的信息秩序、Linear 的细腻、GitHub 的工程感、现代 AI 工作台的效率界面
- 关键词：clean、technical、minimal、structured、intelligent、editor-like、workspace-oriented
- 视觉语言：低饱和中性色背景 + 单一高识别蓝色主强调 + 语义化状态色

## 2. 页面信息架构

### 2.1 一级页面

1. Landing Page
2. Import Page
3. Parse Preview Page
4. Translation Workspace
5. Settings Page
6. Export Page

### 2.2 核心流程

1. 用户从 Landing 进入工作台或直接导入 Markdown
2. 在 Import 页面上传文件、配置模型和翻译参数
3. 在 Parse Preview 页面确认分块结构、跳过规则和块详情
4. 进入 Translation Workspace 执行翻译、审校、重翻、批注
5. 在 Export 页面导出 Markdown、批注、映射和日志
6. Settings 随时可进入，用于配置 API Key、Prompt、缓存和高级策略

### 2.3 推荐路由

- `/`
- `/import`
- `/preview/:taskId`
- `/workspace/:taskId`
- `/settings`
- `/export/:taskId`

### 2.4 全局导航结构

- 顶部导航负责全局入口和任务状态
- 左侧 Sidebar 负责当前模块切换
- 工作流型页面统一使用 App Shell
- Landing 独立于 App Shell，视觉更完整但仍保持克制

## 3. Figma 页面分帧建议

### 3.1 Figma 文件结构

建议按以下 Page 组织：

1. `00 Cover`
2. `01 Foundations`
3. `02 Landing`
4. `03 Import`
5. `04 Parse Preview`
6. `05 Workspace`
7. `06 Settings`
8. `07 Export`
9. `08 Components`
10. `09 Prototypes`

### 3.2 推荐 Frame

主工作台以桌面端为主，建议至少建立以下帧：

- `Desktop / Landing / 1440`
- `Desktop / App / 1440`
- `Desktop / Workspace / 1600`
- `Desktop / Workspace Dense / 1280`
- `Tablet / App / 1024`
- `Mobile / Status Only / 390`

### 3.3 栅格建议

- Landing：12 栏栅格，左右边距 80，栏距 24
- App 页面：12 栏栅格，左右边距 24，栏距 20
- Workspace 1600：使用固定三区布局，不强依赖栅格
- 常规内容最大宽度：1200
- 表单页与设置页可采用 8 栏内容栅格

### 3.4 Figma 组织方式

- 所有页面使用 Auto Layout
- Foundations 中建立 Variables：Color、Spacing、Radius、Elevation
- 组件全部做 Variant：size、theme、state、status
- 页面帧中只使用组件实例，不直接手工拼局部 UI

## 4. 全局布局方案

### 4.1 Landing 布局

- 顶部固定导航
- Hero 区域居中偏宽布局
- 核心能力卡片 3 列
- Workflow 区域横向步骤或纵向时间线
- DeepSeek 说明与三大卖点做成双栏
- CTA 区域放在 Hero 和底部各一次

### 4.2 App Shell 布局

App Shell 适用于 Import、Parse Preview、Workspace、Settings、Export。

结构：

- Top Toolbar：高度 64
- Secondary Progress Header：高度 44
- Main Body：可变
- Bottom Task Footer：高度 36 到 44

横向结构：

- Sidebar：240 宽，可收起至 72
- Main Content：自适应
- Context Panel/Drawer：360 到 420 宽，按页面需要出现

### 4.3 Workspace 布局

Translation Workspace 是核心页面，建议采用三层信息结构：

1. 顶层：任务信息、进度、导出、筛选、搜索
2. 中层：左右双栏块对照
3. 侧层：批注抽屉或块详情抽屉

推荐尺寸：

- 左栏原文：46%
- 中间 gutter：16
- 右栏译文：46%
- 批注抽屉展开后：右栏压缩或覆盖 360 宽抽屉

## 5. 每页模块拆分

## 5.1 Landing Page

### 页面目标

- 解释产品价值
- 建立专业可信的第一印象
- 引导用户进入导入流程或打开已有工作台

### 模块结构

1. Top Navigation
2. Hero Section
3. Core Capability Cards
4. Workflow Explanation
5. Three Selling Points
6. DeepSeek Translation Section
7. CTA Section
8. Footer

### Figma 层级建议

`Landing Frame`

- `Top Nav`
- `Hero`
- `Capabilities Grid`
- `Workflow`
- `Selling Points`
- `DeepSeek Section`
- `Bottom CTA`
- `Footer`

### Hero 内容建议

- Title：`Translate Markdown with structure intact`
- Subtitle：强调块级翻译、格式安全、审校与导出能力
- CTA Primary：`导入 Markdown`
- CTA Secondary：`打开工作台`
- 右侧可放产品预览 Mock：双栏翻译界面 + 批注抽屉

### 核心能力卡片

建议三列：

- 保留 Markdown 结构
- 块级重新翻译
- 审校、批注与导出

每张卡包含：

- 图标
- 标题
- 一句说明
- 次级描述或状态标签

### Workflow 区域

五步流程：

1. 导入文档
2. 解析块结构
3. 配置翻译
4. 审校与重翻
5. 导出结果

### DeepSeek 说明区

使用双栏：

- 左栏：引擎说明、为何适合技术文档
- 右栏：能力要点卡片，例如术语表、Prompt 控制、块级重试

## 5.2 Import Page

### 页面目标

- 提供明确、可信的导入体验
- 在“开始解析”前让用户确认翻译参数

### 模块结构

1. Progress Header
2. Page Header
3. File Upload Dropzone
4. File List Cards
5. Metadata Panel
6. Model Config Form
7. Language Direction Selector
8. Glossary Selector
9. Translation Style Selector
10. Parse Action Bar

### 页面布局建议

左右双栏：

- 左侧 7 栏：上传区域 + 文件列表
- 右侧 5 栏：配置表单

### 组件层级

`Import Page`

- `Progress Header`
- `Header Row`
- `Content Grid`
- `Upload Column`
- `Config Column`
- `Bottom Sticky Action Bar`

### 表单内容建议

- API Provider：固定 DeepSeek，只做说明
- Model：下拉选择
- Source Language：默认 English
- Target Language：默认 Chinese
- Style：严谨 / 自然 / 简洁 / 术语优先
- Glossary：下拉 + 新建入口
- Notes：多行输入
- Parse Strategy：按标题优先 / 按段落优先

## 5.3 Parse Preview Page

### 页面目标

- 让用户在翻译前理解文档被如何切块
- 避免用户在错误切块结构上直接进入翻译

### 页面布局

三栏布局：

- 左侧 260：文档结构树
- 中间自适应：块预览区
- 右侧 360：块详情面板

### 模块结构

1. Progress Header
2. Parse Summary Banner
3. Structure Tree
4. Block Preview List
5. Block Detail Panel
6. Footer Actions

### 中间块预览内容

每个块显示：

- 块类型图标
- 块 ID
- 源 Markdown 摘要
- 是否参与翻译
- 跳过原因

### 右侧详情面板内容

- Block ID
- Block Type
- Source Text Preview
- Translate Toggle
- Skip Reason
- Estimated Tokens
- Related Heading Path

### 底部操作区

- 次按钮：返回导入
- 主按钮：开始翻译

## 5.4 Translation Workspace

### 页面目标

- 支持块级翻译、比对、修订、批注和导出
- 降低“长文翻译不可控”的风险
- 让用户随时知道当前任务进度与异常位置

### 顶层布局

`Workspace Frame`

- `Top Toolbar`
- `Progress Header`
- `Workspace Filter Bar`
- `Content Area`
- `Task Footer`
- `Comment Drawer`
- `Prompt Preview Modal`
- `Export Modal`

### Top Toolbar 内容

- 左侧：Logo、任务名、文档路径、保存状态
- 中间：搜索、筛选、只看异常、只看已编辑、只看未翻译
- 右侧：重试失败、批量重翻、导出、设置、主题切换、用户菜单

### Progress Header 内容

- 整体进度条
- 已完成块数 / 总块数
- translating、failed、locked 数量
- 当前模型和 glossary 快照

### Workspace Filter Bar

用于高频操作，不应并入 Toolbar。

包含：

- View Mode：并排 / 仅译文 / 仅原文
- Sort：文档顺序 / 最近编辑 / 状态优先
- Density：comfortable / compact
- Jump To：按块 ID、标题、失败块

### 主体双栏布局

`Content Area`

- `Source Column`
- `Target Column`
- `Optional Right Drawer`

每一行对应一个 Markdown 块，左右严格对齐。

### 左栏原文块

每个块卡片包含：

- 块头部
- Markdown 源内容
- 块元信息
- 状态标签

块头部内容：

- 块类型图标
- Block ID
- Heading Path
- Tokens
- 状态标签

### 右栏译文块

每个译文块卡片包含：

- 块头部
- 译文内容区
- 审校标记层
- 块操作区

块操作按钮：

- 重译
- 锁定
- 复制
- 查看 Prompt

### 块卡片交互

- 点击卡片：整行进入 selected
- 左右块联动高亮
- 滚动时行锚点保持同步
- Hover 时显示轻量边框和操作按钮
- translating 状态显示顶部线性 loading 条

### 文本选择后的悬浮工具条

出现在译文块内部选中文本上方。

包含：

- 高亮
- 下划线
- 删除线
- 添加批注
- 清除样式

### 批注抽屉

从右侧滑出，支持固定展开。

包含：

- 当前块摘要
- 批注列表
- 按范围定位
- 创建批注输入框
- 批注筛选：未解决 / 全部 / 仅当前块

### 底部任务信息

用于显示持久性状态，不与 Toast 混用。

内容：

- 当前任务 ID
- 最后自动保存时间
- DeepSeek 请求状态
- 当前并发数
- 缓存命中率

### 重点状态设计

- translating：块顶部进度条、按钮置灰、状态徽标动效
- translated：绿色状态徽标 + 更新时间
- failed：红色边框弱提示 + 错误摘要 + 重试入口
- edited：琥珀色标记点，表示人工改动过
- locked：锁图标 + 中性灰状态
- retranslated：青色状态，显示“重新翻译于 xx:xx”

## 5.5 Settings Page

### 页面目标

- 提供所有翻译引擎与系统行为设置
- 清楚区分“基础配置”和“高级策略”

### 页面布局

建议两栏：

- 左侧 240：设置分组导航
- 右侧自适应：设置表单

### 分组结构

1. API & Auth
2. Model
3. Prompt
4. Glossary
5. Cache
6. Retry & Concurrency
7. Code Block Strategy
8. Reset Defaults

### 表单模块

- API Key 设置
- 模型设置
- System Prompt 设置
- Glossary 设置
- 缓存设置
- 重试与并发设置
- 代码块翻译策略设置
- 恢复默认设置按钮

### Prompt 区特别建议

由于产品存在“翻译 prompt”和“重新翻译 prompt”两条主链路，建议设置页中加入高级折叠区：

- 主翻译模板
- 重翻译模板
- 只读变量清单：`block_type`、`block_id`、`document_type`、`style`、`glossary`、`notes`、`source_text`
- 模板校验提示：是否包含必须变量

## 5.6 Export Page

### 页面目标

- 让用户明确知道导出的内容、格式与状态
- 支持分别导出 Markdown 与辅助文件

### 模块结构

1. Export Summary Header
2. Export Preview Panel
3. Export Options Grid
4. File Naming Section
5. Success Feedback Panel

### 导出项

- 导出 Markdown
- 导出批注 JSON
- 导出块映射
- 导出日志

### 页面布局

上半部分预览，下半部分操作。

- 左栏：导出文件预览
- 右栏：导出选项、命名、路径、确认按钮

### 成功提示

使用内嵌成功面板，不只用 Toast。

包含：

- 导出时间
- 导出路径
- 打开文件夹
- 再次导出

## 6. 关键组件设计

## 6.1 Sidebar

### 用途

承载工作流导航和任务级快捷入口。

### 层级结构

`Sidebar`

- `Brand`
- `Primary Nav List`
- `Task Shortcuts`
- `Divider`
- `Secondary Nav`
- `Storage/Quota Footer`

### 导航项建议

- Overview
- Import
- Parse Preview
- Workspace
- Export
- Settings

### 交互状态

- default：透明背景
- hover：浅色填充 + 文本提亮
- selected：强调色左边条 + 强调色弱底
- disabled：降低对比度

## 6.2 Top Toolbar

### 层级结构

`Top Toolbar`

- `Left Cluster`
- `Center Search`
- `Right Action Cluster`

### 交互要求

- Scroll 后增加半透明背景和底部分隔线
- 按钮 hover 使用 1 级 elevation
- 危险操作不放在主按钮组中

## 6.3 File Upload Dropzone

### 层级结构

`Dropzone`

- `Icon`
- `Primary Text`
- `Secondary Text`
- `Accepted Types`
- `Inline Actions`

### 状态

- default：虚线边框
- hover：边框亮起，背景轻微提亮
- dragging：强调色描边 + 大面积弱色底
- error：红色描边 + 错误文案
- disabled：降低透明度，禁止交互

## 6.4 Markdown Block Card

### 层级结构

`Markdown Block Card`

- `Card Header`
- `Content Body`
- `Meta Row`
- `Hidden Actions`

### Header

- Block Type Icon
- Block ID
- Heading Path
- Status Badge

### 状态视觉

- default：细边框
- hover：边框增强
- selected：外发光或强调色描边
- skipped：灰色标签 + 原因提示
- failed：错误角标或左边线

## 6.5 Translation Block Card

### 层级结构

`Translation Block Card`

- `Card Header`
- `Translation Content`
- `Annotation Overlay`
- `Action Row`
- `History Hint`

### Action Row

- Re-translate Button
- Lock Toggle
- Copy Button
- Prompt Button

### 特别要求

- 支持富文本标记层与原始 Markdown 数据解耦
- 选区高亮不应破坏底层块布局

## 6.6 Status Badge

### 类型

- parsing
- translating
- translated
- failed
- edited
- locked
- skipped
- retranslated

### 视觉建议

- 统一高度 24
- 左图标 12
- 文本 12/16 Medium
- 角半径 999

## 6.7 Progress Header

### 层级结构

`Progress Header`

- `Title Group`
- `Progress Track`
- `Metrics Chips`
- `Task Meta`

### 指标建议

- 进度百分比
- 已翻译块数
- 失败块数
- 跳过块数
- 锁定块数

## 6.8 Re-translate Button

### 类型

- default
- loading
- success
- disabled

### 行为建议

- 默认是次强调按钮
- 执行时切换 spinner + `Re-translating`
- 成功后短暂显示 `Updated`
- 锁定块上默认禁用

## 6.9 Inline Formatting Toolbar

### 层级结构

`Inline Toolbar`

- `Highlight`
- `Underline`
- `Strike`
- `Comment`
- `Clear`

### 交互要求

- 浮层出现在选区上方
- 自动避让页面边界
- 进入时淡入 + 上移 4px
- 失焦后 120ms 消失

## 6.10 Comment Drawer

### 层级结构

`Comment Drawer`

- `Drawer Header`
- `Block Context`
- `Filter Tabs`
- `Comment List`
- `Composer`

### Comment Item

- 作者
- 时间
- 状态
- 关联文本范围
- 正文
- 回复入口

## 6.11 Prompt Preview Modal

### 用途

查看当前块实际发送给翻译引擎的 prompt。

### 层级结构

`Prompt Preview Modal`

- `Header`
- `Mode Tabs`
- `Prompt Sections`
- `Token Estimation`
- `Footer Actions`

### Tabs 建议

- Translation Prompt
- Retranslation Prompt
- Raw Payload

### 内容块

- System Instruction
- Block Metadata
- Glossary
- Notes
- Source Text

## 6.12 Export Modal

### 层级结构

`Export Modal`

- `Header`
- `Format Options`
- `File Selection`
- `Destination`
- `Footer Actions`

## 6.13 Settings Form Panel

### 层级结构

`Settings Form Panel`

- `Panel Header`
- `Field List`
- `Inline Help`
- `Validation Message`
- `Sticky Save Bar`

## 6.14 Glossary Table

### 层级结构

`Glossary Table`

- `Toolbar`
- `Header Row`
- `Body Rows`
- `Pagination / Footer`

### 列建议

- Source Term
- Target Term
- Category
- Status
- Updated At

## 6.15 Chunk Mapping Inspector

### 用途

帮助用户查看块与块之间的一一对应关系，以及源文档结构定位。

### 层级结构

`Chunk Mapping Inspector`

- `Inspector Header`
- `Tree Map`
- `Selected Pair Detail`
- `Diff Hint`

## 7. 颜色建议

## 7.1 Dark Theme

### 中性色

- `bg.canvas`: `#0D1117`
- `bg.surface.1`: `#111827`
- `bg.surface.2`: `#161B22`
- `bg.surface.3`: `#1F2937`
- `border.default`: `#2B3544`
- `border.strong`: `#3B4658`
- `text.primary`: `#E6EDF3`
- `text.secondary`: `#9FB0C3`
- `text.tertiary`: `#748399`

### 强调色

- `accent.primary`: `#4C8DFF`
- `accent.hover`: `#6AA0FF`
- `accent.soft`: `#152845`
- `accent.focus`: `#99BEFF`

### 语义色

- `success`: `#2FBF71`
- `success.soft`: `#12281D`
- `warning`: `#E5A83D`
- `warning.soft`: `#2A2112`
- `danger`: `#E05D6F`
- `danger.soft`: `#30161B`
- `info`: `#36B3D9`
- `info.soft`: `#10242A`

## 7.2 Light Theme

- `bg.canvas`: `#F6F8FB`
- `bg.surface.1`: `#FFFFFF`
- `bg.surface.2`: `#F2F5F9`
- `bg.surface.3`: `#E9EEF5`
- `border.default`: `#D8E0EA`
- `border.strong`: `#BECAD8`
- `text.primary`: `#0F172A`
- `text.secondary`: `#475569`
- `text.tertiary`: `#64748B`
- `accent.primary`: `#2563EB`
- `accent.hover`: `#1D4ED8`
- `accent.soft`: `#DBEAFE`

## 7.3 状态映射

- translating：蓝色
- translated：绿色
- failed：红色
- edited：琥珀色
- locked：灰色
- retranslated：青色
- skipped：中性灰蓝

## 8. 字体层级建议

## 8.1 字体组合

- UI 字体：`IBM Plex Sans`
- 代码/块 ID/Prompt：`JetBrains Mono`

原因：

- `IBM Plex Sans` 兼具工程感和可读性，适合密集信息界面
- `JetBrains Mono` 适合 Markdown、Prompt、Token、路径、块 ID 等技术信息

## 8.2 字号层级

- Display 48/56 SemiBold
- H1 36/44 SemiBold
- H2 28/36 SemiBold
- H3 22/30 Medium
- H4 18/26 Medium
- Body L 16/26 Regular
- Body M 14/22 Regular
- Body S 13/20 Regular
- Label 12/16 Medium
- Mono M 13/20 Medium
- Mono S 12/18 Medium

## 8.3 使用建议

- Landing Hero 使用 Display 或 H1
- App 页面标题使用 H3 或 H4
- 卡片正文以 Body M 为主
- 所有状态标签与工具栏按钮使用 Label
- Prompt、ID、路径、代码块摘要使用 Mono

## 9. 间距系统建议

## 9.1 基础尺度

采用 4pt 基础单位。

- 4：超紧凑内边距
- 8：图标与文案间距
- 12：表单控件内部间距
- 16：常规卡片内边距
- 20：工作台块卡片内边距
- 24：页面模块间距
- 32：大区块间距
- 40：Landing 区域内部大间距
- 64：页面主区块分隔

## 9.2 圆角系统

- 8：输入框、badge、小按钮
- 12：卡片、表单面板
- 16：大卡片、Modal
- 999：pill 状态和标签

## 9.3 阴影系统

- `shadow.sm`: 0 2 8 rgba(0,0,0,0.18)
- `shadow.md`: 0 8 24 rgba(0,0,0,0.22)
- `shadow.lg`: 0 16 40 rgba(0,0,0,0.28)

Dark theme 中阴影应更弱，更多依靠边框和层次差。

## 10. 状态系统建议

## 10.1 全局交互状态

- default
- hover
- selected
- translating
- translated
- failed
- edited
- locked
- retranslated
- disabled

## 10.2 关键组件反馈规则

### Block Card

- default：`border.default`
- hover：`border.strong` + `bg.surface.2`
- selected：`accent.primary` 描边 + 弱色底
- translating：顶部蓝色进度线 + spinner
- translated：绿色 badge
- failed：左侧红线 + 错误摘要
- edited：卡头显示琥珀色圆点
- locked：锁图标 + 按钮禁用
- retranslated：青色 badge + 更新时间

### Button

- default：实色或描边
- hover：亮度提高 6% 到 8%
- pressed：向下位移 1px 或减弱阴影
- loading：spinner 替代左图标
- disabled：透明度降低到 40%，无阴影

### Dropzone

- dragging：边框变为 `accent.primary`，背景切到 `accent.soft`
- error：`danger` 描边，错误信息常驻直到修复

### Drawer / Modal

- open：背景遮罩 40% 到 56%
- focus：内部第一个可编辑控件自动 focus
- error：标题栏或字段区展示错误摘要

## 10.3 状态数据字段建议

块级状态建议至少包含：

```ts
type BlockStatus =
  | "idle"
  | "queued"
  | "translating"
  | "translated"
  | "failed"
  | "edited"
  | "locked"
  | "retranslated"
  | "skipped";
```

块数据建议：

```ts
type TranslationBlock = {
  id: string;
  type: string;
  headingPath: string[];
  sourceMarkdown: string;
  translatedMarkdown: string;
  status: BlockStatus;
  locked: boolean;
  skipped: boolean;
  skipReason?: string;
  annotationsCount: number;
  tokenEstimate?: number;
  lastTranslatedAt?: string;
  lastEditedAt?: string;
  errorMessage?: string;
  promptSnapshotId?: string;
};
```

## 11. 与翻译引擎 Prompt 的设计对齐

你提供的翻译/重翻译 Prompt 说明会直接影响前端设计，建议在界面中体现这些约束。

### 11.1 Prompt Preview Modal 必须展示的变量

- `block_type`
- `block_id`
- `document_type`
- `style`
- `glossary`
- `notes`
- `source_text`
- `retranslation_goal`
- `current_translation`
- `focus`

### 11.2 Workspace 中需要显式暴露的能力

- 查看当前块 prompt
- 查看当前块为何被跳过
- 标记代码块翻译策略
- 针对单块做“重翻译目标”输入
- 保留“当前译文”和“新译文”的比对入口

### 11.3 Settings 中需要增加的安全校验

- Prompt 模板变量完整性校验
- 是否包含 `source_text`
- 是否误删了结构安全规则
- 是否对代码块、URL、路径翻译规则做了破坏性改写

## 12. 工程实现的设计规范摘要

## 12.1 建议的前端结构

- `layouts`: `LandingLayout`、`AppShell`
- `pages`: `LandingPage`、`ImportPage`、`ParsePreviewPage`、`WorkspacePage`、`SettingsPage`、`ExportPage`
- `components/navigation`
- `components/workspace`
- `components/import`
- `components/export`
- `components/settings`
- `components/feedback`
- `components/overlays`

## 12.2 组件职责划分

- `Sidebar`: 只管理导航，不承载任务详情
- `ProgressHeader`: 只显示全局任务进度，不处理块操作
- `MarkdownBlockCard`: 只负责原文展示
- `TranslationBlockCard`: 负责译文展示、状态、块级操作和审校入口
- `CommentDrawer`: 只处理批注流，不负责块状态切换
- `PromptPreviewModal`: 只读查看，不直接编辑模板

## 12.3 建议的设计 Token 命名

```ts
color.bg.canvas
color.bg.surface.1
color.border.default
color.text.primary
color.text.secondary
color.accent.primary
color.status.success
color.status.warning
color.status.danger
space.1
space.2
space.3
radius.sm
radius.md
radius.lg
shadow.sm
shadow.md
```

## 12.4 响应式建议

- 1440 以上：完整三栏和双栏对照
- 1280 到 1439：Sidebar 可收起，抽屉覆盖式展开
- 1024 到 1279：Workspace 改为 tab 切换原文/译文
- 小于 768：仅建议查看任务状态和导出，不建议执行审校工作

## 12.5 前端落地注意点

- 块卡片必须支持虚拟列表，否则长文性能会明显下降
- 左右块联动滚动要避免完全绑定，建议采用锚点同步而非逐像素同步
- 审校标记层应与 Markdown 渲染层分离，避免直接污染源文本
- Prompt 查看、重翻译、批注都应是非破坏式操作
- 导出前要显示最终结构校验状态，例如标题、链接、代码块是否完整

## 13. 最终建议

如果后续要进入高保真制作，推荐先在 Figma 中完成以下最小集合：

1. `Foundations`：颜色、字体、间距、阴影、状态色
2. `Components`：Button、Input、Badge、Card、Drawer、Modal、Toolbar
3. `Workspace`：先做完整桌面版，再派生 Import、Preview、Export
4. `Prototype`：串联 Import -> Preview -> Workspace -> Export 主流程

这样能保证页面不是“单页视觉稿”，而是一套能稳定扩展的工作台系统。
