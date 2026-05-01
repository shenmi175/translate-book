# Translate Book

一个面向长文档的 Markdown / EPUB 翻译工具，包含：

- 后端任务引擎
- Web 管理界面
- 块级翻译、重试、导出
- EPUB 解析、结构保持与回写导出

项目适合以下场景：

- 把英文技术书、研究资料、课程讲义翻译成中文
- 对 EPUB 进行分块翻译而不是整本粗暴替换
- 需要可视化查看进度、失败块和导出结果

## 功能特性

- 支持 `Markdown` 和 `EPUB`
- Markdown 基于 AST 解析
- EPUB 基于 XHTML / OPF / spine 解析
- 块级翻译、单块重译、失败块批量重试
- 导出 `Markdown`、双语 Markdown、`PDF`、双语 PDF、`EPUB`、双语 EPUB
- API Key 统一写入 `.env` 并立即生效，旧版 SQLite Key 会自动迁移清理
- 支持反向代理、公开访问地址和子路径部署
- 前端支持中文 / English 双语界面实时切换
- 前端和后端可本地开发，也支持 Docker 一键部署
- Docker 镜像内已包含 Chromium 和 Noto CJK 字体，中文 PDF 导出可直接使用
- 任务状态默认持久化到 `server/data/app.sqlite`，重启后不会丢失
- 块内容已拆分到独立 SQLite 表，任务搜索优先走 SQLite FTS

## 技术说明

- 后端：Node.js 原生 HTTP 服务
- 持久化：SQLite (`server/data/app.sqlite`) + 任务资产目录 (`server/data/tasks`)
- 前端：React + Vite
- EPUB 工具链：Python 3
- 翻译接口：兼容 OpenAI Chat Completions 或 Responses 协议的提供商

当前默认配置偏向 DeepSeek，但也可以接到其他兼容网关；如果你的代理要求 `/v1/responses`，在设置里把接口协议切到 `Responses` 即可。

## 快速开始

### 一键脚本

项目现在提供统一入口脚本：

```bash
./scripts/install-run.sh
```

默认行为：

- 如果当前机器可用 Docker，就直接走 Docker 模式
- 如果 Docker 不可用，就切换到本机模式

常用示例：

```bash
# Docker 一键构建并启动
./scripts/install-run.sh --docker

# Docker 启动后直接跟日志
./scripts/install-run.sh --docker --logs

# 本机一键安装依赖并启动
./scripts/install-run.sh --native

# 本机开发模式（API + Vite）
./scripts/install-run.sh --native --dev
```

说明：

- `--native` 模式会自动安装 npm 依赖
- 在 Debian / Ubuntu 上，脚本会尝试通过 `apt-get` 安装 `python3`、`pandoc`、`fontconfig`、`fonts-noto-cjk`、`poppler-utils`，以及可用的 Chromium 包
- `Node.js 22+` 仍然需要你自己预先安装，脚本不会擅自替你切换 Node 版本

### 30 秒上手

如果你只是想最快把应用跑起来，按下面 4 步做：

1. 准备一个可用的上游模型 `API Key`
2. 执行 `./scripts/install-run.sh --docker`
3. 执行 `cat server/data/runtime/access-token`，复制自动生成的访问令牌
4. 打开 `http://localhost:8787`，先粘贴访问令牌，再去“设置”页填 `API Base URL`、`Model` 和 `API Key`，点击“保存引擎配置”后会自动写入 `.env`

如果你想启动前就固定 API Key，也可以提前创建 `.env`：

```dotenv
MARKDOWN_TRANSLATOR_API_KEY=your_api_key
PORT=8787
```

说明：

- `MARKDOWN_TRANSLATOR_API_KEY` 必须由你的模型服务商提供，项目不会自动生成它
- `MARKDOWN_TRANSLATOR_ACCESS_TOKEN` 可以不写，容器首次启动时会自动生成
- 如果你已经手动写了 `MARKDOWN_TRANSLATOR_ACCESS_TOKEN`，应用就直接使用你提供的值

### 第一次启动后你会看到什么

Docker 首次启动成功后，建议按这个顺序操作：

