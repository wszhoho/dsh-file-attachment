# dsh 本体文件/图片「内联显示在聊天框」机制调研

> **目标**：理解 dsh 本体如何让文件/图片"直接显示在聊天框里"（内联，视觉上比芯片 chip 好），供 dsh-file-attachment 参考。
> **结论速览**：dsh 用 **FileCard 卡片**（文件）+ **图片缩略图画廊**（previewUrl=ObjectURL）+ **ImageLightbox 点击放大**，全部在 composer 草稿区渲染（非发送后的 message）。

## 关键包
（`/root/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`）
- **dsh-client-ui-attachment**（附件 UI 核心，`lib/client.js` 45438 字节 / 926 行，编译产物但保留 region 注释 + 函数名）
- dsh-client-file-upload（上传）
- **dsh-client-ui-sidebar-documentpreview**（文档预览侧边栏，点击文件打开文档预览）
- dsh-client-ui-sidebar-files（文件侧边栏）
- dsh-client-ui-renderer / dsh-client-ui-trajectory / dsh-client-ui-conversation

## 发现（`dsh-client-ui-attachment/lib/client.js`）

### 1. FileCard —— 文件卡片（L389）
`function FileCard({ name, bytes, state, progress, labels, onRemove, onRetry })`
- L390 `extension = fileExtension(name).toUpperCase().slice(0, 8)`
- L391 `meta = state==='uploading' ? labels.uploading : state==='error' ? labels.failed : [extension, fileSizeText(bytes)].filter(p=>p!=='').join(' ')`
- L392 `retryable = state==='error'`
- 渲染 `div.card`（CSS L360：`width:240px; height:64px; border-radius:16px; display:inline-flex; gap:10px; padding:0 12px`）：
  - icon span：`state==='uploading' ? spinner : <FileTypeIcon path={name}/>`
  - body：name span + meta span（retryable 时整体是 button 绑 onRetry）
  - remove button：`<IconCloseFill14 size={12}/>` onClick onRemove（hover 时显示，CSS `.remove` opacity 0→1）
  - uploading 时 progressTrack > progressBar（`width: progress*100%`，CSS 扫描动画）
- 依赖 `@deepseek-ai/dsh-client-ui-primitives`：`fileExtension` / `fileSizeText` / `FileTypeIcon` / `IconCloseFill14`
- **这就是"文件直接显示在聊天框"的视觉核心**：圆角卡片 + 文件类型图标 + 文件名 + 大小/进度 + 删除按钮

### 2. 图片缩略图 + 画廊（L605-882）
- L607 `const [preview, setPreview] = useState(null)`
- L704 `setPreview(attachment)` + L707 `src: attachment.previewUrl`（**图片用 previewUrl = URL.createObjectURL(file) 生成缩略图**）
- 画廊：**单张**按 `singleFit` 尺寸渲染；**多张**为 **64px 方块 tile**
- L832 `const src = preview?.url ?? loaded`（预览优先 ObjectURL，否则加载 durable reference）
- L882 key = `"attachment" in image ? image.attachment.attachmentId : image.preview.url` + index

### 3. ImageLightbox —— 点击放大（L444-461, L723-727）
- L723 `preview !== null && <ImageLightbox src={preview.previewUrl} alt={preview.file.name} onClose={closePreview}/>`
- CSS：`.backdrop`（z-index 1000 fixed inset 0 grid center）/ `.mask`（bg-mask + backdrop-blur）/ `.image`（object-fit:contain, max-width min(100%,1600px), max-height calc(100vh-80px), radius 12, shadow）/ `.close`（36x36 fixed top-right 圆形）
- 点击缩略图 → 全屏 Lightbox 放大，close / ESC 关闭

## 结论 / dsh-file-attachment 如何借鉴
**当前 dsh-file-attachment**：文档 = 落盘 + 芯片 `@短名`（纯文本引用，发送时还原 `@绝对路径`）；图片 = 原生 addImages（dsh 图片草稿机制，不缩放不落盘）。
**dsh 本体做法**：文件/图片都在 **composer 草稿区**渲染为**视觉组件**（非纯文本）：
1. **文件 → FileCard 卡片**：FileTypeIcon + 名 + 大小/进度 + 删除（240x64 圆角卡）
2. **图片 → 缩略图**（`URL.createObjectURL(file)`）+ 单张/多张 tile 画廊
3. **点击图片 → ImageLightbox 放大**

