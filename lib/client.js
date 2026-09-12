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

		// Client 服务依赖：槽位 / 输入机 / 会话。
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
			shell: null,          // 输入机 shell（insertText/snapshot），来自当前会话
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
		const MAX_DIM = 640 // 图片缩放：宽或高任一边 >640 时等比缩小（GIF 例外，原样保动画）
		// 可上传类型（三类：文档/代码/配置文件）；图片恒允许（image/*）。
		// 首启为默认值，apply/设置页 fetch 持久化配置（~/.dsh/file-attachment.json）后覆盖。
		const DEFAULT_TYPES = {
			doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'],
			code: ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'sh', 'bash', 'ps1', 'sql', 'r', 'lua', 'pl', 'log'],
			config: ['json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'xml', 'html', 'css'],
		}
		const allowedTypes = { doc: DEFAULT_TYPES.doc.slice(), code: DEFAULT_TYPES.code.slice(), config: DEFAULT_TYPES.config.slice() }
		// 多模态 VLM 识别参数（仅当前模型非多模态时调用）：baseURL/apiKey/model/thinkingType
		let vlmCfg = { baseURL: 'https://api.xiaomimimo.com/v1', apiKey: '', model: 'mimo-v2.5', thinkingType: 'disabled' }
		let allowedExts = null // Set<ext>，rebuildAllowed 填充；上传校验用
		let acceptString = 'image/*' // 文件选择器 <input accept>，buildAccept 生成；劫持📎打开前赋值
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
			// 默认所有文件类型可见（浏览器文件选择器不按扩展名过滤）；
			// 扩展名白名单校验在 runBatch 阶段执行（不在允许列表则 announce 拒绝）。
			return '*/*'
		}
		// ---- 劫持 dsh 原生📎按钮（hero / composer 两模式同一 InputBar，按钮都在加号右侧、modes 左侧）----
		// 插件不再渲染自己的上传按钮；而是 capture 阶段拦截原生📎 click，改走本插件文件选择器，
		// ---- 接管 dsh 原生📎：上传入口位于与 dsh 本体完全一致的位置（hero/composer 两模式同一按钮）----
		// 方案：不劫持📎 click（原生 onClick 会打开 dsh 自己的 fileInput，files 可靠），
		// 改为劫持 dsh 原生 fileInput 的 change 事件（元素级监听先于 React 冒泡，stopImmediatePropagation 阻断 onPickFiles），
		// 读 files 后改走本插件 runBatch 管线。修复：自建隐藏 input 的 files 在某些浏览器返回空（count:0）导致上传失效。
		const hijackedInputs = new WeakSet() // 已挂拦截的原生 fileInput
		let uploadBusy = false // 文件选择中防重入
		const nativeFileInputSelector = '[data-composer-card] input[type="file"], [data-composer-card] input[type=file]'
		function onNativeFileChange(e) {
			const el = e.currentTarget
			if (el === null || el === void 0) return
			const list = el.files
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] native fileInput change', { count: list === null ? 0 : list.length })
			if (list === null || list.length === 0) return
			e.preventDefault()
			e.stopImmediatePropagation()
			// FileList 是活对象：el.value='' 会把它清空（length 变 0），必须先快照成数组
			const files = Array.prototype.slice.call(list)
			try { el.value = '' } catch (err) { /* 忽略 */ }
			const images = []
			const docs = []
			for (let i = 0; i < files.length; i++) {
				const f = files[i]
				if (f.type && f.type.indexOf('image/') === 0) { images.push(f); continue }
				docs.push({ path: null, name: f.name, isDir: false, file: f })
			}
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] native change classified', { images: images.length, docs: docs.length })
			if (images.length === 0 && docs.length === 0) return
			uploadBusy = true
			try {
				runBatch(images, docs).catch((err) => {
					console.error('[dsh-file-attachment] runBatch rejected:', err)
					announce('文件处理失败: ' + (err !== null && err !== void 0 && err.message ? err.message : String(err)))
				})
			} finally { uploadBusy = false }
		}
		function hijackFileInput(el) {
			if (hijackedInputs.has(el)) return
			hijackedInputs.add(el)
			el.addEventListener('change', onNativeFileChange)
		}
		function installNativeAttachHijack() {
			if (typeof document === 'undefined' || document.body === null || document.body === undefined) return
			let body
			try { body = document.body } catch (err) { return }
			if (!(body instanceof Node)) return
			const scan = () => {
				let all = []
				try { all = Array.from(body.querySelectorAll(nativeFileInputSelector)) } catch (err) { all = [] }
				for (let i = 0; i < all.length; i++) hijackFileInput(all[i])
			}
			scan()
			const mo = new MutationObserver(() => scan())
			try { mo.observe(body, { childList: true, subtree: true }) } catch (err) { /* 忽略 */ }
			// 兜底定时重扫：MutationObserver 偶发漏报（如同一帧内大段替换）时保底
			const timer = setInterval(scan, 1500)
			return { mo, timer }
		}
		// 客户端侧多模态参数规范化（空值回退默认，与 host normalizeMimo 一致）
		function normalizeVlmClient(raw) {
			const d = { baseURL: 'https://api.xiaomimimo.com/v1', apiKey: '', model: 'mimo-v2.5', thinkingType: 'disabled' }
			if (raw === null || typeof raw !== 'object') return d
			const pick = (k) => (typeof raw[k] === 'string' && raw[k] !== '') ? raw[k] : d[k]
			return { baseURL: pick('baseURL'), apiKey: pick('apiKey'), model: pick('model'), thinkingType: raw.thinkingType === 'enabled' ? 'enabled' : 'disabled' }
		}
		// 应用配置：更新 allowedTypes → 重建校验 Set + accept（劫持📎在打开选择器时读取 acceptString）
		function applyConfig(cfg) {
			// 空数组/未配置 → 回退默认类型（否则 config 空数组会清空 allowedTypes，文档全被拒）
			allowedTypes.doc = pickTypes(cfg && cfg.doc, DEFAULT_TYPES.doc)
			allowedTypes.code = pickTypes(cfg && cfg.code, DEFAULT_TYPES.code)
			allowedTypes.config = pickTypes(cfg && cfg.config, DEFAULT_TYPES.config)
			vlmCfg = normalizeVlmClient(cfg && (cfg.vlm || cfg.mimo))
			rebuildAllowed()
			acceptString = buildAccept()
		}
		// 配置优先：list 规范化后非空则采用，否则回退默认（allow all 由设置页传 '*' 表达）
		function pickTypes(list, fallback) {
			const n = normalizeList(list)
			return n.length > 0 ? n : fallback.slice()
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

		// ---- 已附加文件（待发送）：runBatch 插入 @路径 成功后登记，FaAttachments（输入框内附件条）渲染，发送后清空 ----
		let faSeq = 0
		const attached = new Map() // id -> { id, name, path, isImage, url, sessionId }
		const attachedListeners = new Set() // 变化订阅（FaAttachments 重渲染）
		function emitAttached() { for (const fn of attachedListeners) { try { fn() } catch (err) { /* 忽略 */ } } }
		function attachFile(entry) { attached.set(entry.id, entry); emitAttached() }
		function detachFile(id) { if (attached.delete(id)) emitAttached() }
		function clearAttachedFor(sid) {
			let changed = false
			for (const [id, e] of attached) if (e.sessionId === sid) { attached.delete(id); changed = true }
			if (changed) emitAttached()
		}

		// 附件条移除时清除草稿中指向给定路径的引用。
		// chip 模式下 snap.draft（clipboardText 投影）包含 chip 的 @完整路径；
		// setDraft 会清空所有 Lexical 节点（含 chip）重建为纯文本——调用后 chip 变为
		// @路径 纯文本（TextRefNode 颜色装饰，可发送）。子串须位于行首或前面是空白，
		// 防误伤用户文本；同一文件拖多次会留多份，循环至无目标。
		function removeDraftRefs(path) {
			const shell = bridge.shell
			if (shell === null || typeof path !== 'string' || path === '') return
			if (typeof shell.setDraft !== 'function') return
			const plain = '@' + path
			const quoted = '@"' + path + '"'
			for (let n = 0; n < 64; n++) {
				const snap = readShellSnapshot(shell)
				if (snap === null || snap === void 0 || typeof snap.draft !== 'string') break
				// 发送进行中不动草稿（此时 @引用 会随发送完成清空）
				if (snap.phase === 'adjudicating' || snap.phase === 'submitting') break
				const draft = snap.draft
				let idx = -1
				for (let i = 0; i <= draft.length; i++) {
					const p = draft.indexOf(plain, i)
					if (p === -1) break
					if (p === 0 || /\s/.test(draft[p - 1])) { idx = p; break }
				}
				if (idx === -1) {
					for (let i = 0; i <= draft.length; i++) {
						const p = draft.indexOf(quoted, i)
						if (p === -1) break
						if (p === 0 || /\s/.test(draft[p - 1])) { idx = p; break }
					}
				}
				if (idx === -1) break
				let end = idx + plain.length
				if (draft.charCodeAt(end) === 32) end += 1 // 吃掉插入时补的尾随空格 gap
				shell.setDraft(draft.slice(0, idx) + draft.slice(end))
			}
		}

		// ---- 宿主保存调用：fetch POST 宿主 webServer 路由----
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

		// ---- 图片处理：扩展名 / GIF 判定 / 加载 / 缩放（宽或高任一边 >MAX_DIM 时处理，GIF 原样保动画，PNG 保透明） ----
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
		// 缩放：宽或高任一边 > maxDim 时等比缩小（两边都不超过 maxDim 时原样）；返回 { data, name }（data 为 Blob/File）。
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

		// 输入机快照读取：兼容两代 dsh。
		// 旧版（纯文本机，alpha.2 之前）：shell.snapshot 直接是 InputState；
		// 新版（Lexical composer，alpha.2 起）：shell.state 是 SnapshotStore，经
		// getSnapshot() 取值（字段不变：draft/draftRev/phase/occurrences）。
		function readShellSnapshot(shell) {
			if (shell === null || shell === void 0) return undefined
			const st = shell.state
			if (st !== null && st !== void 0 && typeof st.getSnapshot === 'function') {
				return st.getSnapshot()
			}
			return shell.snapshot
		}

		// 找可写的 composer 输入表面：可见、未禁用、未只读、phase 为 plain；
		// 多个候选时优先文本与桥内草稿一致的那一个（排除审批弹窗里的同名元素）。
		// 双代兼容：旧版 textarea（[data-composer-card] textarea）；
		// 新版 Lexical contenteditable（[data-composer-card] [data-composer-input]）。
		function findComposerInput() {
			const list = Array.from(document.querySelectorAll('[data-composer-card] textarea, [data-composer-card] [data-composer-input]'))
			const live = list.filter((ta) => {
				if (ta.disabled || ta.readOnly) return false
				const phase = ta.getAttribute('data-phase')
				if (phase !== null && phase !== 'plain') return false
				return ta.getClientRects().length > 0
			})
			if (live.length === 0) return null
			const draft = bridge.input !== void 0 ? bridge.input.draft : undefined
			const textOf = (el) => (el.tagName === 'TEXTAREA' ? el.value : (el.textContent || ''))
			if (typeof draft === 'string') {
				for (let i = 0; i < live.length; i++) {
					if (textOf(live[i]) === draft) return live[i]
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

		// File → dataURL（base64 data: 前缀），供 host /describe 的 VLM 识别
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
				// File.type 在剪贴板截图场景下可能为空（浏览器未填充 MIME）；
				// 回退到 DataTransferItem.type 判定，并创建带正确 MIME 的 File 副本，
				// 确保 createDrafts 的 imageMediaType 校验通过。
				const effType = file.type || ((items && items[i]) ? items[i].type : '') || ''
				if (effType.indexOf('image/') === 0) {
					// file.type 为空时用 items[i].type 补全，生成新 File 对象
					images.push(file.type ? file : new File([file], file.name || 'image.png', { type: effType }))
					continue
				}
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
			// 有输入桥：接管全部（图片与文档统一落盘 → @路径 纯文本，方案 B 绕开 dsh image 能力检查）
			e.preventDefault()
			e.stopImmediatePropagation()
			dismissDropOverlay()
			void runBatch(images, docs)
			return true
		}

		// 异步批处理：文档 + 图片统一落盘 → shell.insertReference chip（label=短文件名显示，clipboardText=@完整路径发送）。
		// 图片不走 dsh 草稿附件链路（方案 B：文本模型被 dsh 拒绝 image 附件），改与文档同链路：落盘 → chip 引用 → 附件条登记。
		// 目录拒绝；扩展名按配置校验（图片恒允许）。
		async function runBatch(images, docs) {
			const shell = bridge.shell
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] runBatch start', { images: images.length, docs: docs.length, shell: shell === null ? 'null' : 'ok', mounted: bridge.mounted })
			if (shell === null || typeof shell.insertReference !== 'function') {
				announce(`输入框不可用 [mounted:${bridge.mounted} shell:${shell === null ? 'null' : 'ok'} addImg:${typeof bridge.addImages}]`)
				return
			}
			const snap0 = readShellSnapshot(shell)
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
						// 图片：落盘前等比缩小（宽或高任一边 >MAX_DIM 才处理；GIF 原样保动画），
						// 再走 @路径 纯文本 + 附件条登记（方案 B：不触发 dsh 的 image 能力检查）
						const sized = await downscaleImage(it.file, MAX_DIM)
						const data = sized.data
						const name = sized.name
						if (data === null || typeof data.size !== 'number' || data.size === 0) throw new Error('size')
						if (data.size > MAX_BYTES) throw new Error('size')
						const buf = await data.arrayBuffer()
						const b64 = bytesToBase64(new Uint8Array(buf))
						if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] before saveFileToHost', { name, b64len: b64.length })
						const res = await saveFileToHost(name, b64, bridge.sessionId)
						if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] saved', res.path)
						const m = formatMention(res.path, false)
						const clipboardText = m !== undefined ? m : '@' + res.path
						// 文件条缩略图：data URL（图片已读入内存（buf），直接用 b64 组装，不重复读文件/不用 FileReader）
						const mime = data.type && data.type !== '' ? data.type : 'application/octet-stream'
						const thumbUrl = 'data:' + mime + ';base64,' + b64
						// 每次插入前重取 snapshot（draftRev 随插入递增，span 取当前末尾）
						const snap = readShellSnapshot(shell)
						// 前导分隔空格：聊天记录对 @引用 的 file-chip 渲染（projectUserText）
						// 要求 @ 前是行首或空白；纯文本 @路径 也遵循同样边界。
						// 草稿末尾紧贴文字时先补一格，否则发送后聊天记录显示裸 @路径。
						if (snap !== void 0 && typeof snap.draft === 'string' && snap.draft !== ''
							&& !isSpace(snap.draft.charCodeAt(snap.draft.length - 1))) {
							const leadSpan = { draftRev: snap.draftRev, start: snap.draft.length, end: snap.draft.length }
							if (typeof shell.insertText === 'function') {
								try { shell.insertText(' ', leadSpan) } catch (err) { /* 忽略：补空格失败不阻塞插入 */ }
							} else if (typeof shell.setDraft === 'function') {
								try { shell.setDraft(snap.draft + ' ') } catch (err) { /* 忽略 */ }
							}
						}
						// 补空格会递增 draftRev，重新取快照后再定插入 span。
						// 关键：insertText 的 span 是 detect 坐标（编辑器实际节点坐标），
						// draft.length 是投影坐标，纯文本机下两者一致；仍优先 shell.caretSpan()
						// 拿 detect 坐标（有光标返回光标处，否则返回文档末尾），与历史行为对齐。
						const snap2 = readShellSnapshot(shell)
						let span
						if (typeof shell.caretSpan === 'function') {
							try {
								const cs = shell.caretSpan()
								span = { draftRev: snap2.draftRev, start: cs.start, end: cs.end }
							} catch (err) {
								span = { draftRev: snap2.draftRev, start: snap2.draft.length, end: snap2.draft.length }
							}
						} else {
							span = { draftRev: snap2.draftRev, start: snap2.draft.length, end: snap2.draft.length }
						}
						// chip 插入：label=短文件名（显示用），clipboardText=@完整路径（发送用）
						const okInsert = shell.insertReference({ source: 'reference', ref: clipboardText, label: name, appearance: 'file', clipboardText: clipboardText }, span)
						if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] image insertReference result', { ok: okInsert, span, name, clipboardText, draftRev: snap2.draftRev })
						if (okInsert) {
							inserted += 1
							// 登记到附件条（图片：data URL 缩略图 + 点击打开；发送后随 @引用 清空）
							attachFile({ id: 'fa' + (++faSeq), name, path: res.path, isImage: true, url: thumbUrl, sessionId: bridge.sessionId })
						} else failed += 1
						continue
					}
					// 文档：原样落盘 → @路径 纯文本 + 附件条登记
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
					const snap = readShellSnapshot(shell)
					// 前导分隔空格：聊天记录对 @引用 的 file-chip 渲染（projectUserText）
					// 要求 @ 前是行首或空白；纯文本 @路径 也遵循同样边界。
					// 草稿末尾紧贴文字时先补一格，否则发送后聊天记录显示裸 @路径
					//（旧版 insertTextAtCaret 的 padStart 同款保底）。
					if (snap !== void 0 && typeof snap.draft === 'string' && snap.draft !== ''
						&& !isSpace(snap.draft.charCodeAt(snap.draft.length - 1))) {
						const leadSpan = { draftRev: snap.draftRev, start: snap.draft.length, end: snap.draft.length }
						if (typeof shell.insertText === 'function') {
							try { shell.insertText(' ', leadSpan) } catch (err) { /* 忽略：补空格失败不阻塞插入 */ }
						} else if (typeof shell.setDraft === 'function') {
							try { shell.setDraft(snap.draft + ' ') } catch (err) { /* 忽略 */ }
						}
					}
					// 补空格会递增 draftRev，重新取快照后再定插入 span。
					// 与图片分支同理：insertText 的 span 须为 detect 坐标，优先 shell.caretSpan()。
					const snap2 = readShellSnapshot(shell)
					let span
					if (typeof shell.caretSpan === 'function') {
						try {
							const cs = shell.caretSpan()
							span = { draftRev: snap2.draftRev, start: cs.start, end: cs.end }
						} catch (err) {
							span = { draftRev: snap2.draftRev, start: snap2.draft.length, end: snap2.draft.length }
						}
					} else {
						span = { draftRev: snap2.draftRev, start: snap2.draft.length, end: snap2.draft.length }
					}
					// chip 插入：label=短文件名（显示用），clipboardText=@完整路径（发送用）
					const okInsert = shell.insertReference({ source: 'reference', ref: clipboardText, label: name, appearance: 'file', clipboardText: clipboardText }, span)
					if (okInsert) {
						inserted += 1
						// 登记到附件条（图片：data URL 缩略图；文档：类型图标；发送后随 @引用 清空）
						attachFile({ id: 'fa' + (++faSeq), name, path: res.path, isImage: false, url: null, sessionId: bridge.sessionId })
					} else failed += 1
				} catch (err) {
					failed += 1
					if (typeof console !== 'undefined' && console.error) console.error('[dsh-file-attachment] item failed', { name: it && it.name, isImage: it && it.isImage, error: err instanceof Error ? (err.message + '\n' + (err.stack || '')) : String(err) })
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

		// document 级 paste（capture）：仅当粘贴目标就是 composer 输入表面时接管文件；
		// 纯文本（含目录路径字符串）完全原生，不改写。
		function onPaste(e) {
			const t = e.target
			const ta = findComposerInput()
			if (ta === null || (t !== ta && !(ta.contains && ta.contains(t)))) return
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
				if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] FaToast mounted')
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
							// 不再注册 dsh 原生附件（createDrafts + addAttachments 会导致原生附件条重复显示）
							// 插件已接管图片落盘 + chip 引用 + 自定义附件条（FaAttachments）
							addImages = (files) => { return null }
						}
					}
				}
			} catch (err) { shell = null; addImages = null }
			const input = readShellSnapshot(shell)
			react.useEffect(() => {
				bridge.shell = shell
				bridge.addImages = addImages
				bridge.input = input
				bridge.sessionId = sessionId
				bridge.mounted = true
				if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] FaBridge mounted', { sessionId, shell: shell === null ? 'null' : 'ok', addImages: typeof addImages })
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

		// 输入框内附件条（conversation.input.attachments 槽，shadow 原生 ComposerAttachments）：
		// 图片显示真缩略图预览 / 文件仅类型图标；文件名横排显示在缩略图/图标右侧（草稿 @引用 chip
		// 已改为只留图标不显示文字，避免双份名称）；可移除（先清草稿 @引用 再登记移除）；发送后自动清空。
		function FaAttachments() {
			const [, force] = react.useState(0)
			react.useEffect(() => {
				const fn = () => force(n => n + 1)
				attachedListeners.add(fn)
				return () => { attachedListeners.delete(fn) }
			}, [])
			// 发送后清空：轮询输入机快照，occurrences 从有→无 即一次发送完成
			const hadOcc = react.useRef(false)
			react.useEffect(() => {
				const timer = setInterval(() => {
					const shell = bridge.shell
					const snap = readShellSnapshot(shell)
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
					display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
					width: '100%', boxSizing: 'border-box',
				},
			},
				entries.map(e =>
					react.createElement('div', { key: e.id, style: {
						display: 'inline-flex', alignItems: 'center', gap: '8px',
						background: 'rgba(128,128,128,0.12)', border: '1px solid rgba(128,128,128,0.2)',
						borderRadius: '10px', padding: '4px 8px', fontSize: '12px', lineHeight: '1.4', maxWidth: '260px',
					} },
						e.isImage && e.url
							? react.createElement('img', { src: e.url, alt: e.name, title: e.name, style: { width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', flex: 'none', display: 'block' } })
							: react.createElement('span', { style: { display: 'inline-flex', width: '20px', height: '20px', flex: 'none', color: 'inherit' } }, fileGlyph(e.name)),
						react.createElement('span', {
							style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
						}, e.name),
						react.createElement('span', {
							onClick: () => {
								// 先清草稿中指向该文件的全部 @引用 chip，再移除附件条条目
								try { removeDraftRefs(e.path) } catch (err) { /* 忽略：引用清理失败不阻塞移除 */ }
								detachFile(e.id)
							},
							title: '移除',
							style: { cursor: 'pointer', opacity: 0.6, fontSize: '14px', lineHeight: '1', flex: 'none', padding: '0 2px' },
						}, '×'),
					)
				),
			)
		}

		// ---- 聊天区用户消息渲染器（shadow conversation.chat.node keyed 'user'）----
		// 需求：图片在聊天区也要预览（缩略图 + 点击放大）；文件自始至终不需要预览（保持 chip）。
		// 方案 B 下用户消息以 @绝对路径 文本形式落库（无原生附件块），故核心是扫描 text 块内的
		// @路径：图片路径 → /api/file?path= 缩略图（宿主既有文件服务路由，同 AssistantMarkdown
		// localPathMediaUrl 机制）；文件路径 → 复刻 dsh projectUserText 的 refChip 样式（无预览）。
		// 原生 image/file 附件块（多模态模型场景）→ 尽力渲染（renderMessageImages / 文件卡片）。
		// 本插件自包含（无法 import dsh 包），全部 react.createElement + 内联样式复刻。

		// 图片扩展名集合（与 host IMAGE_EXT 一致：png/jpg/jpeg/gif/webp/bmp）
		const IMAGE_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
		function isImagePath(p) {
			if (typeof p !== 'string' || p === '') return false
			const dot = p.lastIndexOf('.')
			if (dot <= 0) return false
			return IMAGE_EXT_SET.has(p.slice(dot + 1).toLowerCase())
		}
		// 复刻 dsh fileSizeText：字节数 → 人类可读
		function fileSizeText(bytes) {
			if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return ''
			if (bytes < 1024) return bytes + ' B'
			if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace(/\.0$/u, '') + ' KB'
			if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, '') + ' MB'
			return (bytes / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/u, '') + ' GB'
		}
		// 复刻 dsh contentParts：用户消息 content（块数组）拆 text/attachments/rest
		function contentParts(content) {
			const texts = []
			const attachments = []
			const rest = []
			if (!Array.isArray(content)) {
				return { text: (typeof content === 'string' ? content : ''), attachments, rest }
			}
			for (const block of content) {
				const b = (block !== null && typeof block === 'object') ? block : null
				if (b !== null && b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
				else if (b !== null && b.type === 'image' && b.attachment !== void 0) attachments.push({ type: 'image', image: b.attachment })
				else if (b !== null && b.type === 'file' && b.attachment !== void 0) attachments.push({ type: 'file', file: b.attachment })
				else if (b !== null) rest.push(block)
			}
			return { text: texts.join(''), attachments, rest }
		}
		// 复刻 dsh projectUserText 的 @路径 正则（含引号形式），扫描 text 中的引用 token。
		// 返回 [{ start, end, raw, path }]：raw=完整 token（含@），path=去 @ 与前导引号后的路径。
		function scanRefTokens(text) {
			const out = []
			if (typeof text !== 'string' || text === '') return out
			const re = /(^|\s)(\/[\w-]+(?=\s|$)|@"[^"\n]+"|@[^\s]+)/gu
			let m = null
			while ((m = re.exec(text)) !== null) {
				const tokenStart = m.index + (m[1] || '').length
				const raw = m[2]
				if (typeof raw !== 'string' || raw.charAt(0) !== '@') continue // /name 是 skill/command，保持文本
				let path = raw.slice(1)
				if (path.charAt(0) === '"' && path.length > 1 && path.charAt(path.length - 1) === '"') path = path.slice(1, -1)
				out.push({ start: tokenStart, end: tokenStart + raw.length, raw, path })
			}
			return out
		}
		// 复刻 dsh IconBrowseOutline16 的 SVG path（16×16 viewBox，文件浏览图标，currentColor）
		function fileBrowseGlyph(size) {
			return react.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': true, style: { display: 'block' } },
				react.createElement('path', { d: 'M11.2426 4.80473V6.10551H4.75819V4.80473H11.2426Z', fill: 'currentColor' }),
				react.createElement('path', { d: 'M9.40858 7.84478V9.14557H4.75819V7.84478H9.40858Z', fill: 'currentColor' }),
				react.createElement('path', {
					d: 'M9.23438 0.546389C10.1941 0.546389 10.9683 0.544914 11.5859 0.611819C12.2161 0.680096 12.7634 0.825745 13.2393 1.17139C13.5172 1.3733 13.7619 1.61812 13.9639 1.896C14.3096 2.37183 14.4551 2.91922 14.5234 3.54932C14.5903 4.16686 14.5889 4.94133 14.5889 5.90088V10.0981C14.5889 11.0576 14.5903 11.8321 14.5234 12.4497C14.4552 13.0798 14.3094 13.6272 13.9639 14.103C13.7619 14.381 13.5172 14.6257 13.2393 14.8276C12.7633 15.1734 12.2163 15.3189 11.5859 15.3872C10.9683 15.4541 10.1942 15.4536 9.23438 15.4536H6.76563C5.80591 15.4536 5.03168 15.4541 4.41407 15.3872C3.78385 15.3189 3.23665 15.1734 2.76074 14.8276C2.48291 14.6257 2.23802 14.3809 2.03614 14.103C1.69066 13.6272 1.54483 13.0798 1.47657 12.4497C1.40973 11.8321 1.41114 11.0576 1.41114 10.0981V5.90088C1.41113 4.94132 1.40966 4.16686 1.47657 3.54932C1.54488 2.91921 1.69042 2.37184 2.03614 1.896C2.2381 1.61807 2.4828 1.37333 2.76074 1.17139C3.23665 0.825682 3.78386 0.680109 4.41407 0.611819C5.03168 0.544905 5.80591 0.546389 6.76563 0.546389H9.23438ZM6.76563 1.896C5.77586 1.896 5.0876 1.89738 4.55957 1.95459C4.0443 2.01043 3.76214 2.11349 3.55469 2.26416C3.39135 2.38284 3.24761 2.52662 3.12891 2.68994C2.97821 2.89736 2.8752 3.17967 2.81934 3.69483C2.76214 4.22279 2.76075 4.91131 2.76074 5.90088V10.0981C2.76074 11.0876 2.76221 11.7762 2.81934 12.3042C2.87516 12.8194 2.97829 13.1026 3.12891 13.3101C3.24754 13.4733 3.39147 13.6172 3.55469 13.7358C3.76213 13.8865 4.04438 13.9896 4.55957 14.0454C5.0876 14.1026 5.77586 14.103 6.76563 14.103H9.23438C10.2242 14.103 10.9124 14.1026 11.4404 14.0454C11.9556 13.9896 12.2379 13.8865 12.4453 13.7358C12.6086 13.6172 12.7525 13.4733 12.8711 13.3101C13.0217 13.1026 13.1248 12.8195 13.1807 12.3042C13.2378 11.7762 13.2393 11.0876 13.2393 10.0981V5.90088C13.2393 4.91131 13.2379 4.22279 13.1807 3.69483C13.1248 3.17969 13.0218 2.89736 12.8711 2.68994C12.7524 2.52667 12.6086 2.38281 12.4453 2.26416C12.2379 2.11355 11.9556 2.01041 11.4404 1.95459C10.9124 1.8974 10.2241 1.896 9.23438 1.896H6.76563Z', fill: 'currentColor' }),
			)
		}
		// 聊天区 @文件路径 → refChip（复刻 dsh css.refChip：inline + 主题色 + 图标 + 末段名；无预览）
		function renderRefChip(raw, path) {
			let name = path
			const sl = path.lastIndexOf('/')
			if (sl >= 0 && sl < path.length - 1) name = path.slice(sl + 1)
			const isFolder = raw.charAt(raw.length - 1) === '/' || path.charAt(path.length - 1) === '/'
			return react.createElement('span', {
				title: raw,
				style: {
					display: 'inline', margin: '0 2px', whiteSpace: 'nowrap',
					color: 'var(--dsw-alias-state-business-primary)', fontWeight: 500,
				},
			},
				react.createElement('span', { style: { display: 'inline-block', width: '1em', height: '1em', marginRight: '4px', verticalAlign: '-0.125em', color: 'inherit' } },
					fileBrowseGlyph(16)),
				name,
			)
		}
		// 图片放大预览（Lightbox）：模块级状态，FaUserMessage 缩略图点击打开，FaLightbox 渲染
		let lightboxSrc = null
		let lightboxName = ''
		let lightboxListener = null
		function openLightbox(src, name) {
			lightboxSrc = src
			lightboxName = name || ''
			if (lightboxListener !== null) lightboxListener()
		}
		function FaLightbox() {
			const [, force] = react.useState(0)
			react.useEffect(() => {
				lightboxListener = () => force(n => n + 1)
				return () => { if (lightboxListener !== null) lightboxListener = null }
			}, [])
			const src = lightboxSrc
			if (src === null || src === '') return null
			const close = () => { openLightbox(null, '') }
			return react.createElement('div', {
				onClick: close,
				style: {
					position: 'fixed', inset: '0', zIndex: 3000,
					background: 'rgba(0,0,0,0.74)', display: 'flex', alignItems: 'center', justifyContent: 'center',
					cursor: 'zoom-out',
				},
			},
				react.createElement('img', { src, alt: lightboxName, style: { maxWidth: '90vw', maxHeight: '90vh', borderRadius: '8px', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' } }),
				react.createElement('span', {
					onClick: (e) => { e.stopPropagation(); close() },
					title: '关闭',
					style: { position: 'absolute', top: '18px', right: '24px', color: '#fff', fontSize: '30px', cursor: 'pointer', lineHeight: '1', userSelect: 'none' },
				}, '×'),
			)
		}
		// 宿主文件服务 URL：与 dsh AssistantMarkdown.localPathMediaUrl 同机制
		function imageUrlFor(path) {
			return '/api/file?path=' + encodeURIComponent(path)
		}
		// 聊天区 @图片路径 → 缩略图（<img /api/file?path=> + 点击放大 Lightbox）
		function renderImageThumb(path, raw) {
			const src = imageUrlFor(path)
			return react.createElement('img', {
				src,
				alt: '',
				title: raw,
				onClick: () => { openLightbox(src, path) },
				style: {
					maxWidth: '240px', maxHeight: '240px', width: 'auto', height: 'auto',
					objectFit: 'contain', borderRadius: '12px', display: 'inline-block',
					verticalAlign: 'middle', cursor: 'zoom-in', margin: '2px 2px',
				},
			})
		}
		// text 块 → 节点序列：普通文本 run + @路径（图片→缩略图 / 文件→chip）
		function projectTextWithImages(text) {
			const tokens = scanRefTokens(text)
			if (tokens.length === 0) return react.createElement('span', null, text)
			const parts = []
			let cursor = 0
			for (const tk of tokens) {
				if (tk.start > cursor) parts.push(react.createElement('span', { key: 't' + cursor }, text.slice(cursor, tk.start)))
				if (isImagePath(tk.path)) parts.push(react.createElement('span', { key: 'i' + tk.start }, renderImageThumb(tk.path, tk.raw)))
				else parts.push(react.createElement('span', { key: 'r' + tk.start }, renderRefChip(tk.raw, tk.path)))
				cursor = tk.end
			}
			if (cursor < text.length) parts.push(react.createElement('span', { key: 't' + cursor }, text.slice(cursor)))
			return react.createElement(react.Fragment, null, parts)
		}
		// 聊天区文件附件块 → 文件卡片（名 + 扩展名/大小 meta；无预览）
		function renderFileCard(file, key) {
			const ext = (file && typeof file.name === 'string' ? file.name.lastIndexOf('.') : -1) > 0
				? String(file.name.slice(file.name.lastIndexOf('.') + 1)).toUpperCase().slice(0, 8)
				: ''
			const meta = [ext, fileSizeText(file && file.bytes)].filter(Boolean).join(' ')
			return react.createElement('span', {
				key, title: file && file.name,
				style: {
					display: 'inline-flex', flex: '0 0 240px', alignItems: 'center', gap: '10px',
					width: '240px', minHeight: '64px', padding: '8px 12px',
					border: '0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12))',
					borderRadius: '16px', background: 'var(--dsw-specific-input-major, transparent)',
					boxSizing: 'border-box',
				},
			},
				react.createElement('span', { style: { display: 'inline-flex', width: '20px', height: '20px', flex: 'none' } },
					fileGlyph(file && file.name ? file.name : 'file')),
				react.createElement('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
					react.createElement('span', { style: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, file && file.name),
					react.createElement('span', { style: { fontSize: '11px', opacity: 0.7 } }, meta),
				),
			)
		}
		// 聊天区用户消息渲染器：气泡 + @图片缩略图预览 / @文件 chip；附件块尽力渲染
		function FaUserMessage(props) {
			const node = props && props.node
			const data = node ? node.data : null
			const content = data ? data.content : []
			const renderMessageImages = props && props.renderMessageImages
			const { text, attachments, rest } = contentParts(content)
			const showBubble = text !== '' || rest.length > 0
			const rows = []
			// 附件块（image → 原生缩略图画廊 / file → 文件卡片）
			for (let i = 0; i < attachments.length; i++) {
				const a = attachments[i]
				if (a.type === 'image') {
					// 原生 image 附件块：交 dsh 缩略图画廊渲染（ChatNodeOwnerProps.renderMessageImages，
					// 由 CHAT_NODE_INJECT 注入，宿主必有）
					if (typeof renderMessageImages === 'function') {
						rows.push(react.createElement(react.Fragment, { key: 'image:' + i }, renderMessageImages({ images: [{ attachment: a.image }], align: 'end', compact: attachments.length > 1 })))
					}
				} else {
					rows.push(renderFileCard(a.file, 'file:' + i))
				}
			}
			// 气泡（text + rest）
			if (showBubble) {
				rows.push(react.createElement('div', {
					key: 'bubble',
					style: {
						maxWidth: '100%', background: 'var(--dsw-specific-bubble)', borderRadius: '22px',
						padding: '10px 16px', fontSize: 'var(--dsh-content-font-size, 14px)',
						lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
						whiteSpace: 'pre-wrap', wordBreak: 'break-word',
					},
				},
					projectTextWithImages(text),
					rest.map((block, i) => {
						let label = ''
						try { label = JSON.stringify(block) } catch (err) { label = String(block) }
						if (label.length > 200) label = label.slice(0, 200) + '…'
						return react.createElement('div', { key: 'rest' + i, style: { fontSize: '12px', opacity: 0.75, marginTop: '4px' } }, label)
					}),
				))
			}
			if (rows.length === 0) return null
			return react.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' } },
				react.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', minWidth: 0, maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%)' } }, rows),
			)
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

		// 扩展名规范化：小写/去前导点/仅 [a-z0-9]；非法返回 null
		function normExt(v) {
			const s = String(v == null ? '' : v).trim().toLowerCase().replace(/^\.+/u, '')
			return (s !== '' && /^[a-z0-9]+$/u.test(s)) ? s : null
		}
		// 设置页：配置可上传的文档/代码/配置文件扩展名，保存写 ~/.dsh/file-attachment.json
		function FaSettingsPage() {
			const [doc, setDoc] = react.useState(DEFAULT_TYPES.doc.slice())
			const [code, setCode] = react.useState(DEFAULT_TYPES.code.slice())
			const [config, setConfig] = react.useState(DEFAULT_TYPES.config.slice())
			const [vlmBaseURL, setVlmBaseURL] = react.useState('')
			const [vlmApiKey, setVlmApiKey] = react.useState('')
			const [vlmModel, setVlmModel] = react.useState('')
			const [vlmThinking, setVlmThinking] = react.useState(false)
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
					setVlmBaseURL(vlmCfg.baseURL)
					setVlmApiKey(vlmCfg.apiKey)
					setVlmModel(vlmCfg.model)
					setVlmThinking(vlmCfg.thinkingType === 'enabled')
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
					const body = { doc: doc, code: code, config: config, vlm: { baseURL: vlmBaseURL, apiKey: vlmApiKey, model: vlmModel, thinkingType: vlmThinking ? 'enabled' : 'disabled' } }
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
				react.createElement('div', { style: { margin: '16px 0', padding: '12px', borderRadius: '8px', background: 'rgba(128,128,128,0.08)', border: '1px solid rgba(128,128,128,0.15)' } },
					react.createElement('div', { style: { marginBottom: '8px', fontSize: '13px', fontWeight: '600' } }, t('vlm.title')),
					react.createElement('div', { style: { marginBottom: '10px', fontSize: '12px', color: 'rgba(128,128,128,0.9)' } }, t('vlm.hint')),
					react.createElement('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '8px 10px', alignItems: 'center' } },
						react.createElement('span', { style: { fontSize: '12px' } }, t('vlm.baseURL')),
						react.createElement('input', { value: vlmBaseURL, onChange: (e) => setVlmBaseURL(e.target.value), placeholder: 'https://api.xiaomimimo.com/v1', style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit', fontSize: '12px' } }),
						react.createElement('span', { style: { fontSize: '12px' } }, t('vlm.apiKey')),
						react.createElement('input', { value: vlmApiKey, onChange: (e) => setVlmApiKey(e.target.value), type: 'password', placeholder: 'sk-...', style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit', fontSize: '12px' } }),
						react.createElement('span', { style: { fontSize: '12px' } }, t('vlm.model')),
						react.createElement('input', { value: vlmModel, onChange: (e) => setVlmModel(e.target.value), placeholder: 'mimo-v2.5', style: { padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit', fontSize: '12px' } }),
						react.createElement('span', { style: { fontSize: '12px' } }),
						react.createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
							react.createElement('input', { type: 'checkbox', checked: vlmThinking, onChange: (e) => setVlmThinking(e.target.checked) }),
							t('vlm.thinking'),
						),
					),
				),
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
			if (typeof console !== 'undefined' && console.log) console.log('[dsh-file-attachment] apply', { hasSlots: ctx.get('slots') !== undefined, hasConversation: ctx.get('conversation') !== undefined })
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
					'vlm.title': '多模态识别参数',
					'vlm.hint': '当前会话模型不支持多模态时，粘贴图片将调用此 VLM 生成描述回填草稿；支持多模态则模型直接看图，不调用。',
					'vlm.baseURL': 'Base URL',
					'vlm.apiKey': 'API Key',
					'vlm.model': '模型',
					'vlm.thinking': '启用思考模式（默认禁用）',
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
					'vlm.title': 'Multimodal VLM',
					'vlm.hint': 'When the session model is not multimodal, pasted images are described by this VLM and appended to the draft; multimodal models read images directly (no call).',
					'vlm.baseURL': 'Base URL',
					'vlm.apiKey': 'API Key',
					'vlm.model': 'Model',
					'vlm.thinking': 'Enable thinking mode (disabled by default)',
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
				// 输入框内附件条：shadow 原生 ComposerAttachments（priority -100 < ui-attachment 的 0，
				// lowest wins），图片缩略图预览 / 文件条目（无预览），发送后清空
				slots.inject('conversation.input.attachments', () => slots.register(
					{ name: 'conversation.input.attachments', id: 'dsh-file-attachment-attachments', priority: -100 },
					FaAttachments
				))
				// 聊天区用户消息：shadow 原生 UserMessageNodeView（keyed 'user'，priority -100 < 0，
				// lowest wins；Reusing a key replaces that node renderer），@图片路径→缩略图预览，
				// @文件路径→chip（无预览）
				slots.inject('conversation.chat.node', () => slots.register(
					{ name: 'conversation.chat.node', key: 'user', priority: -100 },
					FaUserMessage
				))
				slots.inject('shell.overlay', () => slots.register(
					{ name: 'shell.overlay', id: 'dsh-file-attachment-toast', order: 100 },
					FaToast
				))
				// 图片放大预览（Lightbox）：list 槽，与 toast 共存（order 200 渲染在 toast 之上）
				slots.inject('shell.overlay', () => slots.register(
					{ name: 'shell.overlay', id: 'dsh-file-attachment-lightbox', order: 200 },
					FaLightbox
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
			// 劫持 dsh 原生📎：让上传入口位于与 dsh 本体一致的位置（hero/composer 两模式同一按钮），
			// 点击改走本插件文件选择器；MutationObserver + 定时重扫随 ctx.effect 生命周期清理
			ctx.effect(() => {
				const h = installNativeAttachHijack()
				return () => {
					if (h !== null && h !== void 0) {
						try { h.mo.disconnect() } catch (err) { /* 忽略 */ }
						try { clearInterval(h.timer) } catch (err) { /* 忽略 */ }
					}
				}
			}, 'dsh-file-attachment: native attach hijack')
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