1. 执行 `docker logs --tail 50 translate-book`
2. 执行 `cat server/data/runtime/access-token`
3. 浏览器打开 `http://localhost:8787`
4. 页面会先要求输入访问令牌
5. 输入后进入应用，再去“设置”页补全模型配置
6. 返回“新建任务”页上传 `.md` 或 `.epub`
7. 创建任务后进入详情页开始翻译
8. 翻译完成后从右上角导出 `Markdown`、`PDF`、`EPUB` 或双语版本

### 方式一：Docker 一键部署

这是最适合直接使用的方式。

1. 准备环境变量

仓库根目录可直接放一个 `.env`：

```dotenv
MARKDOWN_TRANSLATOR_API_KEY=your_api_key
MARKDOWN_TRANSLATOR_ACCESS_TOKEN=
PORT=8787
```

也可以不写 `.env`，启动后在 Web 设置页里填入。

如果你准备把服务暴露到公网，建议同时设置：

```dotenv
MARKDOWN_TRANSLATOR_ACCESS_TOKEN=replace-this-with-a-long-random-token
```

设置后，除 `/api`、`/api/docs`、`/api/openapi.yaml` 外，其余 API 都需要携带访问令牌。

如果你没有提供 `MARKDOWN_TRANSLATOR_ACCESS_TOKEN`，容器会在首次启动时自动生成一个高强度访问令牌，并持久化到：

```text
./server/data/runtime/access-token
```

你可以用下面这条命令直接查看并复制：

```bash
cat server/data/runtime/access-token
```

2. 启动

```bash
./scripts/install-run.sh --docker
```

`docker-compose.yml` 会自动把容器内可写 `.env` 指向 `./server/data/runtime/.env`，所以你在设置页保存的 API Key 会跟随 `server/data` 持久化；如果访问令牌为空，entrypoint 会在第一次启动时自动生成并落盘。

3. 打开页面

- Web UI: `http://localhost:8787`
- Health: `http://localhost:8787/health`
- API Root: `http://localhost:8787/api`

4. 停止

```bash
docker compose down
```

默认会把 `./server/data` 挂载到容器内，用于持久化 SQLite 状态库、任务数据和导出所需的临时文件。

当前持久化文件和目录：

- `server/data/app.sqlite`
  任务列表、块状态、设置、导出队列等元数据
- `server/data/tasks`
  EPUB 解析后的源文件和任务资产
- `server/data/export-cache`
  异步导出的缓存产物

如果你是从旧版本升级过来，并且目录里还存在旧的 `server/data/db.json`，应用首次启动时会自动把它迁移到 `app.sqlite`，之后不再继续使用 `db.json`。

首次启动后建议再执行一次：

```bash
cat server/data/runtime/access-token
```

这个文件里的值就是当前实例使用的访问令牌。只要你不手动删除该文件，后续重启会一直复用同一个值。

### 方式二：本地开发

要求：

- Node.js `22+`
- Python `3.10+`
- 如果要本地导出中文 / 日文 / 韩文 PDF，建议额外安装 `Chromium` 或 `Chrome` 和 CJK 字体

安装依赖：

```bash
npm install
npm install --prefix web
```

如果你想让脚本把依赖安装和启动一起处理，直接执行：

```bash
./scripts/install-run.sh --native
```

如果你已经手动装好了依赖，只想直接启动，可以执行：

```bash
./scripts/install-run.sh --native --no-install
```

启动开发环境：

```bash
./scripts/install-run.sh --native --dev
```