**借鉴方案**（若要让 dsh-file-attachment 也内联显示）：
- 复用 dsh 的 `@deepseek-ai/dsh-client-ui-primitives`（FileTypeIcon / fileExtension / fileSizeText / IconCloseFill14）
- 在 composer 草稿区（`conversation.input.dock` 或专用 attachment slot）渲染 FileCard 卡片 + 图片缩略图
- 维护 attachments 数组（`{ id, file, previewUrl, state, bytes }`），图片用 `URL.createObjectURL(file)` 生成 previewUrl
- 文档可额外接 `dsh-client-ui-sidebar-documentpreview`（点击卡片打开侧边栏预览）
- **注意**：dsh 本体的 FileCard 渲染在它自己的 attachment slot；dsh-file-attachment 要在自己的 slot 里复刻这套 UI（或直接复用 primitives 组件）

## 待验证（后续做的时候确认）
- [ ] dsh 本体 FileCard / 图片缩略图渲染在哪个 slot（`conversation.input.dock`？专用 attachment slot？）—— 需看 dsh-client-ui-attachment 的 apply / 注入逻辑
- [ ] previewUrl 生命周期（何时 createObjectURL / revokeObjectURL 防内存泄漏）
- [ ] 发送时附件如何序列化（FileCard 的 attachment 如何转成 message 内容 / 上传）

## 源码机制（`/workspace/deepseek-harness/packages/client/ui-attachment/src/`，已确认）

> 用户指向 dsh 源码 monorepo（`/workspace/deepseek-harness`，pnpm workspace），比编译产物清晰。`packages/client/ui-attachment/src/` 含 FileCard.tsx / AttachmentRail.tsx / ImageLightbox.tsx / MessageImage.tsx / DropOverlay.tsx + 各 .module.css + client/ + index.ts；`packages/client/ui-primitives/` 是 primitives 真实源码。

- **FileCard.tsx**（81 行，纯展示组件）：`export function FileCard({ name, bytes, state, progress?, labels, onRemove, onRetry })`，`state: 'uploading'|'ready'|'error'`，`labels={label,remove,uploading,failed,retry}`
  - L1 `import { fileExtension, FileTypeIcon, fileSizeText, IconCloseFill14 } from '@deepseek-ai/dsh-client-ui-primitives'`
  - L33 `extension = fileExtension(name).toUpperCase().slice(0, 8)`；L34-38 meta = uploading?labels.uploading : error?labels.failed : [extension, fileSizeText(bytes)]
  - 渲染 `div.card`：icon span（uploading→spinner / 否则 `<FileTypeIcon path={name}/>`）+ body（name span + meta span，error 时整体是 button 绑 onRetry）+ remove button（`<IconCloseFill14 size={12}/>` onClick onRemove）+ uploading 时 progressTrack>progressBar（`width: progress*100%`）
- **AttachmentRail.tsx**（171 行，横向滚动栏容器）：`export function AttachmentRail<T extends {id}>({ items, labels, renderItem })`，`labels={group,scrollLeft,scrollRight}`
  - 隐藏 scrollbar 的**横向滚动 rail** + 边缘箭头分页（`IconChevronLeft/RightOutline14`）
  - `updateEdges`：算 scrollLeft 是否在左/右边缘（1px slack 容差）
  - `useLayoutEffect`：新加 item 时滚到末尾（reveal）；`useEffect`：`ResizeObserver` 监听 rail 尺寸变化 + **wheel 事件**（垂直滚轮转横向，non-passive 手动 addEventListener，LINE delta × 16px 归一化）
  - `page(dir) = scrollBy(dir * max(clientWidth - 64, 200))`
  - 渲染 `div.root` > [左箭头] + `div.rail`(role=group, onScroll) > `items.map(div.item > renderItem)` + [右箭头]
