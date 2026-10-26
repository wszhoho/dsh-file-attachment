// @wszhoho/dsh-file-attachment Host 半：webServer HTTP 路由方案。
// Client 半 POST /dsh-file-attachment/save：元数据（name/sessionId）走查询参数，
// 请求体即文件原始字节流，本端流式写盘（不经 JS 全量缓冲、无 base64 膨胀）。
// 写入 <会话工作区根>/.dsh-file-attachment/<文件名>（平铺，0.7.0 起不再按日期分子目录；文件名保留原始名）并返回 { path, dir, name, size }。
// 去重（0.7.0）：Client 上传前先 POST /precheck（name+size 键，元数据级去重），命中直接复用旧路径、零字节上传；
// /save 侧同名同大小做兜底后检。索引持久化在 <root>/.dsh-file-attachment/.index.json。
// 项目根解析：Client 传 sessionId → sessions.get(sessionId).header.cwd →
// sandboxPolicy.workspaceRoot → process.cwd()（三平台绝对路径，Node path.join 自适应分隔符）。
// 纯 ESM 无构建：不依赖 TypertRemoteService/装饰器，原生 Node 可直接加载。
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
// schemastery 为 peerDependency：link 插件目录内可能未安装，用顶层 await 安全加载
let z = null
try { z = (await import('@deepseek-ai/schemastery')).default } catch { /* 降级：跳过 settings 注册 */ }

/** 本包声明依赖的 Host 服务。 */
export const name = 'dsh-file-attachment'
export const inject = ['webServer', 'tools']

// 临时目录名：落在会话工作区根下；每个项目都能看到自己引用过的文档
const ATTACHMENT_DIR = '.dsh-file-attachment'
// 单文件上限 50MB（与 Client 半一致）
const MAX_BYTES = 50 * 1024 * 1024
// describe_image 工具读图上限 20MB：模型可传任意图片路径，先按 stat 大小拦截，
// 避免超大文件整体读入内存再转 base64 拖垮识别链路
const MAX_DESCRIBE_BYTES = 20 * 1024 * 1024
// 请求体上限：base64(50MB) + 信封余量
const MAX_BODY_BYTES = 68 * 1024 * 1024
// 文件名非法字符：路径分隔符、Windows 保留字符、控制字符
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/gu
// 配置持久化：用户级 ~/.dsh/file-attachment.json（跨项目通用，存「可上传类型」白名单）
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'file-attachment.json')
// 默认允许类型（三类：文档 / 代码 / 配置文件）；图片恒允许（image/*，不受此配置影响）
// 用户可在「设置 → 文件附件」页增删扩展名；此处仅为首启兜底与重置基准。
const DEFAULT_TYPES = {
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'],
  code: ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bash', 'ps1', 'sql', 'r', 'lua', 'pl', 'log'],
  config: ['json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'xml', 'html', 'css'],
}

/** 解析项目根：会话 cwd → sandboxPolicy.workspaceRoot → process.cwd()。 */
function projectRoot(ctx, sessionId) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions !== undefined && typeof sessions.get === 'function' && typeof sessionId === 'string' && sessionId !== '') {
    try {
      const sess = sessions.get(sessionId)
      if (sess !== undefined && sess.header !== undefined && typeof sess.header.cwd === 'string' && sess.header.cwd !== '') {
        return sess.header.cwd
      }
    } catch (err) { /* 回退下一来源 */ }
  }
  if (typeof ctx.get === 'function') {
    const sp = ctx.get('sandboxPolicy')
    if (sp !== undefined && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot !== '') {
      return sp.workspaceRoot
    }
  }
  return process.cwd()
}

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/** 读取 JSON 请求体（带上限）。 */
async function readJsonBody(req, maxBytes) {
  let size = 0
  let data = ''
  const decoder = new TextDecoder('utf-8')
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) return null
    data += decoder.decode(buf, { stream: true })
  }
  data += decoder.decode()
  if (data === '') return null
  try {
    return JSON.parse(data)
  } catch (err) {
    return null
  }
}

/** 清洗文件名：只取 last segment、去非法字符、空名 → file。 */
function cleanName(raw) {
  let s = raw === undefined || raw === null ? '' : String(raw)
  while (s.length > 0) {
    const c = s.charCodeAt(s.length - 1)
    if (c === 47 || c === 92) s = s.slice(0, -1)
    else break
  }
  let seg = ''
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 47 || c === 92) { if (cur !== '') { seg = cur; cur = '' } }
    else cur += s.charAt(i)
  }
  if (cur !== '') seg = cur
  const safe = seg.replace(BAD_CHARS, '_').trim() || 'file'
  return safe
}