默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:8787`

注意：

- 本地开发模式不会走 Docker entrypoint，所以不会自动生成访问令牌
- 如果你需要访问保护，可以在设置页手动填写访问令牌，或者在启动前自己设置 `MARKDOWN_TRANSLATOR_ACCESS_TOKEN`
- 本地如果没有可用的 Chromium / Chrome，CJK PDF 导出会明确报错，而不是继续生成乱码 PDF

## 配置项

项目支持以下 API Key 来源，优先级从高到低：

1. 进程环境变量
2. 本地 `.env`
3. 旧版 SQLite Key 回退，启动后会自动迁移到 `.env` 并清理

支持读取的环境变量名：

- `MARKDOWN_TRANSLATOR_API_KEY`
- `DEEPSEEK_API_KEY`
- `TRANSLATOR_API_KEY`

常用环境变量：

```dotenv
MARKDOWN_TRANSLATOR_API_KEY=
MARKDOWN_TRANSLATOR_DOTENV_PATH=
MARKDOWN_TRANSLATOR_ACCESS_TOKEN=
PORT=8787
```

访问令牌支持来源：

1. 当前后端会话内保存的访问令牌
2. 进程环境变量 `MARKDOWN_TRANSLATOR_ACCESS_TOKEN`
3. 本地 `.env`

访问令牌的用途：

- 保护任务列表、任务详情、导出、设置等敏感 API
- 防止把应用挂到公网后被任何人直接枚举和下载文档内容

访问令牌不是模型 `API Key`，它们是两个完全不同的东西：

- `API Key`：用来访问上游模型服务
- `Access Token`：用来保护你自己部署的这个应用

设置页里的反代相关配置：

- `publicBaseUrl`
  用于声明最终对外访问地址，例如 `https://books.example.com`
  或 `https://books.example.com/translator`
- `trustProxyHeaders`
  开启后会信任 `X-Forwarded-Host`、`X-Forwarded-Proto`、`X-Forwarded-Prefix`
  这些头，一般只在 Nginx / Caddy / Traefik 等可信反代后启用

说明：

- 通过设置页“保存引擎配置”写入的 API Key 会直接保存到 `.env` 并立即生效
- Docker 模式默认把 `.env` 写到已挂载的 `./server/data/runtime/.env`，重建容器后仍然可用
- 访问令牌仍可保存在 SQLite；只有你显式点击“写入 .env”时才会同步到本地文件，且该操作仍限制为服务器本机请求

## 使用流程

### 第一次使用 Web 界面

对于第一次接触这个项目的用户，推荐按照下面顺序点击：

1. 打开应用首页
2. 如果出现“访问令牌”弹窗，先输入访问令牌
3. 点击左侧“设置”
4. 填写以下最关键的 4 个字段：
   - `API Provider`
   - `API Base URL`
   - `Model`
   - `API Key`
5. 点击“保存到当前会话”
6. 返回左侧“新建任务”
7. 上传一个 `.epub` 或 `.md`
8. 进入任务详情页后点击“开始全文翻译”
9. 翻译完成后点击右上角“导出”

如果你使用 LiteLLM / OpenAI 兼容网关，`API Base URL` 通常应该是类似下面这种根地址：

```text
http://127.0.0.1:4000/v1
https://your-gateway.example.com/v1
```

后端会自动拼接 `/chat/completions`，不要手动再补一层。

### 任务页怎么用

任务详情页里最常用的几个功能：

- 右上角 `导出`
  翻译完成后导出 Markdown / PDF / EPUB，EPUB 任务还支持双语 EPUB
- `双语对照 / 仅原文 / 仅译文`
  切换阅读模式
- `分页模式 / 长卷滚动`
  控制任务页的浏览方式
- 左侧固定错误面板
  在宽屏下可直接点击“上一个错误 / 下一个错误 / 重试全部”
- 失败块上的 `确认 / 忽略 / 重试`
  用于处理模型返回不稳定、结构校验失败或翻译质量问题

如果某个 EPUB 失败块显示“模型原始返回但未通过结构校验”，说明系统已经保留了原始模型输出，但为了避免写坏 EPUB，不会允许你直接确认写回；这时优先使用“重试”。

### 导出行为说明

- 纯译文导出不会再把未翻译块悄悄回退成原文
- 如果某个可翻译块尚未完成，导出文件会写入显式占位标记，方便人工检查
- 双语 Markdown 即使“原文和译文完全相同”，也会保留两侧内容，不再静默丢掉目标侧
- 双语 EPUB 会保留原文块，并在原文块后插入对应译文块；纯译文 EPUB 则会用译文替换原块
- 导出文件名会跟随目标语言，例如 `book.en.pdf`、`book.zh-CN.epub`

### EPUB 说明

本项目不是把整本 EPUB 作为纯文本直接送给模型，而是：

1. 解包 EPUB
2. 读取 `META-INF/container.xml`
3. 解析 `content.opf`
4. 根据 spine 顺序读取 XHTML 内容
5. 按块提取可翻译文本
6. 回写翻译结果并重新打包导出