- **关键结论**：FileCard 与 AttachmentRail **都 import primitives**（FileTypeIcon/IconChevron/fileSizeText 等），而 primitives **运行环境不存在**（仅编译进各 client.js，`node_modules` 顶层/`.pnpm` 均无）→ **插件无法 require，必须自写**
- **自写方案（零 dsh 内部依赖）**：插件已有全部原料——`fileGlyph(ext)` 内联 SVG 图标（client.js L772-776，代 FileTypeIcon）+ React（L17 `require('react')`）+ **FaChips 小芯片**（L781-836，20×20 `<img>`+glyph+name，即用户说的"docker 方式"）+ dock 槽（L1109 `slots.inject('conversation.input.dock',...)`）
  - **FaFileCard** = 把 FaChips 升级为**大卡片**（参考 dsh 240×64 圆角 border-radius 16px）：文件 = fileGlyph + name + 大小；图片 = `URL.createObjectURL(file)` 缩略图 + 点击放大；删除按钮
  - **简化 rail**：用 flex wrap / 简单横向滚动（省 dsh 的 wheel/ResizeObserver/边缘箭头分页复杂度，插件附件通常数量少）

## 方案 A/B 成本评估 + primitives 深挖（用户指向 GitHub `yaomin/dsh` fork = 本地 `/workspace/deepseek-harness` 同源码，用户问"是不是这个"→ 确认是）

### primitives 包（`@deepseek-ai/dsh-client-ui-primitives`）
- 本地路径：`/workspace/deepseek-harness/packages/client/ui-primitives/`（= GitHub `yaomin/dsh` fork 同源码；**非独立 npm 包**）
- **版本**：本地 `0.1.5-rc.1`（匹配 dsh 主包）；**npm 只发布旧版 `0.0.1-rc.1`**（`npm view @deepseek-ai/dsh-client-ui-primitives version` → `0.0.1-rc.1`）
- **导出（40+）**：`FileTypeIcon` / `IconCloseFill14` / `IconChevronLeftOutline14` / `IconChevronRightOutline14` / `IconCloseOutline16` / 各 `Icon*` + `Button`/`Switch`/`Input`/`Menu`/`Pill`/`Tag`/`Modal`/`StateDot`/`ConnectionIndicator` 等控件 + `CODE_FILE_TYPES` 等常量
- **完整 package.json 关键点**：
  - `type: module`，`main: lib/index.js`（**lib 不存在 → 未构建**），`types: lib/types/index.d.ts`
  - `exports`: `.`→`lib/index.js`，`./src/*`→`src/*`（可引源码），`./package.json`
  - **devDependencies**：`@deepseek-ai/cordis: workspace:^`（**monorepo 内部包，workspace 协议**）+ react/clsx/react-dom/anser/katex/micromark-*/shiki/@shikijs/langs（公共 npm）
  - **peerDependencies**：`@deepseek-ai/cordis: workspace:^`
  - `files`: `lib/index.js` + `lib/**/*.css` + `lib/types/**/*.d.ts`
  - description: "Pure React atoms for the dsh web UI: controls, icons, markdown, and JSON inspectors (zero cordis)"

### 构建障碍（方案 A 真实成本）
- primitives **未构建**（`main` 指向 `lib/index.js` 但文件不存在）
- **monorepo 依赖未装**（`/workspace/deepseek-harness/node_modules` 不存在）
- primitives **依赖 cordis（workspace 协议，monorepo 内部包）** → **单独构建不可行**（cordis 解析不到）
- → 方案 A 需：monorepo `pnpm install`（50+ 包，需网络/代理）+ `pnpm build`，**重操作 + 网络风险**
- 备选 A2b：直接 `import '@deepseek-ai/dsh-client-ui-primitives/src/FileTypeIcon'`（src 是 .tsx），需**改造插件 Vite 打包**（transpile node_modules 的 .tsx + react/clsx 可达）

### 关键事实（影响决策）
- 插件 `client.js` L772-776 的 **`fileGlyph(ext)` 本就是照 dsh 的 FileTypeIcon 仿写的内联 SVG**（18×20 viewBox）
- → 方案 B（用 fileGlyph 自写卡片）**视觉已接近 dsh**（fileGlyph 就是仿 dsh 抄的）
- → 方案 A（换真 primitives）**视觉提升极小**，却要 monorepo install+build 高成本 + 网络风险