/** 规范化一个扩展名列表：小写、去点、去重、仅保留 [a-z0-9]；非法项丢弃。 */
function normalizeTypeList(arr) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(arr)) return out
  for (const raw of arr) {
    const s = String(raw ?? '').trim().toLowerCase().replace(/^\./u, '')
    if (s === '') continue
    if (!/^[a-z0-9]+$/u.test(s)) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

// 多模态识别（VLM）默认参数：thinkingType/timeout 空值回退默认；
// baseURL/apiKey/model 不再回退默认——三项必须由用户显式配置，缺失时 describe_image 与
// /describe 统一提示「请正确配置视觉模型」，避免静默打到默认端点后报晦涩的连接错误。
// （下面 baseURL/model 的默认值仅作设置页 placeholder 示例参考。）
const VLM_DEFAULTS = {
  baseURL: 'https://api.xiaomimimo.com/v1',
  apiKey: '',
  model: 'mimo-v2.5',
  thinkingType: 'disabled',
  timeout: 60, // 识别超时（秒）。实测 VLM 延迟波动大（12~73s），30s 会误杀多数请求
}

/** VLM 三项（baseURL/apiKey/model）任一为空时的统一提示。 */
const VLM_CONFIG_ERROR = '请正确配置视觉模型（设置→文件附件填写 Base URL、API Key 与模型名称）'

/** 兜底 VLM 是否已正确配置：baseURL、apiKey、model 三项均非空。 */
function isVlmConfigured(vlm) {
  return !!(vlm && vlm.baseURL !== '' && vlm.apiKey !== '' && vlm.model !== '')
}

// 「插件配置」tab 卡片所绑定的 settings 命名空间（kebab-case，匹配 /dsh-file-attachment）。
const SETTINGS_NS = 'dsh-file-attachment'

/**
 * settings 命名空间的 wire schema：字段自带默认值，描述「可上传类型」与多模态参数结构。
 *
 * 作用：向 host 的 `settings` 服务登记该命名空间，使浏览器半侧的插件配置卡片
 * （settings.plugin.item，key = 本命名空间）被「插件配置」tab 派发渲染。
 *
 * 注意：实际配置仍持久化在 ~/.dsh/file-attachment.json（/config 路由读写），此 schema
 * 仅用于登记命名空间结构（与自动继续插件的 settings.register 同形）；卡片内部表单
 * 继续走 /config 接口读写真实配置。
 */
const FaAttachmentSchema = z ? z.object({
  doc: z.array(z.string()).default(DEFAULT_TYPES.doc),
  code: z.array(z.string()).default(DEFAULT_TYPES.code),
  config: z.array(z.string()).default(DEFAULT_TYPES.config),
  vlm: z.object({
    baseURL: z.string().default(VLM_DEFAULTS.baseURL),
    apiKey: z.string().default(VLM_DEFAULTS.apiKey),
    model: z.string().default(VLM_DEFAULTS.model),
    thinkingType: z.string().default(VLM_DEFAULTS.thinkingType),
    timeout: z.natural().default(VLM_DEFAULTS.timeout),
  }),
}) : null

/** 规范化多模态参数（trim 去空白）。baseURL/apiKey/model 不回退默认（空即未配置，由 isVlmConfigured 拦截）；thinkingType/timeout 空值回退默认。 */
function normalizeVlm(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {}
  const pickStr = (key) => (typeof r[key] === 'string' ? r[key].trim() : '')
  const pickOrDefault = (key) => (typeof r[key] === 'string' && r[key].trim() !== '' ? r[key].trim() : VLM_DEFAULTS[key])
  // 超时（秒）：正整数 1~600，非法回退默认
  const t = Number(r && r.timeout)
  const timeout = Number.isFinite(t) && t >= 1 && t <= 600 ? Math.floor(t) : VLM_DEFAULTS.timeout
  return {
    baseURL: pickStr('baseURL'),
    apiKey: pickStr('apiKey'),
    model: pickStr('model'),
    thinkingType: pickOrDefault('thinkingType'),
    timeout,
  }
}

/** 读取配置；文件缺失/损坏时回退默认值（保持三类 + 多模态参数齐全）。 */
async function readConfig() {
  let stored = {}
  try {
    const text = await readFile(CONFIG_PATH, 'utf8')
    stored = JSON.parse(text) || {}
  } catch (err) {
    stored = {}
  }
  return {
    doc: normalizeTypeList(stored.doc),
    code: normalizeTypeList(stored.code),
    config: normalizeTypeList(stored.config),
    vlm: normalizeVlm(stored.vlm || stored.mimo),
  }
}

/** 保存配置（全量覆盖三类 + 多模态参数）；返回规范化后的配置。 */
async function writeConfig(body) {
  const next = {
    doc: normalizeTypeList(body && body.doc),
    code: normalizeTypeList(body && body.code),
    config: normalizeTypeList(body && body.config),
    vlm: normalizeVlm(body && (body.vlm || body.mimo)),
  }
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ---- 去重索引（0.7.0）：键 = cleanName(name) + \u0000 + size（元数据级去重，精度误差已由作者确认接受）。
// 每个项目根一份 <root>/.dsh-file-attachment/.index.json；内存 Map 权威，变更后临时文件 + rename 原子落盘。
// 命中即复用旧路径（决策④乙）：返回前 stat 验旧文件仍在，丢失则删条目按未命中处理。
// 首次触碰某根目录时懒加载；文件损坏则 .index.json.bak 备份留证后重建。
const INDEX_FILE = '.index.json'
const indexMap = new Map()  // root -> Map<key, { path, size, firstSeen }>
const indexLoads = new Map() // root -> Promise（并发去重，同一根只加载一次）

function dedupKey(safeName, size) { return safeName + '\u0000' + size }

async function loadIndex(root) {
  const m = new Map()
  try {
    const idxPath = join(root, ATTACHMENT_DIR, INDEX_FILE)
    const text = await readFile(idxPath, 'utf8')
    const stored = JSON.parse(text)
    if (stored !== null && typeof stored === 'object' && typeof stored.entries === 'object' && stored.entries !== null) {
      for (const [k, v] of Object.entries(stored.entries)) {
        if (v !== null && typeof v === 'object' && typeof v.path === 'string' && typeof v.size === 'number') m.set(k, v)
      }
    }
  } catch (err) {
    // ENOENT = 首启，静默空索引；其余（损坏/权限）备份坏文件后重建，下次保存自然覆盖
    try { await rename(join(root, ATTACHMENT_DIR, INDEX_FILE), join(root, ATTACHMENT_DIR, INDEX_FILE + '.bad-' + Date.now().toString(36))) } catch { /* 目录不存在等，忽略 */ }
  }
  return m
}

/** 确保该根的索引已加载，返回权威 Map。 */
function ensureIndex(root) {
  let m = indexMap.get(root)
  if (m !== undefined) return Promise.resolve(m)
  let p = indexLoads.get(root)
  if (p === undefined) {
    p = loadIndex(root).then((loaded) => {
      indexLoads.delete(root)
      const existing = indexMap.get(root)
      if (existing !== undefined) return existing
      indexMap.set(root, loaded)
      return loaded
    })
    indexLoads.set(root, p)
  }
  return p
}

/** 原子落盘索引（临时文件 + rename）。失败只警告，不阻断上传链路。同一 root 的写排队串行，防 rename 乱序覆盖。 */
const indexWrites = new Map() // root -> Promise 链尾
function persistIndex(root) {
  const prev = indexWrites.get(root) ?? Promise.resolve()
  const next = prev.then(() => writeIndexNow(root)).catch(() => {})
  indexWrites.set(root, next)
  return next
}
async function writeIndexNow(root) {
  const m = indexMap.get(root)
  if (m === undefined) return
  const dir = join(root, ATTACHMENT_DIR)
  const tmp = join(dir, '.index-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '.tmp')
  try {
    await mkdir(dir, { recursive: true })
    const obj = {}
    for (const [k, v] of m) obj[k] = v
    await writeFile(tmp, JSON.stringify({ version: 1, entries: obj }) + '\n', 'utf8')
    await rename(tmp, join(dir, INDEX_FILE))
  } catch (err) {
    await unlink(tmp).catch(() => {})
    console.warn('[dsh-file-attachment] 索引落盘失败（不影响上传）:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 查询去重命中：返回旧条目 { path, size, firstSeen }；未命中或旧文件已丢失返回 null。
 * 必须经 ensureIndex 之后调用（纯内存查询 + 一次 stat 验证）。
 */
async function dedupLookup(root, key) {
  const m = indexMap.get(root)
  if (m === undefined) return null
  const e = m.get(key)
  if (e === undefined) return null
  try {
    const st = await stat(e.path)
    if (st.isFile() && st.size === e.size) return e
  } catch { /* 旧文件已删：视为未命中并清条目 */ }
  m.delete(key)
  await persistIndex(root)
  return null
}

/** 记录新落盘文件到索引（幂等覆盖 + 落盘完成才返回：响应返回 = 磁盘一致）。 */
async function dedupRecord(root, key, path, size) {
  const m = indexMap.get(root)
  if (m === undefined) return
  m.set(key, { path, size, firstSeen: Date.now() })
  await persistIndex(root)
}

/**
 * 流式保存一个上传文件（请求体即文件原始字节流）并返回落盘信息。
 * 先以 wx 独占创建随机临时文件、经计数管道流式写入（超 MAX_BYTES 立即中断），
 * 完成后用 link（目标存在即 EEXIST）原子占用最终名——并发同名各自拿到不同序号，
 * 中断/超限只清临时文件，不会留下半截正式文件或互相覆盖。
 * @param root - 项目根（会话工作区）。
 * @param rawName - 查询参数带来的原始文件名。
 * @param req - HTTP 请求（作为可读流直接管道到磁盘）。
 * @returns { path, dir, name, size, deduped? }。deduped=true 表示复用已有文件（未新落盘）。
 */
async function handleSaveStream(root, rawName, req) {
  const safe = cleanName(rawName)
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  const dir = join(root, ATTACHMENT_DIR)
  // 0.7.0 起平铺存放（不再按日期分子目录）；文件保留原始文件名 → 芯片 basename 即原始名
  await mkdir(dir, { recursive: true })
  // 去重索引需先就位（after-check 与落盘记录都用得到），与接收流并行加载不拖慢首包
  const indexReady = ensureIndex(root)
  const tmp = join(dir, '.upload-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10))
  let size = 0
  let oversize = false
  const fh = await open(tmp, 'wx')
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length
          if (size > MAX_BYTES) { oversize = true; throw new Error('OVERSIZE') }
          yield chunk
        }
      },
      fh.createWriteStream(),
    )
  } catch (err) {
    await unlink(tmp).catch(() => {})
    if (oversize) throw new Error('文件超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB 上限')
    throw err
  }
  if (size === 0) {
    await unlink(tmp).catch(() => {})
    throw new Error('内容为空')
  }
  // ---- 去重 after-check（兜底，覆盖绕过 /precheck 的直连上传与并发竞态）----
  // 此时 size 已知；键 = cleanName + size。命中：丢弃刚接收的临时文件，复用旧路径（决策④乙：用旧名字）。
  await indexReady
  const key = dedupKey(safe, size)
  const hit = await dedupLookup(root, key)
  if (hit !== null) {
    await unlink(tmp).catch(() => {})
    const base = hit.path.slice(Math.max(hit.path.lastIndexOf('/'), hit.path.lastIndexOf('\\')) + 1)
    return { path: hit.path, dir, name: base, size, deduped: true }
  }
  // link 在目标已存在时抛 EEXIST —— 天然原子的「不存在才占位」；冲突则递增序号重试
  let target = join(dir, safe)
  for (let i = 1; ; i += 1) {
    try {
      await link(tmp, target)
      break
    } catch (err) {
      if (err !== null && err.code === 'EEXIST') {
        target = join(dir, stem + '-' + i + ext)
        continue
      }
      await unlink(tmp).catch(() => {})
      throw err
    }
  }
  await unlink(tmp).catch(() => {})
  // 并发收敛：link 与索引写入之间另一路同名上传可能已入索引；link 已成功（原子、名字不同），
  // 后到者弃用自己的产物改指先者（unlink 只删自己的目录项，不影响对方文件数据）
  const late = await dedupLookup(root, key)
  if (late !== null && late.path !== target) {
    await unlink(target).catch(() => {})
    const base = late.path.slice(Math.max(late.path.lastIndexOf('/'), late.path.lastIndexOf('\\')) + 1)
    return { path: late.path, dir, name: base, size, deduped: true }
  }
  await dedupRecord(root, key, target, size)
  return { path: target, dir, name: safe, size }
}

// 仅思考模型识别：这类模型（旗舰推理版 / 带 thinking 后缀）始终思考、不可关闭，
// 传 thinking.type='disabled' 会报错（Kimi k2.7-code、GLM-5.3、Qwen3-VL-*-Thinking 等）。
function isThinkingOnlyModel(model) {
  const m = String(model || '').toLowerCase()
  if (/-thinking\b/.test(m)) return true
  if (/kimi-k3\b/.test(m)) return true
  if (/kimi-k2\.7-code/.test(m)) return true
  if (/^glm-5\.3/.test(m)) return true
  return false
}

// 思考参数适配器：各家 OpenAI 兼容 API 的「思考开关」字段形式不统一。
// 按 model 名称判断（不依赖 baseURL host——中转站/代理转发时 host 不可靠，而 model 字段稳定跟随请求）。
//   - 仅思考模型 → 不传任何参数（服务端默认开启思考；传 disabled 会报错）
//   - 通义千问 Qwen / QVQ（含 VL 视觉）→ 扁平布尔 enable_thinking
//   - 其余主流（小米 MiMo / DeepSeek / 智谱 GLM / Kimi 官方）→ 嵌套对象 thinking:{type}
function buildThinkingParams(vlm) {
  if (isThinkingOnlyModel(vlm.model)) return {}
  const wantEnabled = vlm.thinkingType === 'enabled'
  const model = String(vlm.model || '').toLowerCase()
  if (model.includes('qwen') || model.includes('qvq')) {
    return { enable_thinking: wantEnabled }
  }
  return { thinking: { type: wantEnabled ? 'enabled' : 'disabled' } }
}

/**
 * 调 VLM（OpenAI 兼容 chat/completions）识别图片，返回中文描述。
 * @param vlm - 多模态参数 { baseURL, apiKey, model, thinkingType, timeout }（来自配置，timeout 单位秒）。
 * @param dataUrl - base64 data URL（形如 data:image/png;base64,xxx）。
 * @returns 图片的简洁中文描述。
 * @throws VLM 请求失败或未返回有效内容时抛错；超时抛「VLM 请求超时」。
 */
async function describeImage(vlm, dataUrl, prompt) {
  const url = vlm.baseURL.replace(/\/+$/u, '') + '/chat/completions'
  const userPrompt = (typeof prompt === 'string' && prompt.trim() !== '') ? prompt.trim() : '请描述这张图片。'
  // 思考开关：各家 OpenAI 兼容 API 字段形式不统一，由 buildThinkingParams 按 model 名称适配
  // （Qwen/QVQ → 扁平 enable_thinking；MiMo/DeepSeek/GLM/Kimi → 嵌套 thinking.type；仅思考模型 → 不传）。
  const payload = {
    model: vlm.model,
    ...buildThinkingParams(vlm),
    messages: [
      { role: 'system', content: '你是图片描述助手，用简洁中文回答。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }
  const timeoutSec = (Number.isFinite(vlm.timeout) && vlm.timeout >= 1 && vlm.timeout <= 600) ? vlm.timeout : VLM_DEFAULTS.timeout
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + vlm.apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error('VLM 请求失败 ' + resp.status + (text !== '' ? ' ' + text.slice(0, 200) : ''))
    }
    const data = await resp.json()
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (typeof content !== 'string' || content === '') throw new Error('VLM 未返回有效内容')
    return content
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('VLM 请求超时（' + timeoutSec + ' 秒），可在「设置→文件附件」调大超时时间')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 校验 VLM 配置是否可用（设置页保存前的连通性测试）：向 chat/completions 发一条最小文本请求。
 * 不传 thinking 参数（最大兼容各家 OpenAI 兼容端点），不传图片（省 token），超时固定 30 秒。
 * @param vlm - 规范化后的 { baseURL, apiKey, model, timeout }（来自设置表单，未落盘）。
 * @throws 三项未配置、HTTP 失败、响应无 choices 或超时。
 */
async function testVlm(vlm) {
  const url = vlm.baseURL.replace(/\/+$/u, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30 * 1000)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + vlm.apiKey,
      },
      body: JSON.stringify({ model: vlm.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error('视觉模型校验失败 ' + resp.status + (text !== '' ? '：' + text.slice(0, 200) : ''))
    }
    const data = await resp.json().catch(() => null)
    if (!data || !Array.isArray(data.choices)) throw new Error('视觉模型校验失败：响应格式异常（无 choices）')
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('视觉模型校验超时（30 秒），请检查 Base URL 与网络')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 注册 /dsh-file-attachment 前缀路由（save POST）。 */
function registerRoutes(ctx) {
  const webserver = ctx.get('webServer')
  if (webserver === undefined) return
  webserver.register({
    kind: 'prefix',
    path: '/dsh-file-attachment',
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/save') {
        // 协议（0.6.4 起）：元数据走查询参数（name/sessionId，URL 编码），
        // 请求体是文件原始字节流，服务端流式写盘（不再 JSON+base64 整包进内存）
        const q = new URL(req.url ?? '/', 'http://x').searchParams
        const rawName = q.get('name') ?? ''
        const sessionId = q.get('sessionId') ?? ''
        let root
        try {
          root = projectRoot(ctx, sessionId)
        } catch (err) {
          json(res, { ok: false, error: '无法解析项目根' }, 500)
          return
        }
        try {
          const value = await handleSaveStream(root, rawName, req)
          json(res, { ok: true, value })
          return
        } catch (err) {
          const message = err && err.message ? err.message : '保存失败'
          const oversized = message.indexOf('上限') >= 0
          json(res, { ok: false, error: message }, oversized ? 413 : 400)
          return
        }
      }
      // 去重预检（0.7.0）：Client 上传前 POST {name,size,sessionId}（JSON）。
      // 命中返回 { path, name, size, dir, deduped:true }（客户端据此零字节上传）；未命中 value 为 null。
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/precheck') {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === null || typeof body !== 'object' || typeof body.name !== 'string' || !Number.isFinite(Number(body.size)) || Number(body.size) <= 0) {
          json(res, { ok: false, error: '请求体须为 JSON 且含 name 与正数 size' }, 400)
          return
        }
        let root
        try {
          root = projectRoot(ctx, typeof body.sessionId === 'string' ? body.sessionId : '')
        } catch (err) {
          json(res, { ok: false, error: '无法解析项目根' }, 500)
          return
        }
        try {
          await ensureIndex(root)
          const hit = await dedupLookup(root, dedupKey(cleanName(body.name), Math.floor(Number(body.size))))
          if (hit !== null) {
            const base = hit.path.slice(Math.max(hit.path.lastIndexOf('/'), hit.path.lastIndexOf('\\')) + 1)
            json(res, { ok: true, value: { path: hit.path, name: base, size: hit.size, dir: join(root, ATTACHMENT_DIR), deduped: true } })
          } else {
            json(res, { ok: true, value: null })
          }
          return
        } catch (err) {
          json(res, { ok: false, error: err instanceof Error ? err.message : '预检失败' }, 500)
          return
        }
      }
      // 【已屏蔽 /version 路由，保留代码以备后用】
      // if (req.method === 'GET' && pathname === '/dsh-file-attachment/version') {
      //   try {
      //     const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
      //     const raw = await readFile(pkgPath, 'utf8')
      //     const pkg = JSON.parse(raw)
      //     json(res, { ok: true, version: pkg.version || '0.0.0' })
      //     return
      //   } catch {
      //     json(res, { ok: false, version: 'unknown' }, 500)
      //     return
      //   }
      // }
      if (req.method === 'GET' && pathname === '/dsh-file-attachment/config') {
        json(res, { ok: true, value: await readConfig() })
        return
      }
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/config') {
        const body = await readJsonBody(req, 64 * 1024)
        if (body === null || typeof body !== 'object') {
          json(res, { ok: false, error: '请求体必须是 JSON' }, 400)
          return
        }
        const value = await writeConfig(body)
        json(res, { ok: true, value: { saved: true, config: value } })
        return
      }
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/test') {
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (body === null || typeof body !== 'object') {
          json(res, { ok: false, error: '请求体必须是 JSON' }, 400)
          return
        }
        const vlm = normalizeVlm(body.vlm)
        if (!isVlmConfigured(vlm)) {
          json(res, { ok: false, error: VLM_CONFIG_ERROR }, 400)
          return
        }
        try {
          await testVlm(vlm)
          json(res, { ok: true })
          return
        } catch (err) {
          const message = err && err.message ? err.message : '视觉模型校验失败'
          json(res, { ok: false, error: message }, 502)
          return
        }
      }
      if (req.method === 'POST' && pathname === '/dsh-file-attachment/describe') {
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (body === null || typeof body !== 'object') {
          json(res, { ok: false, error: '请求体必须是 JSON（68MB 内）' }, 400)
          return
        }
        const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
        if (dataUrl === '') {
          json(res, { ok: false, error: 'dataUrl 必须是非空字符串（base64 data URL）' }, 400)
          return
        }
        const cfg = await readConfig()
        const vlm = cfg.vlm
        if (!isVlmConfigured(vlm)) {
          json(res, { ok: false, error: VLM_CONFIG_ERROR }, 400)
          return
        }
        try {
          const description = await describeImage(vlm, dataUrl, body.prompt)
          json(res, { ok: true, value: { description, thinkingType: vlm.thinkingType } })
          return
        } catch (err) {
          const message = err && err.message ? err.message : '识别失败'
          json(res, { ok: false, error: message }, 502)
          return
        }
      }
      json(res, { ok: false, error: 'only POST /dsh-file-attachment/save、POST /dsh-file-attachment/precheck、GET/POST /dsh-file-attachment/config、POST /dsh-file-attachment/test 与 POST /dsh-file-attachment/describe are allowed' }, 405)
    },
  })
}

// 图片扩展名判定（describe_image 工具用）
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/iu

/** 把 fs 常见错误码转成中文提示（其余错误原样抛出）。 */
function fsErrorToMessage(err, p) {
  const code = err !== null && err !== undefined ? err.code : undefined
  if (code === 'ENOENT') return new Error('图片文件不存在：' + p)
  if (code === 'EACCES' || code === 'EPERM') return new Error('图片文件无读取权限：' + p)
  if (code === 'EISDIR') return new Error('path 指向目录，不是图片文件：' + p)
  return err
}
// 门控涉及的两个工具名（注册与按-agent 隐藏共用同一标识）
const DESCRIBE_TOOL = 'describe_image'
const READ_TOOL = 'read_image' // host dsh-tool-fs 全局工具；纯文本模型调用它必抛 assertImageCapableRoute 错

/**
 * 多模态能力门控（对称双向）：按会话所选模型 inputModalities 对该 agent scope 调整工具可见性——
 *   支持图片（含 image）→ deny describe_image（host 原生 read_image 直接看图，无需 VLM 中转）；
 *   明确不支持（有 inputModalities 数组但不含 image）→ deny read_image
 *     （它对纯文本模型必然抛「does not declare image input」错，留着只会诱导模型走死路；
 *      移除后模型只剩 describe_image 作 VLM 兜底，不再出现该报错）；
 *   能力未知（absent / provider·model 缺失 / 查询抛错）→ 两边都不动（保守：宁留 VLM 也不误藏任何一边）。
 * 手段：agent.ctx.tools.restrict({ deny: [...] })——scoped-only，只影响该 agent 的工具装配，
 * 不影响其他会话；disposer 幂等管理（目标 deny 集变化时先释放旧限制再施加新的），
 * agent 销毁时随 scoped world 一并回退。
 * @param ctx - 插件宿主 Context（软依赖 llm / agents 服务）。
 */
function createVisionGate(ctx) {
  /** sessionId -> { appliedKey, release, seq }；appliedKey 记录当前生效的 deny 集，seq 丢弃过期异步结果 */
  const state = new Map()

  /** 三态能力判定：'vision'=声明含 image / 'text'=声明不含 / 'unknown'=无从得知。 */
  async function classifyCapability(provider, model) {
    const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return 'unknown'
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') return 'unknown'
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const mods = info && info.inputModalities
      if (!Array.isArray(mods)) return 'unknown' // absent = unknown，不是 negative capability
      return mods.includes('image') ? 'vision' : 'text'
    } catch (err) {
      console.warn('[dsh-file-attachment] resolveModelInfo failed, keep both tools:', err instanceof Error ? err.message : String(err))
      return 'unknown'
    }
  }

  /**
   * 对一个 live agent 重新评估能力并按需重设该 agent 的 deny 集。fire-and-forget，绝不阻塞 agent 创建。
   * @param agent - 目标 agent。
   * @param sel - 可选的最新选择（来自 durable `model/selection` 事件的 data）。
   *   路由优先级：sel > session.requestHeader().config（最近一次请求实际路由）> agent.options（创建快照）。
   *   ⚠️ agent.options 不随模型切换更新（selection 是经 waterfall 注入请求的可变状态），
   *   切换场景必须传 sel，否则按旧模型误判。
   */
  async function evaluate(agent, sel) {
    if (agent === null || agent === undefined || typeof agent.id !== 'string') return
    let s = state.get(agent.id)
    if (s === undefined) { s = { appliedKey: '', release: null, seq: 0 }; state.set(agent.id, s) }
    const mySeq = ++s.seq
    const opts = (agent.options && typeof agent.options === 'object') ? agent.options : {}
    let headerCfg
    try { headerCfg = (agent.session && typeof agent.session.requestHeader === 'function') ? agent.session.requestHeader()?.config : undefined } catch { headerCfg = undefined }
    const pick = (k) => ((sel && typeof sel[k] === 'string' && sel[k] !== '') ? sel[k] : ((headerCfg && typeof headerCfg[k] === 'string' && headerCfg[k] !== '') ? headerCfg[k] : opts[k]))
    const provider = pick('provider')
    const model = pick('model')
    const cap = await classifyCapability(provider, model)
    // 期间 agent 已销毁（state 条目被 dispose 删除）或有更新的评估在跑 → 本次结果作废
    if (state.get(agent.id) !== s || s.seq !== mySeq) return
    const deny = cap === 'vision' ? [DESCRIBE_TOOL] : cap === 'text' ? [READ_TOOL] : []
    const key = deny.join(',')
    console.log('[dsh-file-attachment] vision-gate:', String(model), 'cap=' + cap, 'deny=[' + key + ']')
    if (key === s.appliedKey) return
    try { if (s.release !== null) s.release() } catch { /* 可能已被 scoped unwind，忽略 */ }
    s.release = null
    s.appliedKey = ''
    if (deny.length > 0) {
      try {
        const tools = (agent.ctx && typeof agent.ctx === 'object') ? agent.ctx.tools : undefined
        if (tools === undefined || typeof tools.restrict !== 'function') return
        const release = tools.restrict({ deny })
        if (typeof release === 'function') { s.release = release; s.appliedKey = key }
      } catch (err) {
        console.warn('[dsh-file-attachment] restrict failed (' + key + '):', err instanceof Error ? err.message : String(err))
      }
    }
  }

  /** agent 销毁：释放 disposer 并清除状态。 */
  function dispose(sessionId) {
    const s = state.get(sessionId)
    if (s === undefined) return
    try { if (s.release !== null) s.release() } catch { /* scoped world 已回退，忽略 */ }
    state.delete(sessionId)
  }

  return { evaluate, dispose }
}

