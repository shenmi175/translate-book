# Request API 状态及补充建议

非常感谢，前置要求的所有接口已在后端全部实现！前端现已成功对齐并集成了所有控制及可视化功能。

## ✅ 已满足的 API (前端已完整接入)
1. **获取单块**：`GET /api/tasks/:taskId/blocks/:blockId` (避免全量刷新，极大地优化了双列可视化)
2. **任务控制**：`POST /api/tasks/:taskId/pause`, `POST /api/tasks/:taskId/cancel`
3. **任务管理**：`DELETE /api/tasks/:taskId` (配合网格删除键)
4. **动态统计**：`GET /api/tasks/:taskId/status` (已成功提取 `translatedWordCount`, `translationSpeed` 等用于前端 Neumorphism 仪表盘展示)
5. **模型设置**：`GET / PUT /api/settings` (支持前端 DeepSeek 用户配置项保存)

## 💡 未来可选的增值 API (低优先级)

如果希望这个平台进一步商业化或者提供更强的工具链，可以在后续考虑：

1. **批量重译接口 (Batch Retranslate)**
   - 接口：`POST /api/tasks/:taskId/blocks/retranslate-batch`
   - 作用：允许用户在 Frontend 勾选多个有瑕疵的 Block 一键重投。
   
2. **更多格式导出 (Export Extensibility)**
   - 接口：`GET /api/tasks/:taskId/exports/pdf` 等
   - 作用：除了 Markdown，支持一键下载带排版的 PDF。
