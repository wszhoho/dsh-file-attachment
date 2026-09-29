# 更新日志

本插件更新日志遵循 Keep a Changelog 风格，版本号遵循语义化版本。

## [0.5.13] - 2026-09-28

### 变更

- **支持 DSH 0.2.0-rc.1**：`peerDependencies` 中 `@deepseek-ai/dsh` 的版本范围新增 `>=0.2.0-rc.1 <0.3.0-0`，DSH 0.2.0-rc.x 用户可直接安装本插件，无需再手动跳过 peer 依赖校验。

## [0.5.12] - 2026-09-28

### 变更

- **npm 搜索优化**：扩充 `keywords` 与 `description`（file-upload、drag-drop、image-preview、thumbnail、lightbox、vlm、multimodal、openai-compatible 等检索词），在 npm 中搜索相关关键词时更容易命中。
- **README 双语化**：补充英文说明，方便非中文用户了解功能与安装方式。

## [0.5.11] - 2026-09-28

### 新增

- **历史消息操作行（时间 + 复制）**：用户消息（FaUserMessage）下方新增 actions 行，显示消息发送时间与复制按钮，便于查看时间戳与一键复制消息文本。

### 修复

- **修复 dsh 重启后历史消息操作行丢失的问题**：此前重启后历史对话区用户消息的时间 / 复制操作行会丢失，现已恢复正常渲染。

## [0.5.10] - 2026-09-28

### 变更

- **图片识别结果移除「思考模式」后缀**：`describe_image` 在 UI 中的展示由 `图片识别结果：…（思考模式：开启/关闭）` 简化为 `图片识别结果：…`，结果文本更干净，不再附带思考模式状态。

### 修复

- **修复历史对话区复制按钮未显示的问题**。

## [0.5.9] - 2026-09-21

### 修复

- **移动端双📎按钮兼容**：dsh-web-mobile 插件（移动端适配）向 composer 的 `conversation.input.left` 槽注入自己的文件回形针按钮，其设计前提是 host 0.1.6-alpha.2+ 已删除 composer 原生📎；但当前 host（0.1.5-rc.x）仍渲染原生📎按钮，移动端窄屏下于是并排出现两枚回形针（PC 宽屏被 dsh-web-mobile 的 `pointer:fine` 隐藏规则覆盖，故仅移动端可见）。本插件现按 host 原生📎是否存在自动对调：原生📎在（0.1.5-rc.x）→ 内联 `display:none!important` 隐藏 dsh-web-mobile 注入的那枚（保留原生位置）；原生📎不在（0.1.6+，未来 host 移除后）→ 移除内联声明交还 CSS，让 mobile 注入按钮作为唯一入口。两枚按钮点击后都触发 host 的 hidden `input[type=file]`，其 change 事件已被本插件劫持走 runBatch 管线，上传功能不受影响。判断依据：host 原生📎是 card 内 hidden fileInput 的前邻 button，0.1.6+ 删除📎后该前邻不再存在，据此区分 host 代际。

## [0.5.4] - 2026-09-14

### 新增

- **图片识别超时时间配置（默认 60 秒）**：VLM 识别请求带超时控制（AbortController），超时后明确报错「VLM 请求超时（N 秒），可在设置→文件附件调大超时时间」，不再无限挂起（此前 VLM 慢或卡住会导致识图工具长时间占用、会话卡死，只能重启 dsh 恢复）。超时时间可在「设置 → 文件附件 → 多模态识别参数」配置，单位秒，范围 1~600，默认 60（实测 VLM 延迟波动大，12~73 秒，30 秒会误杀多数请求）。

### 变更

- **`describe_image` 工具输出 JSON 附带思考模式状态**：工具返回值新增 `thinkingType` 字段（`enabled`=开启 / `disabled`=关闭，来自 VLM 配置），UI 渲染「图片识别结果：…（思考模式：开启/关闭）」直观可见；`/describe` 路由响应同步附带 `thinkingType`。
- **修复思考模式参数格式（MiMo v2.5）**：请求 VLM 的 payload 由扁平 `thinkingType` 改为 MiMo 官方嵌套格式 `thinking: { type: "enabled"|"disabled" }`。此前扁平参数被 API 静默忽略，而 `mimo-v2.5` **默认开启深度思考**——实测扁平 `thinkingType:"disabled"` 的识别耗时高达 **206 秒**（思考未关闭，reasoning_tokens=167），官方 `thinking:{"type":"disabled"}` 仅约 22 秒（reasoning_tokens=0）。这是「图片识别超时 / 会话卡死」的根因之一，已修复。
- **思考参数适配器：按模型名称适配多家 VLM**：新增 `buildThinkingParams` 按**模型名称**（非 `baseURL` host——中转站/代理转发时 host 不可靠）选择思考开关参数形式：仅思考模型（名含 `-thinking`、`glm-5.3*`、`kimi-k3`、`kimi-k2.7-code`）不传任何参数（服务端默认开思考，传 `disabled` 会报错）；通义千问（名含 `qwen`/`qvq`）用扁平 `enable_thinking`；其余（小米 MiMo / DeepSeek / 智谱 GLM / Kimi 官方）用嵌套 `thinking:{type}`。此前硬编码嵌套格式仅对 MiMo 等嵌套系正确，换 Qwen VL 等会失效，现已覆盖主流多模态模型。