对含有大量脚注、斜体、链接等内联 XHTML 的复杂段落，后端会优先使用占位符模式：

- 把脚注、链接、斜体等结构转换为 `[[MTS_*]]` 占位符
- 只让模型翻译带占位符的可读文本
- 校验占位符数量与顺序
- 再由后端把占位符还原为原 XHTML 结构

这样做的目标是尽量保持：

- 目录结构
- XHTML 标签结构
- 资源引用
- 图片、链接、章节顺序

## 部署方式

### 单容器模式

Docker 镜像会：

- 构建前端静态资源
- 运行后端 API
- 直接由后端托管 `web/dist`

所以生产环境只需要一个容器和一个端口。

### Docker Compose

最常用命令：

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

查看当前实例访问令牌：

```bash
cat server/data/runtime/access-token
```

强制重新生成访问令牌：

```bash
rm -f server/data/runtime/access-token
docker compose restart
```

如果你想固定一个自定义访问令牌，不要删文件后等它自动生成，直接在宿主机 `.env` 里写：

```dotenv
MARKDOWN_TRANSLATOR_ACCESS_TOKEN=your-own-long-random-token
```

### 反向代理部署

如果你打算通过域名访问，或者挂到子路径下，例如：

- `https://books.example.com`
- `https://books.example.com/translator`

推荐这样配置：

1. 先在应用设置页填写 `publicBaseUrl`
2. 如果代理会带 `X-Forwarded-*` 头，再开启 `trustProxyHeaders`
3. 将设置页生成的 Nginx / Caddy 示例复制到你的反代配置里

当前版本已经支持：

- 反代后的公开地址推导
- `X-Forwarded-Prefix` 子路径访问
- 前端路由与 API 路径自动跟随公开前缀

### 手动构建镜像

```bash
docker build -t translate-book .
docker run -d \
  --name translate-book \
  -p 8787:8787 \
  -e MARKDOWN_TRANSLATOR_API_KEY=your_api_key \
  -v $(pwd)/server/data:/app/server/data \
  translate-book
```

## 点对点测试

### 1. 后端 EPUB 冒烟测试

```bash
npm run test:epub
```

这个测试会验证：

- EPUB 解析
- 块映射
- 翻译片段应用
- EPUB 导出
- 状态接口默认瘦身返回

### 2. 导出与命名回归测试

```bash
npm run test:exports
```

这个测试会验证：

- 纯译文导出对未完成块使用显式占位符
- 双语 Markdown 不再丢失“原文 = 译文”的目标侧
- Markdown / PDF / EPUB 导出文件名跟随目标语言

### 3. 全量测试

```bash
npm test
```

### 4. 手工验证上传链路

启动服务后上传一个 `.epub`，然后在浏览器开发者工具里确认：

- 创建任务请求为 `POST /api/tasks?filename=...&documentFormat=epub`
- 请求体是原始二进制
- 不再是巨大的 `contentBase64` JSON

### 5. 手工验证状态接口

在任务详情页观察请求：

- 分页模式只拉当前页
- 长卷模式按页追加加载
- 默认状态响应不再返回整份全量 `blocks`

### 6. 手工验证导出

导出 EPUB 时应直接命中：

```text
/api/tasks/:taskId/exports/epub?download=1
```

导出双语 EPUB 时应使用异步导出任务或选择前端菜单里的 `EPUB 双语`，对应格式为：

```text
epub_bilingual
```

浏览器会直接下载文件，而不是先收一个巨大的 base64 JSON。

### 7. 手工验证反向代理

1. 在设置页把 `publicBaseUrl` 设成你的最终访问地址
2. 如有 Nginx / Caddy，按设置页示例加上 `X-Forwarded-Host`、`X-Forwarded-Proto`
3. 如果挂在子路径下，再加 `X-Forwarded-Prefix`
4. 访问代理后的地址，确认：

- 首页能打开
- 刷新任务详情页不会 404
- 上传、轮询、导出都走代理域名
- 任务导出链接不是裸露的后端内网地址

### 8. 手工验证访问令牌保护

