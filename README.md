# dsh-file-attachment

DeepSeek Harness (dsh) web GUI 插件：在会话输入框中**拖入或 Ctrl+V 粘贴文档（支持多文件，一次可拖入/粘贴多个文件）**时，浏览器端批量读取全文，保存到**当前会话工作区根目录下的 `.dsh-file-attachment/`**，并在输入框光标处插入 `@<保存副本绝对路径>` 引用。agent 读取 `@路径` 时直接读到落盘副本，不再依赖原始文件位置。

图片文件完全沿用 dsh web 既有草稿图片流程，不拦截、不改动。

## 行为一览

| 操作 | 行为 |
| --- | --- |
| 拖入/粘贴 **文档**（docx/xlsx/pdf/md/txt/rpk 等非图片文件） | 浏览器读全文 → base64 → 宿主落盘 `<会话工作区>/.dsh-file-attachment/<时间戳>-<文件名>` → 光标插入 `@绝对路径`，底部 toast 提示保存目录 |
| 一次拖入/粘贴 **多个文件**（支持多文件） | 批量处理：逐个读取全文 → base64 → 落盘 → 在光标处一次性插入全部 `@` 引用，toast 汇总保存数量与目录 |
| 拖入 **目录** | 拒绝，toast 提示「不支持拖入目录」，不插入引用 |
| 拖入/粘贴 **图片** | 不拦截，原样走 dsh web 既有草稿图片流程（零变化） |
| 粘贴 **纯文本**（含从地址栏复制的目录路径字符串） | 不改写，完全原生行为 |
| 重复拖入同名文件（同一秒内） | 追加 `-1`、`-2` 序号，绝不覆盖 |
| 单文件 > 50MB | 跳过并提示 |

### 文件命名

`<时间戳>-<清洗后文件名>`，例如 `2026-02-11T15-04-05-说明.docx`；时间戳为 `2026-02-11T15-04-05` 格式（去掉冒号/毫秒/Z，各平台文件名安全且可排序）。同名冲突在扩展名前追加 `-N`。

### 项目根解析

保存目录的根 = **当前会话工作区**（`session.header.cwd`），回退顺序：会话 cwd → `sandboxPolicy.workspaceRoot` → `process.cwd()`。每个项目（工作区）都各自维护自己的 `.dsh-file-attachment/` 目录。

### 跨平台

- 保存路径用 Node `path.join`（平台分隔符自适应）
- 时间戳/文件名清洗同时对 Windows 与 POSIX 命名规则安全
- Host 半直接 `node:fs/promises` 写字节，无 shell 依赖

## 安装（官方 `dsh plugin` 方式，推荐）

本仓库是一个标准 dsh 插件包（声明了 `dsh.bundle.patch`）。用官方 CLI 安装，pnpm 会自动处理依赖、并把本包加入 profile 的 `dsh.profile.bundles` 层：

```powershell
# 在仓库父目录执行（<parent> 换成放置仓库的实际目录，如 E:\wszhoho）
cd <parent>
dsh plugin --profile web add ./dsh-file-attachment
# 重启 web GUI：dsh web（或从托盘重启）
```

- `dsh plugin add` 把参数转发给 profile 目录的 pnpm 执行，`./dsh-file-attachment` 相对路径等价 pnpm link；
- 安装后自动进入 `dsh.profile.bundles`，无需手改 profile `package.json`；
- 改完 `lib/*.js` 后重启 `dsh web` 即生效，适合边改边验；
- 推送到 GitHub 后，其他人用 `dsh plugin --profile web add github:<你的账号>/dsh-file-attachment` 即可安装；
- 升级：`dsh plugin --profile web update dsh-file-attachment`。

## 架构

```
packages/dsh-file-attachment/
├── package.json          # dsh.client 声明 + bundle patch 指向
├── cordis.patch.yml      # bundle 补丁：插入本插件行
└── lib/
    ├── index.js          # Host 半：webServer 路由（POST /dsh-file-attachment/save），node:fs/promises 写盘
    └── client.js         # Client 半：document 级 capture drop/paste/dragenter 监听 + 槽组件
```

- **Host 半**：`webServer.register` 前缀路由 `/dsh-file-attachment`，POST `/dsh-file-attachment/save` 接收 `{name, data(base64), sessionId}`，base64 解码后用 `node:fs/promises` 写盘到会话工作区 `.dsh-file-attachment/`，返回 `{ok, value:{path,dir,name,size}}`。
- **Client 半**：`conversation.composer.dock`（list 槽，同步桥状态，不渲染文本）+ `shell.overlay`（list 槽，toast 通知展示），document 级 capture 监听先于应用 bubble 监听执行。
- **通知**：`shell.overlay` frame-wide 浮动 toast（不参与文档流，不破坏布局），4 秒自动消失。
- **浮层**：拖入任何文件时 capture 阶段拦截应用自带「拖入图片…」DropOverlay（文案面向图片，对文档是误导）。

## 开发说明

- `lib/*.js` 使用 **UTF-8 with BOM**（项目约定）；`package.json`、`cordis.patch.yml` 使用 **UTF-8 无 BOM**。
- Host 半用 `webServer.register({ kind: 'prefix', path: '/dsh-file-attachment', handler })` 收文件（参考 `dsh-upload-file` 同架构的 `/dsh-upload` 路由），纯 ESM 无构建，不依赖装饰器/远程反射。
- Client 半保存用 `fetch('/dsh-file-attachment/save', { method: 'POST', body: JSON.stringify({ name, data, sessionId }) })`，信封为 `{ ok, value | error }`。
- 项目根 = 会话工作区（`session.header.cwd` → `sandboxPolicy.workspaceRoot` → `process.cwd()` 兜底）。
- 50MB 上限两侧一致（client 跳过 + host 校验）。

## License

MIT