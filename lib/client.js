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
			"sessions"
		]

		// ---- 模块级状态：document 监听器 / dock 槽（同步桥）/ overlay 槽（toast）共享 ----
		let ctxRef = null // apply 时记下 ctx，供远程调用与降级判断
		const bridge = {
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

			// 纯图片（拖放或粘贴）：完全不碰事件，原样交给 dsh web 既有图片路径
			//（onPaste/onDrop → intakeImages → addImages），行为零变化。
			// 不能对「纯图片粘贴」接管：接管依赖输入桥 bridge.actions（挂在 conversation.composer.dock
			// 槽、仅非 hero 态才挂载），首次对话(hero/blank 态)桥未就绪会误报「没有可用的输入框」，
			// 且 preventDefault+stopImmediatePropagation 会吞掉原生粘贴导致图片丢失。
			if (docs.length === 0) return false

			// 含文档（可混图片）—— 完全接管：文档落盘并插 @ 引用，混入的图片按草稿图片机制登记
			e.preventDefault()
			e.stopImmediatePropagation()
			dismissDropOverlay()
			void runBatch(images, docs)
			return true
		}

		// 异步批处理：文档读全文→宿主落盘→@引用；目录拒绝；图片沿用原有流程
		async function runBatch(images, docs) {
			const actions = bridge.actions
			if (actions === null || typeof actions.setDraft !== 'function') {
				announce('输入框不可用')
				return
			}
			const phase = bridge.input !== void 0 ? bridge.input.phase : 'plain'
			if (phase !== 'plain') {
				announce('输入框正忙')
				return
			}
			const mentions = []
			const dirRejected = []
			let savedCount = 0
			let skipped = 0
			for (let i = 0; i < docs.length; i++) {
				const d = docs[i]
				if (d.isDir) {
					dirRejected.push(d.name !== '' ? d.name : '(未命名目录)')
					skipped++
					continue
				}
				try {
					const f = d.file
					if (f === null || typeof f.size !== 'number' || f.size > MAX_BYTES) throw new Error('size')
					const buf = await f.arrayBuffer()
					const b64 = bytesToBase64(new Uint8Array(buf))
					const res = await saveFileToHost(d.name, b64, bridge.sessionId)
					const m = formatMention(res.path, false)
					if (m === undefined) throw new Error('path')
					mentions.push(m)
					savedCount++
				} catch (err) {
					skipped++
				}
			}

			let inserted = 0
			if (mentions.length > 0) {
				const ta = findComposerTextarea()
				if (ta === null) announce('输入框不可用')
				else { insertTextAtCaret(ta, actions, mentions.join(' ')); inserted = mentions.length }
			}

			// 图片：与既有图片路径完全相同的调用序列登记（addImages 失败则释放）
			let imagesAdded = 0
			const conversation = bridge.conversation
			if (images.length > 0 && conversation !== void 0
				&& typeof conversation.createDraftImages === 'function'
				&& typeof actions.addImages === 'function') {
				try {
					const created = conversation.createDraftImages(images)
					const ids = created.map((a) => a.id)
					if (actions.addImages(ids)) {
						imagesAdded = ids.length
					} else if (typeof conversation.releaseDraftImages === 'function') {
						conversation.releaseDraftImages(created)
					}
				} catch (err) { /* 图片登记失败不阻断文档引用插入 */ }
			}

			if (inserted === 0 && imagesAdded === 0) {
				if (savedCount > 0 && skipped === 0) return
				if (dirRejected.length > 0 && skipped === dirRejected.length && savedCount === 0) {
					announce('不支持拖入目录')
					return
				}
				announce('文件处理失败')
				return
			}
			// 至少登记了一个引用/图片即成功：完全成功不提示，部分跳过仅简短提示
			if (skipped > 0) announce(skipped + ' 个已跳过')
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
			const actions = props.shell !== void 0 ? props.shell.actions : null
			const input = props.shell !== void 0 ? props.shell.snapshot : undefined
			const sessionId = props.sessionId !== void 0 ? props.sessionId : ''
			react.useEffect(() => {
				bridge.actions = actions
				bridge.input = input
				bridge.sessionId = sessionId
				bridge.mounted = true
				return () => {
					bridge.actions = null
					bridge.input = undefined
					bridge.sessionId = ''
					bridge.mounted = false
				}
			})
			return null
		}

		function apply(ctx) {
			ctxRef = ctx
			const slots = ctx.get('slots')
			if (slots !== undefined) {
				// input.dock：hero（首轮空白无底部栏）态也渲染；inject 在渲染前经会话作用域直取输入机 shell
				slots.inject('conversation.input.dock', () => slots.register(
					{
						name: 'conversation.input.dock',
						id: 'dsh-file-attachment',
						order: 300,
						inject: (sessionId) => {
							// 无会话（纯 hero 空白）无输入机可挂；有会话（含首轮空白态）则取 shell 作 props
							if (sessionId === void 0) return {}
							try {
								const actx = ctx.sessions.scope(sessionId)
								if (actx === void 0) return {}
								const conversation = actx.get('conversation')
								if (conversation === void 0 || conversation.input === void 0) return {}
								return { shell: conversation.input.for(actx), sessionId }
							} catch (err) {
								return {}
							}
						}
					},
					FaBridge
				))
				slots.inject('shell.overlay', () => slots.register(
					{ name: 'shell.overlay', id: 'dsh-file-attachment-toast', order: 100 },
					FaToast
				))
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