/** 按扩展名推断 MIME（缺省 image/png）。 */
function mimeFromPath(p) {
  const ext = String(p ?? '').toLowerCase().split('.').pop() || ''
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'png': return 'image/png'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    case 'bmp': return 'image/bmp'
    default: return 'image/png'
  }
}

/**
 * 注册 describe_image 工具：模型看到用户消息里的图片路径引用（@/绝对路径）时调用，
 * 读图片 → 调 VLM 识别 → 识别结果直接作为工具输出返回：
 * UI 展示描述文本，同时该输出即模型可见内容（tool/result 的 content 是 model-facing）。
 */
function registerTools(ctx) {
  const tools = (ctx !== undefined && ctx !== null && typeof ctx.tools === 'object' && ctx.tools !== null)
    ? ctx.tools
    : (typeof ctx.get === 'function' ? ctx.get('tools') : undefined)
  if (tools === undefined || typeof tools.register !== 'function') {
    console.warn('[dsh-file-attachment] tools 服务不可用，跳过 describe_image 注册')
    return
  }
  tools.register(defineTool({
    name: DESCRIBE_TOOL,
    description: '当用户消息里出现图片路径引用（形如 @/绝对路径，扩展名 png/jpg/jpeg/gif/webp/bmp）且需要理解图片内容时调用此工具，获取该图片的中文内容描述。path 参数填去掉前导 @ 的绝对路径。prompt 可选，指定要关注的内容（如"识别图中文字"、"描述 UI 布局"）。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '图片文件的绝对路径（去掉前导 @）',
      },
      prompt: {
        type: 'string',
        description: '可选。告诉多模态模型要关注什么（如"识别图中的文字"、"描述 UI 布局"）。不填则默认"请描述这张图片"。',
      },
      thinkingType: {
        type: 'string',
        enum: ['disabled', 'enabled'],
        description: 'VLM 思考模式开关：disabled=关闭（默认）/ enabled=开启。本工具默认关闭思考以加速识别，请填 disabled。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          description: { type: 'string' },
          thinkingType: { type: 'string', description: '当前 VLM 思考模式配置：enabled=开启 / disabled=关闭' },
        },
      },
      render: (_args, value) => {
        if (value && value.ok === true && typeof value.description === 'string' && value.description !== '') {
          return [{ type: 'text', text: '图片识别结果：' + value.description }]
        }
        return [{ type: 'text', text: (value && value.ok === true) ? '（图片已识别）' : '（图片识别失败）' }]
      },
    },
    async execute(args, exec) {
      let path = typeof args.path === 'string' ? args.path.trim() : ''
      if (path.startsWith('@')) path = path.slice(1)
      if (path === '') throw new Error('path 不能为空')
      if (!IMAGE_EXT.test(path)) throw new Error('path 不是受支持的图片（png/jpg/jpeg/gif/webp/bmp）')
      // 先 stat 拦截：非普通文件 / 空文件 / 超限大文件都不读入内存；
      // fs 错误（不存在 / 无权限 / 是目录）转成中文提示，不把 Node 原始报错抛给模型
      let st
      try {
        st = await stat(path)
      } catch (err) {
        throw fsErrorToMessage(err, path)
      }
      if (!st.isFile()) throw new Error('path 不是普通文件')
      if (st.size === 0) throw new Error('图片文件为空')
      if (st.size > MAX_DESCRIBE_BYTES) throw new Error('图片超过 ' + Math.round(MAX_DESCRIBE_BYTES / 1024 / 1024) + 'MB 上限，无法识别')
      let bytes
      try {
        bytes = await readFile(path)
      } catch (err) {
        throw fsErrorToMessage(err, path)
      }
      if (bytes.length === 0) throw new Error('图片文件为空')
      const dataUrl = 'data:' + mimeFromPath(path) + ';base64,' + bytes.toString('base64')
      const cfg = await readConfig()
      if (!isVlmConfigured(cfg.vlm)) throw new Error(VLM_CONFIG_ERROR + '，无法识别图片')
      const description = await describeImage(cfg.vlm, dataUrl, args.prompt)
      // 识别结果直接作为工具输出返回：UI 直接展示描述文本，
      // 同时该输出就是模型可见内容（tool/result 的 content），无需额外 deferContext 注入。
      // 注意 thinkingType 的双重角色：
      //   - 输入参数（args.thinkingType）：模型按 description 填充，仅用于让「工具调用 JSON」直观可见思考开关，
      //     实际调用 VLM 时不读它（真实开关以 cfg.vlm.thinkingType 为准，见 describeImage 内的 thinking.type）。
      //   - 输出（此处返回值）：回填配置真实值，使结果与输入展示一致、可核对。
      return { ok: true, description, thinkingType: cfg.vlm.thinkingType }
    },
  }))
  console.log('[dsh-file-attachment] describe_image tool registered')
}