1. 在设置页填入访问令牌并保存，或写入 `.env`
2. 打开一个新的无痕窗口访问站点
3. 首次进入时应弹出访问令牌输入框
4. 未携带令牌时，任务列表、任务详情、导出接口都应返回 `401`
5. 填入正确令牌后，上传、轮询、导出应恢复正常

### 9. 手工验证双语切换

打开左侧栏的语言切换按钮：

- `中文`
- `English`

切换后应立即生效，包括：

- 导航
- 首页上传提示
- 任务列表
- 任务详情页状态和操作按钮
- 设置页与反代说明

## 目录结构

```text
.
├─ server/                  后端服务
│  ├─ index.js              HTTP 入口
│  └─ lib/                  任务、翻译、EPUB、PDF 等核心逻辑
├─ web/                     React 前端
├─ scripts/
│  ├─ dev.mjs               本地开发启动脚本
│  ├─ epub_tool.py          跨平台 EPUB 工具
│  └─ epub_tool.ps1         Windows 兼容 EPUB 工具
├─ docs/                    API 与设计文档
├─ Dockerfile
└─ docker-compose.yml
```

## 常见问题

### 1. Docker 已启动，但无法翻译

通常是 API Key 未配置。

检查：

- 容器环境变量里是否有 `MARKDOWN_TRANSLATOR_API_KEY`
- 或者进入 Web 设置页重新保存 Key

### 2. 第一次打开页面就要求访问令牌，但我不知道令牌是什么

如果你没有在 `.env` 里手动指定访问令牌，Docker 容器会在首次启动时自动生成一个，并写入：

```bash
cat server/data/runtime/access-token
```

把它复制到浏览器弹窗即可。

### 3. 公网部署后接口不通或导出提示未授权

优先检查：

- 是否已经配置 `MARKDOWN_TRANSLATOR_ACCESS_TOKEN`
- 浏览器是否已在弹窗或设置页保存访问令牌
- 反向代理是否允许 `Authorization` 请求头透传
- 如果是跨域访问，代理是否允许 `Content-Disposition` 响应头透出

### 4. EPUB 上传很慢

新版本已经把上传方式改成二进制直传。

如果仍然慢，优先检查：

- 浏览器与服务器之间的网络
- 宿主机磁盘性能
- 模型接口本身延迟

### 5. 前端页面打不开

如果是 Docker 部署，确认：

- `docker compose ps` 显示容器已运行
- `http://localhost:8787/health` 返回正常

如果是本地开发，确认：

- `npm run dev` 已同时启动前后端
- 前端在 `5173`
- 后端在 `8787`

### 6. EPUB 导出失败

优先检查：

- 源 EPUB 是否包含非标准 XHTML
- 失败块是否存在结构异常
- 任务是否是旧容器/旧本地路径创建的；当前版本会自动修复常见的 stale asset 绝对路径，如果仍提示 assets missing，建议重新导入或重解析 EPUB
- 后端日志里的 `epub_processing_failed`

### 7. 某些 EPUB 块反复提示 “returned N EPUB segments, expected M”

这通常不是文件损坏，而是模型偶尔没有按要求返回正确数量的段。

当前版本已经做了多层处理：

- 更宽松地解析常见的包裹格式
- 在必要时自动发起一次“修复格式”的二次请求
- 对复杂内联 XHTML 段落自动切换到占位符模式，减少模型合并/漏掉脚注段导致的失败

如果仍然失败，建议：

1. 先点击失败块上的“重试”
2. 检查该块是否过长、是否包含大量脚注或内联标签
3. 降低模型温度，或换一个更稳定的模型
4. 查看后端日志，确认是不是上游网关对 JSON 输出做了额外包装

## 开发说明

本地开发建议：

```bash
npm run dev
```

仅启动后端：

```bash
npm run dev:api
```

仅启动前端：

```bash
npm run dev:web
```

## 版本与目标

当前版本重点是：

- 修复 EPUB 可用性
- 降低长文档上传、轮询、导出的额外开销
- 提供更可靠的 Docker 部署方式

后续仍可继续完善：

- 更强的 EPUB 兼容测试集
- 更细粒度的状态增量推送
- 更多提供商适配

## License

如需公开发布到 GitHub，建议在仓库中补充正式的 `LICENSE` 文件。
