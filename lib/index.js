// @local/dsh-fileAttachment Host 半：fileAttachment remote 服务。
// Client 半读取文件内容（base64）后经 remote.fileAttachment.save 调用这里，
// 写入 <会话工作区根>/.dsh-fileAttachment/<时间戳>-<文件名> 并返回 { path, dir, name, size }。
// 项目根解析顺序：session.header.cwd（Client 传 sessionId）→ sandboxPolicy.workspaceRoot → process.cwd()。
// 跨平台：会话 cwd 是各平台绝对路径；Node path.join 自动使用平台分隔符。
// SRC 模式约束（gateway 直接反射本方法，不经过类型编译）：
// - 方法签名只允许简单标识符参数（无默认值/解构/rest），由 Function.toString 解析；
// - 参数名不能撞 typert lookup 定义名（现有 lookup 为 agent/session），sessionId 安全；
// - 本包必须与 gateway 共享同一份 dsh-typert-protocol 模块实例
//   （包内 node_modules 软链指向 dsh 安装目录，realpath 一致，WeakMap 标记互通）。
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

// 临时目录名：落在会话工作区根下，每个项目都能看到自己引用过的文档
const ATTACHMENT_DIR = '.dsh-fileAttachment'
// 单文件上限 50MB（与 Client 半一致），防止拖入超大文件
const MAX_BYTES = 50 * 1024 * 1024
// 文件名非法字符：路径分隔符、Windows 保留字符、控制字符
const BAD_CHARS = /[/\\:*?"<>|\u0000-\u001f\u007f]/gu

// 时间戳前缀：2026-02-11T15-04-05（去掉冒号/毫秒/Z，兼容各平台文件名且可排序）
function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:.]/gu, '-')
}

async function fileExists(target) {
  try {
    await access(target)
    return true
  } catch (err) {
    return false
  }
}

// 解析项目根：优先当前会话 cwd；null 兜底 sandboxPolicy.workspaceRoot / process.cwd()
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

class FileAttachmentService extends TypertRemoteService {
  constructor(ctx) {
    super(ctx, 'fileAttachment')
  }
  // @Remote('save')：客户端经 remote 通道调用；签名只允许简单标识符参数（SRC 解析规则）
  @Remote('save')
  async save(fileName, content, sessionId) {
    if (typeof content !== 'string' || content === '') {
      throw new Error('fileAttachment: content 必须是非空 base64 字符串')
    }
    const bytes = Buffer.from(content, 'base64')
    if (bytes.length === 0) throw new Error('fileAttachment: 解码后内容为空')
    if (bytes.length > MAX_BYTES) {
      throw new Error('fileAttachment: 文件超过 ' + MAX_BYTES / 1024 / 1024 + 'MB 上限')
    }
    const root = projectRoot(this.ctx, sessionId)
    const dir = join(root, ATTACHMENT_DIR)
    await mkdir(dir, { recursive: true })
    // 文件名消毒：只取最后一段路径，非法字符替换为下划线，防止越出临时目录
    const raw = String(fileName === undefined || fileName === null ? '' : fileName)
    const base = raw.split(/[\\/]/u).pop() || ''
    const safe = base.replace(BAD_CHARS, '_').trim() || 'file'
    const t = stamp()
    const dot = safe.lastIndexOf('.')
    const stem = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    // 同一秒内重复保存同名文件时追加序号，避免覆盖
    let target = join(dir, t + '-' + safe)
    for (let i = 1; await fileExists(target); i += 1) {
      target = join(dir, t + '-' + stem + '-' + i + ext)
    }
    await writeFile(target, bytes)
    return { path: target, dir, name: t + '-' + safe, size: bytes.length }
  }
}

function apply(ctx) {
  new FileAttachmentService(ctx)
}

export { apply, FileAttachmentService }