### 决策（待用户最终确认）
- **A（官方推荐，重）**：monorepo `pnpm install`+`build` primitives → 插件 package.json 加 `file:` link 或 npm 旧版 `0.0.1-rc.1` → `import { FileTypeIcon, IconCloseFill14, IconChevron* }` → 视觉与 dsh 完全一致。成本高（monorepo 构建）+ 需网络/代理
- **B（零依赖，轻，本轮可完成）**：用现有 `fileGlyph` 自写 FaFileCard 大卡片（240×64 圆角参考 dsh）+ 图片 `URL.createObjectURL` 缩略图。零依赖、可靠、视觉已仿 dsh
- **用户已选 A，但 A 成本高**；建议本轮先 B（快速可用），A 视觉优化放新会话（干净上下文 + 跑 monorepo 构建）

### 插件现状（`/tmp/dsh-file-attachment/lib/client.js`，1166 行）
- **FaFileDock**（L780-835）：现有文件条（输入框上方 dock），20×20 `<img>` 缩略图 / `fileGlyph` + name + ×移除，flex wrap 布局；发送后自动清空（轮询 readShellSnapshot）
- **fileGlyph**（L772-776）：仿 dsh 的内联 SVG 文件图标
- **FaUploadButton**（L841+，`conversation.input.left` order 10）
- **slots.inject**（L1109-1143）：`conversation.input.dock` + `shell.overlay` + `conversation.input.left` + `settings.section`
- 数据：`attached` Map（sessionId→entries）、`detachFile`、`clearAttachedFor`、`readShellSnapshot`

## FileCard 完整调用链（用户问"怎么调用"，已读源码确认）

### 挂载槽（`client/index.ts` L15-33）
- `apply(ctx)` 注册 4 个 slot：
  - **`conversation.input.attachments` → ComposerAttachments**（输入区附件，FileCard 宿主）
  - `conversation.message.images` / `conversation.trajectory.images` / `tool.call.images` → MessageImages
- `inject = ['slots']`；`import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'` 等（类型依赖其它包）
- **关键**：FileCard 挂在 **`conversation.input.attachments` 专用槽**（**非** dock），通过 `ctx.slots.register({ name, locale: 'conversation' }, ComposerAttachments)` + `ctx.slots.inject`

### ComposerAttachments（`client/ComposerAttachments.tsx`，154 行）
- props（L20-22）：`{ attachments, canAcceptDrop, onAddFiles, onRemoveAttachment, uploads, onRetryFile, dropLimits, t }`
- **数据源**：`attachments`（ComposerAttachment[]）+ `uploads`（`{id:{status,loaded,total}}`）**都是 props**（conversation 包/store 提供），组件**纯展示层**
- `railItems = attachments.map(a => ({ id: a.id, attachment: a }))`（L82-85）
- 拖拽（L31-80）：document 级 dragenter/over/leave/drop → `onAddFiles([...dataTransfer.files])` + DropOverlay
- **renderItem（L100-140）关键分两种**：
  - **`kind==='file'`（非图片）→ `<FileCard>`**（L105-117）：`name`/`bytes`/`state`（`upload.status` 映射 uploading/ready/error）/`progress`（`upload.loaded/upload.total`）/`labels=fileCardLabels(t,name)`/`onRemove=onRemoveAttachment(id)`/`onRetry=onRetryFile(id)`
  - **`kind!=='file'`（图片）→ 缩略图**（L120-139）：`<img src={attachment.previewUrl}>` + 删除按钮，**不用 FileCard**
- Lightbox（L144-151）：图片点击放大（`preview.previewUrl`）
- `labels.ts`：`fileCardLabels(t, name)` / `attachmentRailLabels(t)` / `dropOverlayLabels` / `lightboxLabels`（本地化字符串，locale 'conversation'）

### 对插件的启示（核心）
- dsh **文件/图片分开渲染**：文件用 FileCard，图片用缩略图 `<img src={previewUrl}>`
- 挂**专用槽** `conversation.input.attachments`（**非** dock）
- 数据源 `attachments`+`uploads` 由 conversation 包管理（store/props），ComposerAttachments 纯展示
- **插件复刻**：注册 `conversation.input.attachments` 槽（若 dsh 允许插件注入）或用自有槽（插件已有 dock）；文件 FileCard 风格 + 图片缩略图 + 数据源用插件 `attached` Map
