# dsh-fileAttachment

DeepSeek Harness (dsh) web GUI 插件：在会话输入框中**拖入或 Ctrl+V 粘贴文档**时，浏览器端读取文件全文，保存到**当前会话工作区根目录下的 `.dsh-fileAttachment/`**，并在输入框光标处插入 `@<保存副本绝对路径>` 引用。agent 读取 `@路径` 时直接读到落盘副本，不再依赖原始文件位置。

图片文件完全沿用 dsh web 既有草稿图片流程，不拦截、不改动。

## 行为一览

| 操作 | 行为 |
| --- | --- |
| 拖入/粘贴 **文档**（docx/xlsx/pdf/md/txt/rpk 等非图片文件） | 浏览器读全文 → base64 → 宿主落盘 `<会话工作区>/.dsh-fileAttachment/<时间戳>-<文件名>` → 光标插入 `@绝对路径`，底部 toast 提示保存目录 |
| 拖入 **目录** | 拒绝，toast 提示「不支持拖入目录」，不插入引用 |
| 拖入/粘贴 **图片** | 不拦截，原样走 dsh web 既有草稿图片流程（零变化） |
| 粘贴 **纯文本**（含从地址栏复制的目录路径字符串） | 不改写，完全原生行为 |
| 重复拖入同名文件（同一秒内） | 追加 `-1`、`-2` 序号，绝不覆盖 |
| 单文件 > 50MB | 跳过并提示 |

### 文件命名

`<时间戳>-<清洗后文件名>`，例如 `2026-02-11T15-04-05-说明.docx`；时间戳为 `2026-02-11T15-04-05` 格式（去掉冒号/毫秒/Z，各平台文件名安全且可排序）。同名冲突在扩展名前追加 `-N`。

### 项目根解析

保存目录的根 = **当前会话工作区**（`session.header.cwd`），回退顺序：会话 cwd → `sandboxPolicy.workspaceRoot` → `process.cwd()`。每个项目（工作区）都各自维护自己的 `.dsh-fileAttachment/` 目录。

### 跨平台

- 保存路径用 Node `path.join`（平台分隔符自适应）
- 时间戳/文件名清洗同时对 Windows 与 POSIX 命名规则安全
- Host 半直接 `node:fs/promises` 写字节，无 shell 依赖

## 安装（本地可安装插件包）

本仓库即一个可安装的 dsh 插件包（`@local/dsh-fileAttachment` 形态，与 `@local/file-drop` 同构）。

### 方式一：链接安装（推荐，便于后续 `git pull` 更新）

```powershell
# 1. 将本仓库 clone 到本地任意目录，例如
git clone https://github.com/<你的账号>/dsh-fileAttachment.git E:\wszhoho\dsh-fileAttachment

# 2. 建立 @local 软链（让 profile 的 node_modules/@local 能解析到本包）
$link = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@local\dsh-fileAttachment"
New-Item -ItemType SymbolicLink -Path $link -Target "E:\wszhoho\dsh-fileAttachment" -Force

# 3. 包内依赖软链：typert-protocol 必须与宿主共享同一模块实例
$dep = "E:\wszhoho\dsh-fileAttachment\node_modules\@deepseek-ai"
New-Item -ItemType Directory -Path $dep -Force
New-Item -ItemType SymbolicLink -Path "$dep\dsh-typert-protocol" `
  -Target "C:\Users\wszhoho\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-typert-protocol" -Force

# 4. 在 profile 补丁文件追加注册行（保持 UTF-8 无 BOM）：
#    - insert:
#        - id: dsh-fileAttachment
#          name: "@local/dsh-fileAttachment"
```

> 第 3 步的目标路径取决于你的 dsh 安装位置（`npm root -g` 或 `node_modules\@deepseek-ai\dsh`）。`realpath` 必须与宿主加载的 `dsh-typert-protocol` 一致（WeakMap 标记互通），否则远程方法注册会失败。

### 方式二：复制到 profile packages

将 `package.json`、`cordis.patch.yml`、`lib/` 复制到 `~/.dsh/profiles/web/packages/dsh-fileAttachment/`，再完成上面的软链与注册行。

### 生效

修改 `cordis.patch.yml` 后 dsh web 会**热重载**（不重启服务）。若未自动生效，刷新页面或切换会话，或到 `%LOCALAPPDATA%\dsh-tray\harness.log` 确认加载行。

## 架构

```
packages/dsh-fileAttachment/
├── package.json          # dsh.client 声明 + bundle patch 指向
├── cordis.patch.yml      # bundle 补丁：插入本插件行
└── lib/
    ├── index.js          # Host 半：fileAttachment remote 服务（@Remote('save')，node:fs/promises 写盘）
    └── client.js         # Client 半：document 级 capture drop/paste/dragenter 监听 + 槽组件
```

- **Host 半**：`TypertRemoteService` 子类，`@Remote('save')` 接收 `(fileName, content, sessionId)`，base64 解码后写盘；经 api-gateway 暴露为客户端 `remote.fileAttachment` 服务。
- **Client 半**：`conversation.composer.dock`（list 槽，同步桥状态，不渲染文本）+ `shell.overlay`（list 槽，toast 通知展示），document 级 capture 监听先于应用 bubble 监听执行。
- **通知**：`shell.overlay` frame-wide 浮动 toast（不参与文档流，不破坏布局），4 秒自动消失。
- **浮层**：拖入任何文件时 capture 阶段拦截应用自带「拖入图片…」DropOverlay（文案面向图片，对文档是误导）。

## 开发说明

- `lib/*.js` 使用 **UTF-8 with BOM**（项目约定）；`package.json`、`cordis.patch.yml` 使用 **UTF-8 无 BOM**。
- Host 半 `@Remote` 签名只允许简单标识符参数（SRC 反射解析），参数名不能撞 typert lookup 定义名（`agent`/`session`）；`sessionId` 安全。
- 50MB 上限两侧一致（client 跳过 + host 校验）。
- 本插件取代了 `@local/file-drop` 的文档行为（原插件只插 `@原路径`，不落盘）；file-drop 包目录保留备查。

## License

MIT