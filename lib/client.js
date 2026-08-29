// @wszhoho/dsh-file-attachment 浏览器半（client 半，全部功能在此）。
// 拖放/粘贴文件进输入框：
// 1) 纯图片 —— 不拦截事件，原样交给既有图片拖放路径（行为零变化）；
// 2) 文档（非图片文件）—— capture 阶段接管：浏览器端读取全文 → base64 →
//    fetch POST /dsh-file-attachment/save 落盘到 <会话工作区>/.dsh-file-attachment/ →
//    在草稿光标处插入 @绝对路径 引用；粘贴文件走同一核心；
// 3) 目录 —— 拒绝并 toast 提示「不支持拖入目录」（需求确认：不插引用）；
// 4) 纯文本粘贴（含目录路径字符串）—— 完全原生，不做任何改写。
// 5) 拖入任何文件时在 capture 阶段拦截应用自带「拖入图片…」DropOverlay 浮层。
// 通知：shell.overlay 浮动 toast（frame-wide，fixed 定位，点击穿透，不破坏布局）。
window.__ModuleLoader__.load({
	id: '@wszhoho/dsh-file-attachment',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const react = require('react')

		// Client 服务依赖：槽位 / 输入机 / 会话（与官方 dsh-upload-file 同范式）。
		// 保存文件不走 remote，而是 fetch POST 宿主 webServer 路由 /dsh-file-attachment/save。
		const inject = [
			"slots",
			"conversation",
			"sessions",
			"locale"
		]

		// ---- 模块级状态：document 监听器 / dock 槽（同步桥）/ overlay 槽（toast）共享 ----
		let ctxRef = null // apply 时记下 ctx，供远程调用与降级判断
		const bridge = {
			shell: null,          // 输入机 shell（insertReference/snapshot），来自当前会话
			actions: null,        // InputActions（setDraft/addImages...），来自当前会话
			input: undefined,     // 最新 InputState（draft/phase...），随渲染刷新
			conversation: undefined, // conversation 服务：登记草稿图片
			mounted: false,
			sessionId: '',        // 当前会话 id，宿主据此解析工作区根
			noticeText: null,     // 当前 toast 文本（模块级广播）
			noticeSub: null,      // toast 组件订阅的 setter
		}
		let noticeTimer = null
		const NOTICE_MS = 4000
		const MAX_BYTES = 50 * 1024 * 1024
		const MAX_DIM = 640 // 图片缩放：最长边上限（GIF 例外，原样保动画）
		// 可上传类型（三类：文档/代码/配置文件）；图片恒允许（image/*）。
		// 首启为默认值，apply/设置页 fetch 持久化配置（~/.dsh/file-attachment.json）后覆盖。
		const DEFAULT_TYPES = {
			doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'],
			code: ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bash', 'ps1', 'sql', 'r', 'lua', 'pl', 'log'],
			config: ['json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'xml', 'html', 'css'],
		}
		const allowedTypes = { doc: DEFAULT_TYPES.doc.slice(), code: DEFAULT_TYPES.code.slice(), config: DEFAULT_TYPES.config.slice() }
		let allowedExts = null // Set<ext>，rebuildAllowed 填充；上传校验用
		let acceptString = 'image/*' // 上传按钮 <input accept>，buildAccept 生成
		const acceptListeners = new Set() // accept 变化订阅（设置页保存 → 上传按钮重渲染）
		// 规范化扩展名列表（小写/去点/去重/仅 [a-z0-9]），与 host 侧同逻辑
		function normalizeList(arr) {
			const out = []
			const seen = new Set()
			if (!Array.isArray(arr)) return out
			for (const raw of arr) {
				const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/^\./u, '')
				if (s === '' || !/^[a-z0-9]+$/u.test(s) || seen.has(s)) continue
				seen.add(s)
				out.push(s)
			}
			return out
		}
		function rebuildAllowed() {
			const set = new Set()
			for (const key of ['doc', 'code', 'config']) for (const ext of allowedTypes[key]) set.add(ext)
			allowedExts = set
		}
		function buildAccept() {
			const parts = ['image/*']
			const set = new Set()
			for (const key of ['doc', 'code', 'config']) for (const ext of allowedTypes[key]) set.add(ext)
			for (const ext of set) parts.push('.' + ext)
			return parts.join(',')
		}
		// 应用配置：更新 allowedTypes → 重建校验 Set + accept → 通知上传按钮重渲染
		function applyConfig(cfg) {
			allowedTypes.doc = normalizeList(cfg && cfg.doc)
			allowedTypes.code = normalizeList(cfg && cfg.code)
			allowedTypes.config = normalizeList(cfg && cfg.config)
			rebuildAllowed()
			acceptString = buildAccept()
			for (const fn of acceptListeners) { try { fn() } catch (err) { /* 忽略订阅者异常 */ } }
		}
		// 拉取持久化配置；成功覆盖默认，失败保留默认。幂等（复用同一 Promise）
		let configPromise = null
		function loadConfig() {
			if (configPromise === null) {
				configPromise = (async () => {
					let cfg = null
					try {
						const r = await fetch('/dsh-file-attachment/config')
						const env = await r.json()
						if (env && env.ok === true && env.value && typeof env.value === 'object') cfg = env.value
					} catch (err) { /* 无配置接口时保留默认 */ }
					if (cfg) applyConfig(cfg)
					else { rebuildAllowed(); acceptString = buildAccept() }
					return allowedTypes
				})()
			}
			return configPromise
		}
		rebuildAllowed()
		acceptString = buildAccept()

		// ---- 通知广播：composer/dock 与 overlay toast 之间共享文本，自动消失 ----
		function publishNotice(text) {
			bridge.noticeText = text
			if (bridge.noticeSub !== null) bridge.noticeSub(text)
		}
		function announce(text) {
			publishNotice(text)
			if (noticeTimer !== null) clearTimeout(noticeTimer)
			noticeTimer = setTimeout(() => { noticeTimer = null; if (bridge.noticeText === text) publishNotice(null) }, NOTICE_MS)
		}

		// ---- 已附加文件（待发送）：runBatch 插入 chip 成功后登记，FaFileDock 渲染，发送后清空 ----
		let faSeq = 0
		const attached = new Map() // id -> { id, name, path, isImage, url, sessionId }
		const attachedListeners = new Set() // 变化订阅（FaFileDock 重渲染）
		function emitAttached() { for (const fn of attachedListeners) { try { fn() } catch (err) { /* 忽略 */ } } }
		function attachFile(entry) { attached.set(entry.id, entry); emitAttached() }
		function detachFile(id) { if (attached.delete(id)) emitAttached() }
		function clearAttachedFor(sid) {
			let changed = false
			for (const [id, e] of attached) if (e.sessionId === sid) { attached.delete(id); changed = true }
			if (changed) emitAttached()
		}

		// ---- 宿主保存调用：fetch POST 宿主 webServer 路由（签名同 dsh-upload-file attach）----
		async function saveFileToHost(fileName, b64, sessionId) {
			if (typeof fetch !== 'function') throw new Error('当前环境无 fetch，无法上传')
			let response
			try {
				response = await fetch('/dsh-file-attachment/save', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ name: fileName, data: b64, sessionId: sessionId }),
				})
			} catch (err) {
				throw new Error('无法连接宿主上传服务（网络错误）')
			}
			let envelope
			try {
				envelope = await response.json()
			} catch (err) {
				throw new Error('宿主返回非 JSON（HTTP ' + response.status + '）')
			}
			const record = envelope !== null && typeof envelope === 'object' ? envelope : null
			if (record !== null && record.ok === true && record.value !== null && typeof record.value === 'object') {
				const value = record.value
				if (typeof value.path === 'string' && value.path !== '') return value
				throw new Error('宿主保存返回缺少 path')
			}
			const errMsg = record !== null && typeof record.error === 'string' && record.error !== '' ? record.error : '宿主保存失败（HTTP ' + response.status + '）'
			throw new Error(errMsg)
		}

		// ---- 图片处理：扩展名 / GIF 判定 / 加载 / 缩放（≤MAX_DIM，GIF 原样保动画，PNG 保透明） ----
		function fileExt(name) {
			const s = String(name == null ? '' : name)
			const dot = s.lastIndexOf('.')
			return dot > 0 ? s.slice(dot + 1).toLowerCase() : ''
		}
		function isGif(file) {
			const t = String(file && file.type ? file.type : '').toLowerCase()
			return t === 'image/gif' || fileExt(file && file.name) === 'gif'
		}
		function loadImage(url) {
			return new Promise((resolve, reject) => {
				const img = new Image()
				img.onload = () => resolve(img)
				img.onerror = () => reject(new Error('图片解码失败'))
				img.src = url
			})
		}
		// 缩放：最长边 > maxDim 时等比缩小；返回 { data, name }（data 为 Blob/File）。
		// GIF 原样（canvas 取首帧丢动画 + 不支持 gif 输出）；PNG 输出 PNG 保透明；其余 JPEG 0.85。
		// 缩放失败/无需缩放时回退原文件。
		async function downscaleImage(file, maxDim) {
			if (isGif(file)) return { data: file, name: file.name }
			let url = ''
			try {
				url = URL.createObjectURL(file)
				const img = await loadImage(url)
				const w = img.naturalWidth || img.width || 0
				const h = img.naturalHeight || img.height || 0
				if (!w || !h) return { data: file, name: file.name }
				const scale = Math.min(1, maxDim / Math.max(w, h))
				if (scale >= 1) return { data: file, name: file.name } // 已够小，原样
				const nw = Math.max(1, Math.round(w * scale))
				const nh = Math.max(1, Math.round(h * scale))
				const canvas = document.createElement('canvas')
				canvas.width = nw
				canvas.height = nh
				canvas.getContext('2d').drawImage(img, 0, 0, nw, nh)
				const isPng = String(file.type || '').toLowerCase() === 'image/png' || fileExt(file.name) === 'png'
				const mime = isPng ? 'image/png' : 'image/jpeg'
				const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.85))
				if (!blob) return { data: file, name: file.name }
				// 输出 mime 决定扩展名（png→.png，jpeg→.jpg）；文件名主体保留
				const base = file.name.lastIndexOf('.') > 0 ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name
				const name = base + (mime === 'image/png' ? '.png' : '.jpg')
				return { data: blob, name }
			} catch (err) {
				return { data: file, name: file.name } // 缩放失败回退原文件
			} finally {
				if (url !== '') URL.revokeObjectURL(url)
			}
		}

		// 复刻 dsh-file-reference 的 formatFileMention：
		// 目录补尾斜杠；含不可表示字符返回 undefined；含空白走引号形式（目录引号保持开启）
		function hasBadChar(p) {
			for (let i = 0; i < p.length; i++) {
				const c = p.charCodeAt(i)
				if (c === 34 || c < 32 || (c >= 127 && c <= 159)) return true
			}
			return false
		}
		// 等价于 /\s/u 的空白判定（含不可见分隔符）
		function isSpace(c) {
			return c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160 || c === 5760
				|| (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279
		}
		function formatMention(path, isDir) {
			const p = isDir ? path + '/' : path
			if (hasBadChar(p)) return undefined
			for (let i = 0; i < p.length; i++) {
				if (isSpace(p.charCodeAt(i))) return isDir ? '@"' + p : '@"' + p + '"'
			}
			return '@' + p
		}

		// 把浏览器提供的路径源（webkitGetAsEntry().fullPath / file.path）规范化为绝对路径
		function isDrivePath(p) {
			if (p.length < 3) return false
			const c0 = p.charCodeAt(0); const c1 = p.charCodeAt(1); const c2 = p.charCodeAt(2)
			const isLetter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)
			return isLetter && c1 === 58 && (c2 === 47 || c2 === 92)
		}
		function resolveDropPath(raw) {
			if (typeof raw !== 'string' || raw === '') return null
			// Chrome 虚拟文件系统会给盘符路径加前导斜杠：/C:/... 或 /C:\...
			let p = raw
			if (p.length > 3 && p.charCodeAt(0) === 47 && p.charCodeAt(2) === 58
				&& (p.charCodeAt(3) === 47 || p.charCodeAt(3) === 92)) p = p.slice(1)
			if (isDrivePath(p) || (p.length > 0 && p.charCodeAt(0) === 47)) return p
			return null
		}
		// 取路径最后一段（等价 split(/[\\/]/).filter(Boolean).pop()，charCode 版防转义损坏）
		function lastSegment(s) {
			let seg = ''
			let cur = ''
			for (let i = 0; i < s.length; i++) {
				const c = s.charCodeAt(i)
				if (c === 47 || c === 92) { if (cur !== '') { seg = cur; cur = '' } }
				else cur += s.charAt(i)
			}
			if (cur !== '') seg = cur
			return seg
		}

		// 找可写的 composer textarea：可见、未禁用、未只读、phase 为 plain；
		// 多个候选时优先 value 与桥内草稿一致的那一个（排除审批弹窗里的同名元素）
		function findComposerTextarea() {
			const list = Array.from(document.querySelectorAll('[data-composer-card] textarea'))
			const live = list.filter((ta) => {
				if (ta.disabled || ta.readOnly) return false
				const phase = ta.getAttribute('data-phase')
				if (phase !== null && phase !== 'plain') return false
				return ta.getClientRects().length > 0
			})
			if (live.length === 0) return null
			const draft = bridge.input !== void 0 ? bridge.input.draft : undefined
			if (typeof draft === 'string') {
				for (let i = 0; i < live.length; i++) {
					if (live[i].value === draft) return live[i]
				}
			}
			return live[0]
		}

		// 在光标（或选区）处插入文本；setDraft 是唯一的草稿写路径
		function insertTextAtCaret(ta, actions, text) {
			const draft = ta.value
			let start = ta.selectionStart
			let end = ta.selectionEnd
			if (typeof start !== 'number' || start < 0 || start > draft.length) start = draft.length
			if (typeof end !== 'number' || end < start) end = start
			const before = draft.slice(0, start)
			const after = draft.slice(end)
			const padStart = before.length > 0 && !isSpace(before.charCodeAt(before.length - 1)) ? ' ' : ''
			const padEnd = after.length > 0 && !isSpace(after.charCodeAt(0)) ? ' ' : ''
			const next = before + padStart + text + padEnd + after
			const caret = start + padStart.length + text.length + padEnd.length
			actions.setDraft(next)
			// React 重渲染会覆盖光标，下一帧校验写入成功后回填 selectionRange（同既有输入路径模式）
			if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
				window.requestAnimationFrame(() => {
					if (ta.value !== next) return // 写入被输入机拒绝，不动光标
					try {
						ta.focus({ preventScroll: true })
						ta.setSelectionRange(caret, caret)
					} catch (err) { /* 忽略：光标回填失败不影响草稿内容 */ }
				})
			}
		}

		function hasFiles(dataTransfer) {
			const types = dataTransfer && dataTransfer.types
			if (!types) return false
			for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
			return false
		}

		// 手动 3 字节 base64（不依赖 btoa，纯 JS；50MB 上限内拼接安全）
		const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
		function bytesToBase64(bytes) {
			let out = ''
			for (let i = 0; i < bytes.length; i += 3) {
				const a = bytes[i]
				const b = i + 1 < bytes.length ? bytes[i + 1] : 0
				const c = i + 2 < bytes.length ? bytes[i + 2] : 0
				out += B64C.charAt(a >> 2)
				out += B64C.charAt(((a & 3) << 4) | (b >> 4))
				out += i + 1 < bytes.length ? B64C.charAt(((b & 15) << 2) | (c >> 6)) : '='
				out += i + 2 < bytes.length ? B64C.charAt(c & 63) : '='
			}
			return out
		}

		// 触发应用自身 drop 浮层的关闭：应用在 window 上监听 dragend 执行 reset()。
		// 从 OS 拖入时浏览器不派发 dragend，且我们拦截 drop 后应用的 drop 监听收不到事件，浮层会残留。
		function dismissDropOverlay() {
			try { window.dispatchEvent(new Event('dragend')) } catch (err) { /* 尽力而为 */ }
		}

		// capture 阶段拦截 dragenter：应用自身 DropOverlay 文案固定为「拖入图片…」，
		// 拖入任何文件都会误提示；这里阻止应用注册的 dragenter 监听执行。
		function onDragEnterCap(e) {
			const dt = e.dataTransfer
			if (dt === null || dt === undefined || !hasFiles(dt)) return
			e.preventDefault()
			e.stopImmediatePropagation()
		}

		// 拖放/粘贴文件共用核心。source：'drop' | 'paste'
		// 返回是否已接管事件（false = 纯图片拖放/粘贴，原样交给既有图片路径）
		function handleFilesEvent(e, files, items, source) {
			const images = []
			const docs = [] // { path, name, isDir, file }
			for (let i = 0; i < files.length; i++) {
				const file = files[i]
				if (file.type && file.type.indexOf('image/') === 0) { images.push(file); continue }
				let entry = null
				const item = items ? items[i] : null
				if (item && typeof item.webkitGetAsEntry === 'function') {
					try { entry = item.webkitGetAsEntry() } catch (err) { entry = null }
				}
				let raw = entry ? entry.fullPath : null
				if (raw === null || raw === undefined) raw = file.path !== void 0 ? file.path : null
				const isDir = !!(entry && entry.isDirectory)
				let name = file.name
				if (name === '' && typeof raw === 'string') { const seg = lastSegment(raw); if (seg !== '') name = seg }
				docs.push({ path: resolveDropPath(raw), name, isDir, file })
			}

			// 无输入桥（hero/blank 未就绪）：纯图片交原生图片路径保留行为；含文档则提示不可用
			if (bridge.shell === null) {
				if (docs.length === 0) return false
				e.preventDefault()
				e.stopImmediatePropagation()
				dismissDropOverlay()
				announce('输入框不可用')
				return true
			}
			// 有输入桥：接管全部（图片 + 文档统一落盘 → 芯片），彻底绕开 dsh 原生图片发送流程（解 413）
			e.preventDefault()
			e.stopImmediatePropagation()
			dismissDropOverlay()
			void runBatch(images, docs)
			return true
		}

		// 异步批处理：文档 + 图片统一落盘 → shell.insertReference 芯片（不显示长路径，发送还原 @ 路径）。
		// 图片先 downscale（≤MAX_DIM，GIF 原样保动画）；目录拒绝；扩展名按配置校验（图片恒允许）。
		async function runBatch(images, docs) {
			const shell = bridge.shell
			if (shell === null || typeof shell.insertReference !== 'function') {
				announce(`输入框不可用 [mounted:${bridge.mounted} shell:${shell === null ? 'null' : 'ok'} addImg:${typeof bridge.addImages}]`)
				return
			}
			const snap0 = shell.snapshot
			const phase = snap0 ? snap0.phase : 'plain'
			if (phase !== 'plain' && phase !== 'command' && phase !== 'claimed') {
				announce('输入框正忙')
				return
			}
			// 汇总待上传项：图片恒允许；文档按配置扩展名校验；目录拒绝
			const items = []
			for (let i = 0; i < docs.length; i++) {
				const d = docs[i]
				items.push({ file: d.file, name: d.name, isImage: false, isDir: d.isDir })
			}
			for (let i = 0; i < images.length; i++) items.push({ file: images[i], name: images[i].name, isImage: true, isDir: false })
			const pending = []
			let dirRejected = 0
			let rejectedExt = 0
			for (let i = 0; i < items.length; i++) {
				const it = items[i]
				if (it.isDir) { dirRejected += 1; continue }
				if (it.isImage) { pending.push(it); continue }
				const ext = fileExt(it.name)
				if (ext === '' || allowedExts === null || !allowedExts.has(ext)) { rejectedExt += 1; continue }
				pending.push(it)
			}
			if (pending.length === 0) {
				if (dirRejected > 0 && rejectedExt === 0) { announce('不支持拖入目录'); return }
				if (rejectedExt > 0) { announce('文件类型不在允许列表（设置→文件附件可调整）'); return }
				return
			}
			let inserted = 0
			let failed = 0
			for (let i = 0; i < pending.length; i++) {
				const it = pending[i]
				try {
					if (it.isImage) {
						// 图片完全走 dsh 原生链路：addImages（草稿图片），不缩放/不落盘/不进文件条
						const addImages = typeof bridge.addImages === 'function' ? bridge.addImages : null
						if (addImages === null) { failed += 1; continue }
						let imgErr = null; try { imgErr = addImages([it.file]) } catch (err) { imgErr = err instanceof Error ? err.message : String(err) }
						if (imgErr) { failed += 1; continue }
						inserted += 1
						continue
					}
					// 文档：原样落盘 → @引用芯片 + 文件条登记
					const data = it.file
					const name = it.name
					if (data === null || typeof data.size !== 'number' || data.size === 0) throw new Error('size')
					if (data.size > MAX_BYTES) throw new Error('size')
					const buf = await data.arrayBuffer()
					const b64 = bytesToBase64(new Uint8Array(buf))
					const res = await saveFileToHost(name, b64, bridge.sessionId)
					const m = formatMention(res.path, false)
					const clipboardText = m !== undefined ? m : '@' + res.path
					// 每次插入前重取 snapshot（draftRev 随插入递增，span 取当前末尾）
					const snap = shell.snapshot
					const span = { draftRev: snap.draftRev, start: snap.draft.length, end: snap.draft.length }
					const okInsert = shell.insertReference(
						{
							source: 'reference', // 复用内置已注册的 @引用 source（带 codec.serialize），否则报 no serializer
							ref: clipboardText, // codec.serialize 原样返回 ref 作为模型文本，故放完整 @路径
							label: name,
							appearance: 'file',
							clipboardText: clipboardText,
						},
						span,
					)
					if (okInsert) {
						inserted += 1
						// 登记到文件条（文档：类型图标 + 点击打开；图片走原生 addImages 不登记）
						attachFile({ id: 'fa' + (++faSeq), name, path: res.path, isImage: false, url: null, sessionId: bridge.sessionId })
					} else failed += 1
				} catch (err) {
					failed += 1
				}
			}
			if (inserted === 0) {
				if (dirRejected > 0 && rejectedExt === 0 && failed === 0) { announce('不支持拖入目录'); return }
				announce('文件处理失败')
				return
			}
			const skipped = failed + rejectedExt
			if (skipped > 0) announce(inserted + ' 个已插入 · ' + skipped + ' 个已跳过')
		}

		// document 级 drop（capture）：保证先于图片路径的 document 级 bubble 监听器执行
		function onDrop(e) {
			const dt = e.dataTransfer
			if (!dt || !hasFiles(dt)) return
			const files = Array.prototype.slice.call(dt.files)
			if (files.length === 0) return
			handleFilesEvent(e, files, dt.items, 'drop')
		}

		// document 级 paste（capture）：仅当粘贴目标就是 composer textarea 时接管文件；
		// 纯文本（含目录路径字符串）完全原生，不改写。
		function onPaste(e) {
			const t = e.target
			const ta = findComposerTextarea()
			if (ta === null || t !== ta) return
			const cd = e.clipboardData
			if (cd === null || cd === void 0) return
			const files = Array.prototype.slice.call(cd.files)
			if (files.length > 0) {
				handleFilesEvent(e, files, cd.items, 'paste')
				return
			}
			// 纯文本：不干预，走原生行为
		}

		// shell.overlay 槽：frame-wide 浮动层（官方定位：badge / toast / status pill）。
		// 通知在此渲染为底部浮动 toast，自动消失、点击穿透、不破坏布局。
		function FaToast(props) {
			const state = react.useState(null)
			const text = state[0]
			const setText = state[1]
			react.useEffect(() => {
				if (bridge.noticeText !== null) setText(bridge.noticeText)
				bridge.noticeSub = setText
				return () => { if (bridge.noticeSub === setText) bridge.noticeSub = null }
			})
			if (text === null || text === '') return null
			return react.createElement('div', {
				style: {
					position: 'fixed',
					bottom: '24px',
					left: '50%',
					transform: 'translateX(-50%)',
					zIndex: 2000,
					maxWidth: 'min(640px, calc(100vw - 48px))',
					background: 'rgba(20, 24, 35, 0.92)',
					color: '#f2f4f8',
					padding: '10px 16px',
					borderRadius: '10px',
					fontSize: '13px',
					lineHeight: '1.5',
					boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
					pointerEvents: 'none',
				},
			}, text)
		}

		// input.dock 槽：比 composer.dock 更早且不受 hero（首轮空白无底部栏）限制，
		// 仅同步桥（actions/input/sessionId/conversation），不渲染可见文本。
		function FaBridge(props) {
			const sessionId = props.sessionId !== void 0 ? props.sessionId : ''
			// inject 只传 sessionId（string 可靠）；shell/addImages 由本组件经 ctxRef 自行计算（dsh slot 对 inject 返回的 object/function 会丢失）
			let shell = null
			let addImages = null
			try {
				const ctx = ctxRef
				if (ctx !== null && sessionId !== '') {
					const conversation = ctx.get('conversation')
					const actx = ctx.sessions.scope(sessionId)
					if (conversation !== void 0 && actx !== void 0) {
						shell = conversation.input.for(actx)
						if (shell !== null) {
							addImages = (files) => {
								try {
									const images = conversation.createDraftImages(files)
									if (!shell.addImages(images.map((image) => image.id))) conversation.releaseDraftImages(images)
									return null
								} catch (error) {
									return error instanceof Error ? error.message : String(error)
								}
							}
						}
					}
				}
			} catch (err) { shell = null; addImages = null }
			const input = shell !== null && shell.snapshot !== void 0 ? shell.snapshot : undefined
			react.useEffect(() => {
				bridge.shell = shell
				bridge.addImages = addImages
				bridge.input = input
				bridge.sessionId = sessionId
				bridge.mounted = true
				return () => {
					bridge.shell = null
					bridge.addImages = null
					bridge.input = undefined
					bridge.sessionId = ''
					bridge.mounted = false
				}
			})
			return null
		}

		// 文件类型图标：文档轮廓 SVG + 扩展名缩写（颜色继承 currentColor）
		function fileGlyph(name) {
			const ext = (fileExt(name) || '').toUpperCase().slice(0, 4) || 'FILE'
			return react.createElement('svg', { width: 18, height: 20, viewBox: '0 0 18 20', 'aria-hidden': true, style: { display: 'block' } },
				react.createElement('path', { d: 'M3 1h8l4 4v14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z', fill: 'rgba(128,128,128,0.22)', stroke: 'currentColor', strokeWidth: 1 }),
				react.createElement('path', { d: 'M11 1v4h4', fill: 'none', stroke: 'currentColor', strokeWidth: 1 }),
				react.createElement('text', { x: 9, y: 14, textAnchor: 'middle', fontSize: 5.5, fill: 'currentColor', fontFamily: 'monospace' }, ext),
			)
		}

		// 文件条（输入框上方 dock）：图片真缩略图 / 文件类型图标，点击用默认程序打开，可移除，发送后自动清空。
		function FaFileDock() {
			const [, force] = react.useState(0)
			react.useEffect(() => {
				const fn = () => force(n => n + 1)
				attachedListeners.add(fn)
				return () => { attachedListeners.delete(fn) }
			}, [])
			// 发送后清空：轮询 shell.snapshot，occurrences 从有→无 即一次发送完成
			const hadOcc = react.useRef(false)
			react.useEffect(() => {
				const timer = setInterval(() => {
					const shell = bridge.shell
					const snap = shell ? shell.snapshot : null
					const occ = snap ? snap.occurrences : null
					const has = !!(occ && occ.length > 0)
					const s = bridge.sessionId
					if (has) hadOcc.current = true
					else if (hadOcc.current && s) { hadOcc.current = false; clearAttachedFor(s) }
				}, 400)
				return () => clearInterval(timer)
			}, [])
			const sid = bridge.sessionId
			const entries = Array.from(attached.values()).filter(e => e.sessionId === sid)
			if (entries.length === 0) return null
			return react.createElement('div', {
				style: {
					display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center',
					width: '100%', maxWidth: 'calc(var(--dsh-composer-card-max-width, 720px) - 24px)',
					margin: '0 auto 6px', padding: '2px 4px', boxSizing: 'border-box',
				},
			},
				entries.map(e =>
					react.createElement('div', { key: e.id, style: {
						display: 'inline-flex', alignItems: 'center', gap: '6px',
						background: 'rgba(128,128,128,0.12)', border: '1px solid rgba(128,128,128,0.2)',
						borderRadius: '8px', padding: '3px 8px', fontSize: '12px', lineHeight: '1.4', maxWidth: '240px',
					} },
						e.isImage && e.url
							? react.createElement('img', { src: e.url, alt: '', style: { width: '20px', height: '20px', objectFit: 'cover', borderRadius: '4px', flex: 'none' } })
							: react.createElement('span', { style: { display: 'inline-flex', width: '20px', height: '20px', flex: 'none', color: 'inherit' } }, fileGlyph(e.name)),
						react.createElement('span', {
							style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
						}, e.name),
						react.createElement('span', {
							onClick: () => detachFile(e.id),
							title: '移除',
							style: { cursor: 'pointer', opacity: 0.6, fontSize: '14px', lineHeight: '1', flex: 'none', padding: '0 2px' },
						}, '×'),
					)
				),
			)
		}

		// conversation.input.left 槽（操作行左侧动作区，官方扩展点）：文件上传按钮。
		// 点击触发隐藏 <input type=file multiple>（PC/移动端原生文件选择器，accept 过滤图片+常见文档），
		// 选中后复用既有 runBatch 管线：文档落盘→@引用插入，图片走 createDraftImages+addImages 草稿机制。
		// 运行状态经 bridge（FaBridge 在 input.dock 槽填充 actions/input/sessionId，apply 填充 conversation）。
		function FaUploadButton() {
			const inputRef = react.useRef(null)
			const busyState = react.useState(false)
			const busy = busyState[0]
			const setBusy = busyState[1]
			// 订阅 accept 变化（设置页保存配置 → 重渲染，accept 属性随之刷新）
			const [, forceAccept] = react.useState(0)
			react.useEffect(() => {
				const fn = () => forceAccept((n) => n + 1)
				acceptListeners.add(fn)
				return () => { acceptListeners.delete(fn) }
			}, [])
			function onClick() {
				const el = inputRef.current
				if (el === null || busy) return
				el.click()
			}
			async function onChange(e) {
				const list = e.target.files
				if (list === null || list.length === 0) return
				const images = []
				const docs = []
				for (let i = 0; i < list.length; i++) {
					const file = list[i]
					if (file.type && file.type.indexOf('image/') === 0) { images.push(file); continue }
					docs.push({ path: null, name: file.name, isDir: false, file })
				}
				setBusy(true)
				try {
					await runBatch(images, docs)
				} finally {
					// 重置 input 值，允许再次选择同名文件
					e.target.value = ''
					setBusy(false)
				}
			}
			return react.createElement('span', { style: { display: 'inline-flex', alignItems: 'center' } },
				react.createElement('input', {
					ref: inputRef,
					type: 'file',
					multiple: true,
					accept: acceptString,
					style: { display: 'none' },
					onChange: onChange,
				}),
				react.createElement('button', {
					type: 'button',
					title: '上传文件',
					'aria-label': '上传文件',
					disabled: busy,
					onClick: onClick,
					style: {
						display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
						width: '28px', height: '28px', padding: 0, margin: 0, border: 'none',
						background: 'transparent', color: 'inherit',
						cursor: busy ? 'default' : 'pointer', borderRadius: '6px',
						opacity: busy ? 0.45 : 1, transition: 'background 120ms ease, opacity 120ms ease',
					},
					onMouseEnter: (ev) => { if (!busy) ev.currentTarget.style.background = 'rgba(128,128,128,0.16)' },
					onMouseLeave: (ev) => { ev.currentTarget.style.background = 'transparent' },
				},
					react.createElement('svg', {
						width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
						'aria-hidden': true, style: { display: 'block' },
					},
						react.createElement('path', {
							d: 'M8 13V3M8 3L4 7M8 3L12 7',
							stroke: 'currentColor', strokeWidth: 1.5,
							strokeLinecap: 'round', strokeLinejoin: 'round',
						})
					)
				)
			)
		}

		// 扩展名规范化：小写/去前导点/仅 [a-z0-9]；非法返回 null
		function normExt(v) {
			const s = String(v == null ? '' : v).trim().toLowerCase().replace(/^\.+/u, '')
			return (s !== '' && /^[a-z0-9]+$/u.test(s)) ? s : null
		}
		function addExt(setList, value, current) {
			const s = normExt(value)
			if (s === null || current.indexOf(s) >= 0) return
			setList(current.concat(s))
		}
		function removeExt(setList, current, idx) {
			const next = current.slice()
			next.splice(idx, 1)
			setList(next)
		}

		// 设置页扩展名分组：标题 + 可删 tag + 输入框 + 添加按钮
		function FaExtGroup(props) {
			const list = props.list
			const setList = props.setList
			const input = props.input
			const setInput = props.setInput
			function commit() { addExt(setList, input, list); setInput('') }
			const tags = list.map((ext, i) => react.createElement('span', {
				key: i,
				style: {
					display: 'inline-flex', alignItems: 'center',
					padding: '2px 8px', margin: '2px', borderRadius: '6px',
					background: 'rgba(128,128,128,0.14)', fontSize: '12px', fontFamily: 'monospace',
				},
			},
				ext,
				react.createElement('span', {
					onClick: () => removeExt(setList, list, i),
					style: { cursor: 'pointer', marginLeft: '4px', opacity: 0.55 },
				}, '×')
			))
			return react.createElement('div', { style: { marginBottom: '18px' } },
				react.createElement('div', { style: { fontWeight: 600, marginBottom: '8px', fontSize: '13px' } }, props.title),
				react.createElement('div', { style: { marginBottom: '8px', minHeight: '22px' } }, tags),
				react.createElement('div', { style: { display: 'flex', gap: '8px' } },
					react.createElement('input', {
						value: input,
						placeholder: '如 pdf / docx / py（回车或点「添加」）',
						style: { flex: 1, padding: '6px 10px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.3)', fontSize: '13px' },
						onChange: (e) => setInput(e.target.value),
						onKeyDown: (e) => { if (e.key === 'Enter') commit() },
					}),
					react.createElement('button', {
						type: 'button', onClick: commit,
						style: { padding: '6px 14px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.3)', background: 'none', cursor: 'pointer', fontSize: '13px' },
					}, '添加')
				)
			)
		}

		// 设置页：配置可上传的文档/代码/配置文件扩展名，保存写 ~/.dsh/file-attachment.json
		function FaSettingsPage() {
			const [doc, setDoc] = react.useState(DEFAULT_TYPES.doc.slice())
			const [code, setCode] = react.useState(DEFAULT_TYPES.code.slice())
			const [config, setConfig] = react.useState(DEFAULT_TYPES.config.slice())
			const [docIn, setDocIn] = react.useState('')
			const [codeIn, setCodeIn] = react.useState('')
			const [cfgIn, setCfgIn] = react.useState('')
			const [saved, setSaved] = react.useState(false)
			const [saving, setSaving] = react.useState(false)
			react.useEffect(() => {
				// 挂载时载入持久化配置到编辑副本（幂等，复用 loadConfig Promise）
				let live = true
				loadConfig().then(() => {
					if (!live) return
					setDoc(allowedTypes.doc.slice())
					setCode(allowedTypes.code.slice())
					setConfig(allowedTypes.config.slice())
				})
				return () => { live = false }
			}, [])
			function t(key) {
				if (ctxRef !== null && ctxRef.locale !== void 0 && typeof ctxRef.locale.bind === 'function') {
					try { return ctxRef.locale.bind('dsh-file-attachment')(key) } catch (err) { /* 回退 key */ }
				}
				return key
			}
			async function save() {
				setSaving(true); setSaved(false)
				try {
					const body = { doc: doc, code: code, config: config }
					const r = await fetch('/dsh-file-attachment/config', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
					})
					const env = await r.json()
					if (env && env.ok === true) {
						applyConfig(body) // 立即生效：更新 allowedExts + accept（上传按钮随之刷新）
						setSaved(true)
						setTimeout(() => setSaved(false), 2000)
					} else {
						announce('保存失败')
					}
				} catch (err) {
					announce('保存失败')
				} finally { setSaving(false) }
			}
			return react.createElement('div', { style: { padding: '16px', maxWidth: '680px' } },
				react.createElement('div', { style: { marginBottom: '16px', fontSize: '13px', color: 'rgba(128,128,128,0.9)' } }, t('settings.hint')),
				react.createElement(FaExtGroup, { title: t('doc.title'), list: doc, setList: setDoc, input: docIn, setInput: setDocIn }),
				react.createElement(FaExtGroup, { title: t('code.title'), list: code, setList: setCode, input: codeIn, setInput: setCodeIn }),
				react.createElement(FaExtGroup, { title: t('config.title'), list: config, setList: setConfig, input: cfgIn, setInput: setCfgIn }),
				react.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
					react.createElement('button', {
						type: 'button', onClick: save, disabled: saving,
						style: {
							padding: '8px 20px', borderRadius: '8px', border: 'none',
							background: 'rgba(80,120,220,0.9)', color: '#fff',
							cursor: saving ? 'default' : 'pointer', fontSize: '13px', opacity: saving ? 0.6 : 1,
						},
					}, saving ? t('saving') : t('save')),
					saved ? react.createElement('span', { style: { fontSize: '13px', color: 'rgba(80,160,120,0.95)' } }, t('saved')) : null
				)
			)
		}

		function apply(ctx) {
			ctxRef = ctx
			// 接入即拉持久化配置（幂等）：让自定义类型每次会话生效，而非仅打开设置页才加载
			void loadConfig()
			// 注册设置页文案（zh/en）
			ctx.effect(() => ctx.locale.register('dsh-file-attachment', {
				zh: {
					'settings.title': '文件附件',
					'settings.hint': '用于设置聊天中可发送的文件类型。图片恒可发送；以下三类按扩展名校验文档/代码/配置文件（扩展名不带点、小写，如 pdf、py）。',
					'doc.title': '文档',
					'code.title': '代码',
					'config.title': '配置文件',
					'save': '保存',
					'saving': '保存中…',
					'saved': '已保存',
				},
				en: {
					'settings.title': 'File Attachments',
					'settings.hint': 'Set which file types can be sent in chat. Images are always allowed; the lists below gate documents / code / config files by extension (no dot, lowercase, e.g. pdf, py).',
					'doc.title': 'Documents',
					'code.title': 'Code',
					'config.title': 'Config Files',
					'save': 'Save',
					'saving': 'Saving…',
					'saved': 'Saved',
				},
			}), 'dsh-file-attachment: dictionaries')
			const slots = ctx.get('slots')
			if (slots !== undefined) {
				// input.dock：hero（首轮空白无底部栏）态也渲染；inject 在渲染前经会话作用域直取输入机 shell
				slots.inject('conversation.input.dock', () => slots.register(
					{
						name: 'conversation.input.dock',
						id: 'dsh-file-attachment',
						order: 300,
						inject: (sessionId) => {
							// 只传 sessionId（string 可靠）；shell/addImages 由 FaBridge 组件经 ctxRef 自行计算
							if (sessionId === void 0) return {}
							return { sessionId }
						}
					},
					FaBridge
				))
				// 文件条：渲染已附加文件（缩略图/类型图标 + 点击打开 + 可移除），发送后清空
				slots.inject('conversation.input.dock', () => slots.register(
					{ name: 'conversation.input.dock', id: 'dsh-file-attachment-dock', order: 400 },
					FaFileDock
				))
				slots.inject('shell.overlay', () => slots.register(
					{ name: 'shell.overlay', id: 'dsh-file-attachment-toast', order: 100 },
					FaToast
				))
				// 操作行左侧动作区（官方扩展点）：文件上传按钮，复用既有 runBatch 管线
				slots.inject('conversation.input.left', () => slots.register(
					{ name: 'conversation.input.left', id: 'dsh-file-attachment-upload', order: 10 },
					FaUploadButton
				))
				// 设置页：文件附件类型配置（左侧菜单项 + 右侧配置页）
				slots.inject('settings.section', () => [
					slots.register({
						name: 'settings.section',
						id: 'dsh-file-attachment-settings',
						order: 120,
						label: () => ctx.locale.bind('dsh-file-attachment')('settings.title'),
					}, () => react.createElement(FaSettingsPage, {})),
				])
			}
			bridge.conversation = ctx.get('conversation')
			// document 级 capture 监听：dragenter/drop/paste 都先于既有 bubble 监听器；随 Fiber 停止
			ctx.effect(() => {
				document.addEventListener('dragenter', onDragEnterCap, true)
				document.addEventListener('drop', onDrop, true)
				document.addEventListener('paste', onPaste, true)
				return () => {
					document.removeEventListener('dragenter', onDragEnterCap, true)
					document.removeEventListener('drop', onDrop, true)
					document.removeEventListener('paste', onPaste, true)
				}
			}, 'dsh-file-attachment: document dragenter/drop/paste listeners')
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	}
})