## [0.5.3] - 2026-09-12

### 新增

- **图片落盘前最大分辨率限制**：图片落盘前按宽或高任一边 >640 等比缩小；两边都不超过 640 时不处理。GIF 保留原样动画，PNG 保留透明，其他格式缩放后按 JPEG 输出。

## [0.5.2] - 2026-09-11

### 变更

- README 与 0.5.x 功能同步：图片/文档统一落盘 + `@引用`、输入框内联附件条（替代 dock 文件条）、聊天区图片缩略图（Lightbox 放大）、📎 按钮接管、VLM 图片识别与 `describe_image` 工具、设置页 VLM 配置区；运行时代码无变化（文档版）。

## [0.5.1] - 2026-09-11

### 新增

- **输入框内联附件条**：图片上传后直接在输入框内（composer 卡片内部、编辑区上方）显示缩略图预览，替代原输入框上方 dock 浮条（dock 条移除）。文件以类型图标 + 文件名条目显示，不做内容预览；条目可移除（同步清除草稿中对应 `@引用`），发送后自动清空。
  - 实现：shadow dsh 原生 `conversation.input.attachments` 槽（priority -100），渲染自维护的附件登记表（attached map），不依赖 dsh 附件草稿链路，文本模型可正常发送。

- **聊天区图片缩略图预览**：历史对话区中用户消息里的 `@图片路径`（png/jpg/jpeg/gif/webp/bmp）渲染为缩略图（经宿主 `/api/file?path=` 文件服务路由读取落盘图片），点击可放大查看（Lightbox 弹层，点击遮罩/× 关闭）。`@文件路径` 保持原芯片样式，自始至终不做预览。
  - 实现：shadow dsh `conversation.chat.node` keyed `user` 渲染器（priority -100），扫描用户消息文本中的 `@路径` 引用分派渲染；原生 image/file 附件块（多模态模型场景）继续交 dsh 缩略图画廊 / 文件卡片渲染。

### 变更

- 移除 `conversation.input.dock` 上的文件条渲染（FaFileDock），保留 FaBridge（输入机桥，上传链路依赖）。

## [0.5.0] - 2026-09-11

### 新增

- **接管官方文件上传按钮**：插件接管 dsh 原生📎附件上传按钮（hero / composer 两种输入模式共用同一位置：加号右侧、modes 左侧），上传入口与 dsh 本体完全一致。通过 capture 阶段拦截原生 `fileInput` 的 change 事件完成接管，文件随后进入插件自定义处理：
  - 纯图片：不拦截，原样交给既有图片路径，行为零变化；
  - 文档 / 代码 / 配置文件：浏览器端读取全文 → base64 → `POST /dsh-file-attachment/save` 落盘至 `<会话工作区>/.dsh-file-attachment/<日期>/`，并在草稿光标处插入 `@绝对路径` 引用；
  - 目录：拒绝并 toast 提示「不支持拖入目录」；
  - 纯文本粘贴（含路径字符串）：完全原生，不做任何改写。

- **图片自动识别（VLM）**：当前会话模型不支持多模态时，粘贴 / 上传的图片会自动调用可配置的外部 VLM（OpenAI 兼容 `chat/completions` 接口）生成中文描述并回填到草稿；识别结果仅注入模型上下文，不进对话界面、不发给用户。支持多模态的模型则直接读取图片，不触发识别。
  - VLM 参数（Base URL / API Key / 模型 / 思考模式开关）在「设置 → 文件附件」中配置；
  - 默认**关闭思考模式**；未填写 API Key 时识别静默跳过，不影响文件上传。

## [0.4.1] - 2026-09-10

### 新增

- 输入框上传按钮 + 拖拽 / 粘贴文件（支持多文件）；
- 图片走 dsh 原生图片草稿机制（`addImages`），文档落盘到 `.dsh-file-attachment` 并以 `@短名` 引用（发送时还原 `@绝对路径`）；
- 文档 / 代码 / 配置文件可上传类型可在设置页配置；
- 支持 PC 与移动端浏览器。
