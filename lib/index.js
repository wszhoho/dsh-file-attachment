// @wszhoho/dsh-file-attachment Host 半：webServer HTTP 路由方案（参考 dsh-upload-file 同架构）。
// Client 半读取文件全文（base64）后 POST /dsh-file-attachment/save 到这里，
// 写入 <会话工作区根>/.dsh-file-attachment/<日期>/<文件名>（日期作子目录，文件名保留原始名）并返回 { path, dir, name, size }。
// 项目根解析：Client 传 sessionId → sessions.get(sessionId).header.cwd →
// sandboxPolicy.workspaceRoot → process.cwd()（三平台绝对路径，Node path.join 自适应分隔符）。
// 纯 ESM 无构建：不依赖 TypertRemoteService/装饰器，原生 Node 可直接加载。
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 本包声明依赖的 Host 服务。 */
export const name = 'dsh-file-attachment'
export const inject = ['webServer']

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

/** 读取配置；文件缺失/损坏时回退默认值（保持三类齐全）。 */
async function readConfig() {
  try {
    const text = await readFile(CONFIG_PATH, 'utf8')
    const doc = JSON.parse(text)
    return {
      doc: normalizeTypeList(doc && doc.doc),
      code: normalizeTypeList(doc && doc.code),
      config: normalizeTypeList(doc && doc.config),
    }
  } catch (err) {
    return { doc: [...DEFAULT_TYPES.doc], code: [...DEFAULT_TYPES.code], config: [...DEFAULT_TYPES.config] }
  }
}

/** 保存配置（全量覆盖三类）；返回规范化后的配置。 */
async function writeConfig(body) {
  const next = {
    doc: normalizeTypeList(body && body.doc),
    code: normalizeTypeList(body && body.code),
    config: normalizeTypeList(body && body.config),
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
      json(res, { ok: false, error: 'only POST /dsh-file-attachment/save and GET/POST /dsh-file-attachment/config are allowed' }, 405)
    },
  })
}

/**
 * @param ctx - 宿主上下文（webServer 注入）。
 */
export function apply(ctx, config = {}) {
  registerRoutes(ctx)
  console.log('[dsh-file-attachment] host loaded (webServer routes)')
}