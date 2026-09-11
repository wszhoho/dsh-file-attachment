// @wszhoho/dsh-file-attachment Host 半：webServer HTTP 路由方案。
// Client 半读取文件全文（base64）后 POST /dsh-file-attachment/save 到这里，
// 写入 <会话工作区根>/.dsh-file-attachment/<日期>/<文件名>（日期作子目录，文件名保留原始名）并返回 { path, dir, name, size }。
// 项目根解析：Client 传 sessionId → sessions.get(sessionId).header.cwd →
// sandboxPolicy.workspaceRoot → process.cwd()（三平台绝对路径，Node path.join 自适应分隔符）。
// 纯 ESM 无构建：不依赖 TypertRemoteService/装饰器，原生 Node 可直接加载。
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** 本包声明依赖的 Host 服务。 */
export const name = 'dsh-file-attachment'
export const inject = ['webServer', 'tools']

// 临时目录名：落在会话工作区根下；每个项目都能看到自己引用过的文档
const ATTACHMENT_DIR = '.dsh-file-attachment'
// 单文件上限 50MB（与 Client 半一致）
const MAX_BYTES = 50 * 1024 * 1024
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

/** 日期前缀：2026-02-11（ISO 日期前 10 位，各平台文件名安全且可排序）。 */
function stamp() {
  return new Date().toISOString().slice(0, 10) // 仅日期 YYYY-MM-DD
}

async function fileExists(target) {
  try {
    await access(target)
    return true
  } catch (err) {
    return false
  }
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

/** 严格 base64 解码（拒绝畸形输入）。 */
function decodeBase64(encoded) {
  if (typeof encoded !== 'string' || encoded === '') return undefined
  if (encoded.length % 4 !== 0) return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined
  const bytes = Buffer.from(encoded, 'base64')
  return bytes
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

// 多模态识别（VLM）默认参数：用户在「设置→文件附件」可覆盖；空值回退默认，保证开箱可用。
const VLM_DEFAULTS = {
  baseURL: 'https://api.xiaomimimo.com/v1',
  apiKey: '',
  model: 'mimo-v2.5',
  thinkingType: 'disabled',
}

/** 规范化多模态参数（缺省/空值回退默认，trim 去空白）。 */
function normalizeVlm(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {}
  const pick = (key) => (typeof r[key] === 'string' && r[key].trim() !== '' ? r[key].trim() : VLM_DEFAULTS[key])
  return {
    baseURL: pick('baseURL'),
    apiKey: pick('apiKey'),
    model: pick('model'),
    thinkingType: pick('thinkingType'),
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

/**
 * 保存一个上传文件并返回落盘信息。
 * @param root - 项目根（会话工作区）。
 * @param body - { name, data, sessionId }。
 * @returns { path, dir, name, size }。
 */
async function handleSave(root, body) {
  const name = body !== null && typeof body === 'object' ? body.name : undefined
  const data = body !== null && typeof body === 'object' ? body.data : undefined
  if (typeof data !== 'string' || data === '') throw new Error('data 必须是非空 base64 字符串')
  const bytes = decodeBase64(data)
  if (bytes === undefined) throw new Error('base64 内容非法')
  if (bytes.length === 0) throw new Error('解码后内容为空')
  if (bytes.length > MAX_BYTES) throw new Error('文件超过 ' + Math.round(MAX_BYTES / 1024 / 1024) + 'MB 上限')

  const dir = join(root, ATTACHMENT_DIR)
  const safe = cleanName(name)
  const t = stamp()
  // 时间戳作子目录名，文件保留原始文件名 → 芯片 basename 即原始名，不带时间戳前缀
  const subDir = join(dir, t)
  await mkdir(subDir, { recursive: true })
  const dot = safe.lastIndexOf('.')
  const stem = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  // 同一天内重复保存同名文件时追加序号，避免覆盖
  let target = join(subDir, safe)
  for (let i = 1; await fileExists(target); i += 1) {
    target = join(subDir, stem + '-' + i + ext)
  }
  await writeFile(target, bytes)
  return { path: target, dir, name: safe, size: bytes.length }
}

/**
 * 调 VLM（OpenAI 兼容 chat/completions）识别图片，返回中文描述。
 * @param vlm - 多模态参数 { baseURL, apiKey, model, thinkingType }（来自配置）。
 * @param dataUrl - base64 data URL（形如 data:image/png;base64,xxx）。
 * @returns 图片的简洁中文描述。
 * @throws VLM 请求失败或未返回有效内容时抛错。
 */
async function describeImage(vlm, dataUrl) {
  const url = vlm.baseURL.replace(/\/+$/u, '') + '/chat/completions'
  const payload = {
    model: vlm.model,
    thinkingType: vlm.thinkingType,
    messages: [
      { role: 'system', content: '你是图片描述助手，用简洁中文描述图片主要内容。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请描述这张图片。' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + vlm.apiKey,
    },
    body: JSON.stringify(payload),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error('VLM 请求失败 ' + resp.status + (text !== '' ? ' ' + text.slice(0, 200) : ''))
  }
  const data = await resp.json()
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (typeof content !== 'string' || content === '') throw new Error('VLM 未返回有效内容')
  return content
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
        const body = await readJsonBody(req, MAX_BODY_BYTES)
        if (body === null || typeof body !== 'object') {
          json(res, { ok: false, error: '请求体必须是 JSON（68MB 内）' }, 400)
          return
        }
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        let root
        try {
          root = projectRoot(ctx, sessionId)
        } catch (err) {
          json(res, { ok: false, error: '无法解析项目根' }, 500)
          return
        }
        try {
          const value = await handleSave(root, body)
          json(res, { ok: true, value })
          return
        } catch (err) {
          const message = err && err.message ? err.message : '保存失败'
          json(res, { ok: false, error: message }, 400)
          return
        }
      }
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
        if (vlm.apiKey === '') {
          json(res, { ok: false, error: '未配置多模态 API Key（设置→文件附件填写）' }, 400)
          return
        }
        try {
          const description = await describeImage(vlm, dataUrl)
          json(res, { ok: true, value: { description } })
          return
        } catch (err) {
          const message = err && err.message ? err.message : '识别失败'
          json(res, { ok: false, error: message }, 502)
          return
        }
      }
      json(res, { ok: false, error: 'only POST /dsh-file-attachment/save、GET/POST /dsh-file-attachment/config 与 POST /dsh-file-attachment/describe are allowed' }, 405)
    },
  })
}