/**
 * @param ctx - 宿主上下文（webServer + tools 注入）。
 */
export function apply(ctx, config = {}) {
  registerTools(ctx)
  registerRoutes(ctx)
  // ---- 对称双向能力门控：会话开始（agent/created）与模型切换（durable session 事件 model/selection）时，
  // 按所选模型 inputModalities 调整该 agent 的工具可见性：支持图片→deny describe_image；
  // 明确纯文本→deny read_image；未知→不动。路由取 sel > requestHeader.config > options。----
  const gate = createVisionGate(ctx)
  ctx.on('agent/created', ({ agent }) => { void gate.evaluate(agent) })
  ctx.on('agent/disposed', ({ agent }) => { gate.dispose(agent.id) })
  ctx.on('session/event', (session, event) => {
    if (event === null || event === undefined || event.type !== 'model/selection') return
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const agent = (agents !== undefined && typeof agents.get === 'function') ? agents.get(session.id) : undefined
    // 把 durable 事件里的最新 selection 直接喂给评估：agent.options 是创建快照、不会随切换更新
    if (agent !== undefined && agent !== null) void gate.evaluate(agent, event.data)
  })
  // 登记「插件配置」tab 的 settings 命名空间：让浏览器半侧的插件配置卡片
  // （settings.plugin.item，key = 本命名空间）被 tab 派发渲染。
  // 老版本 host（无 settings 服务，< 0.1.0-rc.7）此回调不运行，命名空间不登记，
  // 卡片不出现但不卸载整个插件（graceful degradation，与自动继续/插件市场同形）。
  ctx.inject(['settings'], (scopedCtx) => {
    if (FaAttachmentSchema) {
      scopedCtx.settings.register(SETTINGS_NS, FaAttachmentSchema, {})
    }
  })
  console.log('[dsh-file-attachment] host loaded (webServer routes + describe_image tool)')
}