// 图片扩展名判定（describe_image 工具用）
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/iu

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
 * 读图片 → 调 VLM 识别 → 描述仅注入模型上下文（deferContext，不进 UI/session 历史），
 * UI 只渲染简短确认。实现「图片进历史后自动识别、结果不发给用户」。
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
    name: 'describe_image',
    description: '当用户消息里出现图片路径引用（形如 @/绝对路径，扩展名 png/jpg/jpeg/gif/webp/bmp）且需要理解图片内容时调用此工具，获取该图片的中文内容描述。path 参数填去掉前导 @ 的绝对路径。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '图片文件的绝对路径（去掉前导 @）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value && value.ok === true) ? '（图片已识别，描述已注入上下文）' : '（图片识别失败）' },
      ],
    },
    async execute(args, exec) {
      let path = typeof args.path === 'string' ? args.path.trim() : ''
      if (path.startsWith('@')) path = path.slice(1)
      if (path === '') throw new Error('path 不能为空')
      if (!IMAGE_EXT.test(path)) throw new Error('path 不是受支持的图片（png/jpg/jpeg/gif/webp/bmp）')
      const bytes = await readFile(path)
      if (bytes.length === 0) throw new Error('图片文件为空')
      const dataUrl = 'data:' + mimeFromPath(path) + ';base64,' + bytes.toString('base64')
      const cfg = await readConfig()
      if (cfg.vlm.apiKey === '') throw new Error('未配置多模态 API Key（设置→文件附件填写），无法识别图片')
      const description = await describeImage(cfg.vlm, dataUrl)
      // 描述仅注入模型上下文（不进 session 历史 / UI），实现「结果不发给用户」
      exec.deferContext(createUserMessage({
        content: [{ type: 'text', text: '图片 ' + path + ' 的内容描述：' + description }],
        source: { kind: 'plugin', plugin: 'dsh-file-attachment' },
      }))
      return { ok: true }
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
  console.log('[dsh-file-attachment] host loaded (webServer routes + describe_image tool)')
}