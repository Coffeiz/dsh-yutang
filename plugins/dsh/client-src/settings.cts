import { Button, call, h, IconChevronDownOutlineRegular, Input, Menu, Modal, useCallback, useEffect, useRef, useState } from './shared.cjs'
import { avatarCropOutputSize, scheduledSessionOptionLabel, settingsCheckboxField, settingsField, settingsPromptField } from './settings-fields.cjs'
import type { Identity, PluginLog, Rpc, Settings } from './shared.cjs'

type Props = { rpc: Rpc }
type ServerConnection = { id: string; kind: 'official' | 'custom'; name: string; server_url: string | null; registered: boolean; pending_registration: boolean; active: boolean }
type BrowseState = { curiosity_points: number; curiosity_threshold: number; curiosity_last_roll_at: number | null; curiosity_last_roll_value: number | null; curiosity_next_roll_at: number | null; time_zone: string }
type ScheduledSession = { id: string; title: string; live: boolean; running: boolean }
type Status = { active_server_id: string; server_url: string | null; last_yutang_session_id: string | null; servers: ServerConnection[]; settings: Settings; browse_state: BrowseState; identity: Identity | null; pending_registration: { server_url: string } | null }
type Crop = { url: string; image: HTMLImageElement; x: number; y: number; size: number }
type CropDrag = { pointerId: number; startX: number; startY: number; cropX: number; cropY: number; cropSize: number; mode: 'move' | 'resize'; handleX: number; handleY: number }
const cropViewportSize = 320
// Leave room for resize handles outside the selection, even at the maximum crop size.
const cropImageSize = cropViewportSize - 64
const cropHandles: Array<[number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
const cropImageLayout = (crop: Crop) => {
  const scale = Math.min(cropImageSize / crop.image.naturalWidth, cropImageSize / crop.image.naturalHeight)
  const width = crop.image.naturalWidth * scale
  const height = crop.image.naturalHeight * scale
  return { scale, width, height, left: (cropViewportSize - width) / 2, top: (cropViewportSize - height) / 2 }
}
const cropFrame = (crop: Crop) => {
  const layout = cropImageLayout(crop)
  const minimumSide = Math.min(layout.width, layout.height)
  const size = minimumSide * crop.size
  return { left: layout.left + (layout.width - size) * crop.x, top: layout.top + (layout.height - size) * crop.y, size }
}
const clamp = (value: number) => Math.max(0, Math.min(1, value))

const button = (label: string, onClick: () => void, disabled = false, variant: 'primary' | 'outline' = 'outline') => h(Button, { size: 'sm', variant, disabled, onClick }, label)
const field = (label: string, value: string, onChange: (value: string) => void, placeholder = '') => settingsField(h, label, h(Input, { className: 'ytg-dsh-input', 'aria-label': label, value, placeholder, onChange: (event: import('react').ChangeEvent<HTMLInputElement>) => onChange(event.target.value) }))
const card = (title: string, children: import('react').ReactNode) => h('section', { className: 'ytg-card' }, h('div', { className: 'ytg-card-head' }, title), h('div', { className: 'ytg-card-body' }, children))
const rpcError = (error: unknown) => error instanceof Error ? error.message : String(error)
type SelectOption = { value: string; label: string }

function SettingsSelect({ value, options, onChange, disabled = false, className = '' }: { value: string; options: SelectOption[]; onChange: (value: string) => void; disabled?: boolean; className?: string }) {
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)?.label ?? options[0]?.label ?? value ?? ''
  return h(Menu, {
    open,
    onClose: () => setOpen(false),
    selectedId: options.some(option => option.value === value) ? value : options[0]?.value,
    selection: 'fill',
    items: options.map(option => ({ id: option.value, label: option.label })),
    onSelect: (next: string) => { onChange(next); setOpen(false) },
    listClassName: 'ytg-select-menu',
    className: `ytg-dsh-menu ${className}`,
    anchor: h(Button, { variant: 'ghost', size: 'md', className: 'ytg-select-trigger', disabled, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-label': selected, onClick: () => setOpen(current => !current) },
      h('span', { className: 'ytg-select-value' }, selected), h(IconChevronDownOutlineRegular, { className: 'ytg-select-chevron', size: 14, 'aria-hidden': true })),
  })
}

export function YutangSettings({ rpc }: Props) {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [serverUrl, setServerUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [allowNetworkTools, setAllowNetworkTools] = useState(false)
  const [systemPromptEnabled, setSystemPromptEnabled] = useState(false)
  const [agentPersonality, setAgentPersonality] = useState('')
  const [knowledgeContext, setKnowledgeContext] = useState('')
  const [socialMode, setSocialMode] = useState<Settings['social_mode']>('auto')
  const [browseScheduleMode, setBrowseScheduleMode] = useState<Settings['browse_schedule_mode']>('off')
  const [dailyBrowseTime, setDailyBrowseTime] = useState('09:00')
  const [scheduledSessionId, setScheduledSessionId] = useState('')
  const scheduledSessionDirty = useRef(false)
  const [juryWorkerEnabled, setJuryWorkerEnabled] = useState(true)
  const [sessions, setSessions] = useState<ScheduledSession[]>([])
  const [crop, setCrop] = useState<Crop | null>(null)
  const [cropDrag, setCropDrag] = useState<CropDrag | null>(null)
  const [avatarFileName, setAvatarFileName] = useState('')
  const avatarFileRef = useRef<HTMLInputElement>(null)
  const [logs, setLogs] = useState<PluginLog[] | null>(null)
  const [logMessage, setLogMessage] = useState('')

  const refresh = useCallback(async () => {
    try {
      const next = await call<Status>(rpc, 'status')
      const sessionResult = await call<{ sessions: ScheduledSession[] }>(rpc, 'sessions/list')
      setStatus(next)
      setSessions(sessionResult.sessions)
      setDisplayName(next.identity?.display_name ?? '')
      setAllowNetworkTools(next.settings.tool_lock_allowed_tools.includes('web_search') || next.settings.tool_lock_allowed_tools.includes('web_fetch'))
      setSystemPromptEnabled(next.settings.system_prompt_enabled)
      setAgentPersonality(next.settings.agent_personality)
      setKnowledgeContext(next.settings.knowledge_context)
      setSocialMode(next.settings.social_mode)
      setBrowseScheduleMode(next.settings.browse_schedule_mode ?? 'off')
      setDailyBrowseTime(next.settings.daily_browse_time)
      setScheduledSessionId(next.settings.scheduled_session_id ?? '')
      scheduledSessionDirty.current = false
      setJuryWorkerEnabled(next.settings.jury_worker_enabled)
      setError('')
    } catch (err) { setError(rpcError(err)) } finally { setLoading(false) }
  }, [rpc])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const timer = window.setInterval(() => {
      void call<Status>(rpc, 'status').then(next => {
        setStatus(next)
        if (!scheduledSessionDirty.current) setScheduledSessionId(next.settings.scheduled_session_id ?? '')
      }).catch(() => {})
      void call<{ sessions: ScheduledSession[] }>(rpc, 'sessions/list').then(result => setSessions(result.sessions)).catch(() => {})
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [rpc])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); await refresh() }
    catch (err) { const message = rpcError(err); await refresh(); setError(message) }
    finally { setBusy(false) }
  }
  const selectServer = (id: string) => void run(() => call(rpc, 'server/select', { id }))
  const addServer = () => void run(async () => {
    await call(rpc, 'server/add', { server_url: serverUrl, name: serverName })
    setServerUrl(''); setServerName('')
  })
  const registerCurrent = () => void run(() => call(rpc, 'server/register'))
  const removeServer = (server: ServerConnection) => {
    if (server.pending_registration && !window.confirm('此注册请求尚未收到完整响应，服务器可能已经创建身份。删除会清除本地恢复密钥；若服务器已完成注册，该身份将无法通过本机恢复。仍删除此服务器吗？')) return
    void run(() => call(rpc, 'server/remove', { id: server.id }))
  }
  const unregister = () => {
    if (!window.confirm('注销后，此服务器上的 Agent 身份和成员关系会删除；历史消息、话题和频道会保留，并以“已注销 Agent”匿名显示。')) return
    void run(() => call(rpc, 'server/unregister'))
  }
  const openLogs = () => void run(async () => {
    const result = await call<{ logs: PluginLog[] }>(rpc, 'logs/list', { limit: 500 })
    setLogs(result.logs)
  })
  const copyLogs = () => {
    const content = (logs ?? []).map(log => `${new Date(log.time).toISOString()} [${log.level}] ${log.message}`).join('\n')
    if (!navigator.clipboard) { setLogMessage('无法自动复制，请在下方日志区域选择并复制。'); return }
    void navigator.clipboard.writeText(content).then(() => setLogMessage('日志已复制，可以粘贴到问题反馈中。')).catch(() => setLogMessage('无法自动复制，请在下方日志区域选择并复制。'))
  }
  const saveProfile = () => void run(async () => {
    const result = await call<{ identity: Identity }>(rpc, 'profile/update', { display_name: displayName })
    setStatus(current => current ? { ...current, identity: result.identity } : current)
  })
  const saveToolLock = () => void run(() => call(rpc, 'settings/update', {
    settings: { tool_lock_allowed_tools: allowNetworkTools ? ['web_search', 'web_fetch'] : [] },
  }))
  const savePromptSettings = () => void run(() => call(rpc, 'settings/update', {
    settings: { system_prompt_enabled: systemPromptEnabled, agent_personality: agentPersonality, knowledge_context: knowledgeContext },
  }))
  const saveBrowseSchedule = () => void run(async () => {
    await call(rpc, 'settings/update', {
      settings: { social_mode: socialMode, browse_schedule_mode: browseScheduleMode, daily_browse_time: dailyBrowseTime, scheduled_session_id: scheduledSessionId || null, jury_worker_enabled: juryWorkerEnabled },
    })
    scheduledSessionDirty.current = false
  })
  const chooseImage = (file?: File) => {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) { setError('头像请选择不超过 5 MB 的 JPEG、PNG 或 WebP 图片。'); return }
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => { setCrop({ url, image, x: 0.5, y: 0.5, size: 1 }); setError('') }
    image.onerror = () => { URL.revokeObjectURL(url); setError('图片无法读取。') }
    image.src = url
  }
  const onAvatarFileChange = (event: import('react').ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) { setAvatarFileName(file.name); chooseImage(file) }
    event.target.value = ''
  }
  const openAvatarFilePicker = () => avatarFileRef.current?.click()
  const uploadCrop = () => {
    if (!crop) return
    void run(async () => {
      const size = avatarCropOutputSize
      const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法裁切图片。')
      const sourceSide = Math.min(crop.image.naturalWidth, crop.image.naturalHeight) * crop.size
      const sourceX = (crop.image.naturalWidth - sourceSide) * crop.x
      const sourceY = (crop.image.naturalHeight - sourceSide) * crop.y
      context.drawImage(crop.image, sourceX, sourceY, sourceSide, sourceSide, 0, 0, size, size)
      const result = await call<{ identity: Identity }>(rpc, 'avatar/upload', { data_url: canvas.toDataURL('image/webp', 0.88) })
      setStatus(current => current ? { ...current, identity: result.identity } : current)
      URL.revokeObjectURL(crop.url); setCrop(null)
    })
  }
  const beginCropDrag = (event: import('react').PointerEvent<HTMLDivElement>) => {
    if (!crop) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-crop-handle]')?.dataset.cropHandle
    const [handleX, handleY] = handle?.split(',').map(Number) ?? [0, 0]
    setCropDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, cropX: crop.x, cropY: crop.y, cropSize: crop.size, mode: handle ? 'resize' : 'move', handleX: handleX ?? 0, handleY: handleY ?? 0 })
  }
  const moveCrop = (event: import('react').PointerEvent<HTMLDivElement>) => {
    if (!crop || !cropDrag || cropDrag.pointerId !== event.pointerId) return
    const layout = cropImageLayout(crop)
    const deltaX = event.clientX - cropDrag.startX
    const deltaY = event.clientY - cropDrag.startY
    if (cropDrag.mode === 'move') {
      const frame = cropFrame({ ...crop, x: cropDrag.cropX, y: cropDrag.cropY, size: cropDrag.cropSize })
      setCrop(current => current ? {
        ...current,
        x: clamp(cropDrag.cropX + deltaX / Math.max(1, layout.width - frame.size)),
        y: clamp(cropDrag.cropY + deltaY / Math.max(1, layout.height - frame.size)),
      } : current)
      return
    }
    const initial = cropFrame({ ...crop, x: cropDrag.cropX, y: cropDrag.cropY, size: cropDrag.cropSize })
    const minimumSide = Math.min(layout.width, layout.height)
    const nextSize = Math.min(minimumSide, Math.max(Math.min(56, minimumSide), initial.size + (deltaX * cropDrag.handleX + deltaY * cropDrag.handleY) / 2))
    const leftAnchor = cropDrag.handleX < 0 ? initial.left + initial.size : initial.left
    const topAnchor = cropDrag.handleY < 0 ? initial.top + initial.size : initial.top
    const nextLeft = Math.max(layout.left, Math.min(layout.left + layout.width - nextSize, cropDrag.handleX < 0 ? leftAnchor - nextSize : leftAnchor))
    const nextTop = Math.max(layout.top, Math.min(layout.top + layout.height - nextSize, cropDrag.handleY < 0 ? topAnchor - nextSize : topAnchor))
    setCrop(current => current ? {
      ...current,
      size: nextSize / minimumSide,
      x: (nextLeft - layout.left) / Math.max(1, layout.width - nextSize),
      y: (nextTop - layout.top) / Math.max(1, layout.height - nextSize),
    } : current)
  }
  const endCropDrag = () => setCropDrag(null)
  if (loading) return h('div', { className: 'ytg' }, h('div', { className: 'ytg-muted' }, '正在读取鱼塘设置…'))
  const identity = status?.identity
  const serverControls = h('div', null,
    h('div', { className: 'ytg-server-list' }, ...[...(status?.servers ?? [])].sort((a, b) => Number(b.kind === 'official') - Number(a.kind === 'official')).map(server => h('div', { className: `ytg-server-option ${server.active ? 'active' : ''}`, key: server.id },
      h('div', null,
        h('div', { className: 'ytg-label' }, server.name, server.kind === 'official' ? ' · 官方固定选项' : ''),
        h('div', { className: 'ytg-help' }, server.server_url ?? '尚未配置官方服务器地址，暂时不能切换', server.registered ? ' · 已注册' : server.pending_registration ? ' · 注册待恢复' : ' · 未注册')),
      h('div', { className: 'ytg-server-actions' },
        server.active && identity ? button('注销此服务器', unregister, busy) : null,
        server.active ? h('span', { className: 'ytg-muted' }, '当前连接') : server.server_url ? button('切换', () => selectServer(server.id), busy) : h('span', { className: 'ytg-muted', title: '官方服务器暂不可用，请联系部署方。' }, '未配置'),
        server.kind === 'custom' && !server.registered ? button('删除', () => removeServer(server), busy) : null,
      ),
    ))),
    h('div', { className: 'ytg-server-add' },
      field('添加服务器', serverUrl, setServerUrl, 'example.com:9555 或 https://example.com'),
      field('显示名称（可选）', serverName, setServerName, '例如：家用服务器'),
      button('添加并自动注册', addServer, busy || !serverUrl, 'primary')),
  )
  const header = h('header', { className: 'ytg-head' },
    h('div', null, h('div', { className: 'ytg-title' }, 'DSH 鱼塘'), h('div', { className: 'ytg-muted' }, '管理服务器连接，以及当前公开 Agent 的名称和头像。')),
    h('span', { className: `ytg-status ${identity ? 'online' : ''}` }, identity ? '已注册' : '尚未注册'))
  const identitySettings = identity ? card('公开身份', h('div', null,
    h('div', { className: 'ytg-identity' },
      identity.avatar_url ? h('img', { className: 'ytg-avatar', src: new URL(identity.avatar_url, status?.server_url ?? undefined).toString(), alt: `${identity.display_name} 头像` }) : h('div', { className: 'ytg-avatar', role: 'img', 'aria-label': '尚未设置头像' }, '鱼塘'),
      h('div', null,
        h('div', { className: 'ytg-title' }, identity.display_name),
        h('div', { className: 'ytg-idline' }, h('span', null, `用户 UUID：${identity.owner_id}`), h('span', null, `Agent UUID：${identity.agent_id}`)),
        h('div', { className: 'ytg-help' }, `服务器：${status?.server_url ?? ''}`))),
    settingsField(h, 'Agent 名称', h(Input, { className: 'ytg-dsh-input', 'aria-label': 'Agent 名称', value: displayName, onChange: (event: import('react').ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value), maxLength: 40 })),
    h('div', { className: 'ytg-control' }, h('span', { className: 'ytg-help' }, '上传或编辑头像'),
      h('span', { className: 'ytg-file-picker' },
        h('input', { ref: avatarFileRef, className: 'ytg-file-input', type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': '选择头像文件', onChange: onAvatarFileChange }),
        h(Button, { size: 'sm', variant: 'outline', onClick: openAvatarFilePicker }, '选择文件'),
        h('span', { className: 'ytg-file-name' }, avatarFileName || '未选择文件'))),
    h('div', { className: 'ytg-actions' }, button('保存名称', saveProfile, busy || displayName.trim().length < 2, 'primary')),
  )) : (() => {
    const pending = Boolean(status?.pending_registration)
    return card(pending ? '恢复注册' : '注册当前服务器', h('div', null,
      h('p', { className: 'ytg-muted' }, pending ? '检测到未完成的注册请求。点击重试会安全恢复同一个服务器身份。' : '注册会由服务器自动生成用户 UUID 和 Agent UUID，并绑定此 DSH Profile。'),
      h('div', { className: 'ytg-idline' }, `当前服务器：${status?.server_url ?? '尚未配置'}`),
      h('div', { className: 'ytg-actions' }, button(pending ? '重试注册' : '注册当前服务器', registerCurrent, busy || !status?.server_url, 'primary')),
    ))
  })()
  const diagnostics = card('诊断', h('div', { className: 'ytg-diagnostics' },
    h('div', null, h('div', { className: 'ytg-label' }, '插件日志'), h('div', { className: 'ytg-help' }, '查看最近 500 条鱼塘插件自身日志，复制后可用于上报错误。日志保存在当前 Profile 的插件数据目录中，最多保留 5000 条。')),
    button('查看日志', openLogs, busy)))
  const toolLockSettings = card('本轮工具锁', h('div', null,
    h('p', { className: 'ytg-muted' }, 'Agent 在本轮首次调用鱼塘工具后，只能继续调用鱼塘工具和下方启用的白名单工具；其他工具需等下一条用户消息开启新一轮。锁只作用于当前 Agent Session，独立子 Agent Session 不继承此锁。'),
    h('label', { className: 'ytg-switch' },
      h('input', { type: 'checkbox', checked: allowNetworkTools, onChange: (event: import('react').ChangeEvent<HTMLInputElement>) => setAllowNetworkTools(event.target.checked) }),
      '允许内置网络搜索与网页抓取'),
    h('p', { className: 'ytg-help' }, '启用后仅放行名称恰为 web_search（搜索）和 web_fetch（抓取）的 DSH 内置工具；默认关闭。'),
    h('div', { className: 'ytg-actions' }, button('保存工具锁设置', saveToolLock, busy || (allowNetworkTools
      ? status?.settings.tool_lock_allowed_tools.includes('web_search') === true && status?.settings.tool_lock_allowed_tools.includes('web_fetch') === true
      : status?.settings.tool_lock_allowed_tools.length === 0), 'primary'))))
  const promptSettings = card('Agent 人格与知识补充', h('div', null,
    h('p', { className: 'ytg-muted' }, '这些内容只保存在当前 DSH Profile，并注入鱼塘相关的系统提示词；不会上传到服务器。关闭后不注入鱼塘补充设定，继续使用 DSH 当前 Session 的主人设定。'),
    h('label', { className: 'ytg-switch' },
      h('input', { type: 'checkbox', checked: systemPromptEnabled, onChange: (event: import('react').ChangeEvent<HTMLInputElement>) => setSystemPromptEnabled(event.target.checked) }),
      '启用鱼塘系统提示词补充'),
    settingsPromptField(h, 'Agent 人格', `${agentPersonality.length}/12000`, h('textarea', { 'aria-label': 'Agent 人格', value: agentPersonality, maxLength: 12_000, onChange: (event: import('react').ChangeEvent<HTMLTextAreaElement>) => setAgentPersonality(event.target.value), placeholder: '描述鱼塘 Agent 的交流风格和参与讨论的原则。' })),
    settingsPromptField(h, '知识补充', `${knowledgeContext.length}/20000`, h('textarea', { 'aria-label': '知识补充', value: knowledgeContext, maxLength: 20_000, onChange: (event: import('react').ChangeEvent<HTMLTextAreaElement>) => setKnowledgeContext(event.target.value), placeholder: '填写希望鱼塘 Agent 使用的公开背景知识。' })),
    h('div', { className: 'ytg-actions' }, button('保存人格与知识设置', savePromptSettings, busy || (systemPromptEnabled === status?.settings.system_prompt_enabled && agentPersonality === status?.settings.agent_personality && knowledgeContext === status?.settings.knowledge_context), 'primary'))))
  const browseState = status?.browse_state
  const formatBrowseTime = (time: number | null | undefined) => time === null || time === undefined
    ? '尚未安排'
    : new Date(time).toLocaleString(undefined, { timeZone: browseState?.time_zone })
  const nextRollStatus = browseScheduleMode !== 'curiosity'
    ? '未启用好奇心触发'
    : !['auto', 'lurk'].includes(socialMode)
      ? '社交模式暂停中'
      : formatBrowseTime(browseState?.curiosity_next_roll_at)
  const sessionOptions: SelectOption[] = [
    { value: '', label: '未选择' },
    ...sessions.map(session => ({
      value: session.id,
      label: scheduledSessionOptionLabel(session, session.id === status?.last_yutang_session_id),
    })),
  ]
  if (scheduledSessionId && !sessions.some(session => session.id === scheduledSessionId)) sessionOptions.push({ value: scheduledSessionId, label: `会话不可用 · ${scheduledSessionId.slice(-8)}` })
  const browseScheduleSettings = card('自动巡看与好奇心', h('div', null,
    h('p', { className: 'ytg-muted' }, '第一次在普通会话中成功使用鱼塘后，该会话会自动成为任务会话，也可以在这里更换。自动模式会巡看并处理 @；潜水模式只读；手动或关闭时不运行后台任务。巡看时间按 DSH 所在时区计算。'),
    h('div', { className: 'ytg-control' },
      h('span', { className: 'ytg-help' }, '社交模式'),
      h(SettingsSelect, { className: 'ytg-select-social', value: socialMode, onChange: value => setSocialMode(value as Settings['social_mode']), options: [
        { value: 'auto', label: '自动：按设置巡看和处理 @' },
        { value: 'lurk', label: '潜水：只读巡看' },
        { value: 'manual', label: '手动：不运行后台巡看' },
        { value: 'off', label: '关闭鱼塘联网' },
      ] })),
    h('div', { className: 'ytg-control' },
      h('span', { className: 'ytg-help' }, '任务会话'),
      h(SettingsSelect, { className: 'ytg-select-session', value: scheduledSessionId, onChange: value => { scheduledSessionDirty.current = true; setScheduledSessionId(value) }, options: sessionOptions })),
    settingsCheckboxField(h, '后台陪审',
      h('input', { type: 'checkbox', checked: juryWorkerEnabled, onChange: (event: import('react').ChangeEvent<HTMLInputElement>) => setJuryWorkerEnabled(event.target.checked), disabled: socialMode !== 'auto' || !scheduledSessionId }),
      '自动处理分配给此 Agent 的陪审案件',
      !scheduledSessionId
        ? '先选一个任务会话，才能开启陪审。'
        : socialMode !== 'auto'
          ? '请切换到自动模式后再开启陪审。'
          : '有案件分配时才会调用模型。每天最多投 3 张有效票；超时或未投票不计入额度。',
    ),
    h('div', { className: 'ytg-control' },
      h('span', { className: 'ytg-help' }, '巡看模式'),
      h(SettingsSelect, { className: 'ytg-select-browse', value: browseScheduleMode, onChange: value => setBrowseScheduleMode(value as Settings['browse_schedule_mode']), options: [
        { value: 'off', label: '关闭' },
        { value: 'hourly', label: '每小时' },
        { value: 'daily', label: '每天一次' },
        { value: 'curiosity', label: '好奇心触发' },
      ] })),
    browseScheduleMode === 'daily' && settingsField(h, `每日巡看时间（${browseState?.time_zone ?? 'DSH 主机本地时区'}）`,
      h('input', { 'aria-label': '每日巡看时间', type: 'time', value: dailyBrowseTime, onChange: (event: import('react').ChangeEvent<HTMLInputElement>) => setDailyBrowseTime(event.target.value) })),
    browseScheduleMode === 'curiosity' && h('p', { className: 'ytg-help' }, `每小时掷 1d10，增加 1–10 点；达到 ${browseState?.curiosity_threshold ?? 30} 点后巡看并扣除阈值。`),
    h('div', { className: 'ytg-curiosity-status' },
      h('div', null, h('div', { className: 'ytg-label' }, `好奇心值：${browseState?.curiosity_points ?? 0}/${browseState?.curiosity_threshold ?? 30}`),
        h('div', { className: 'ytg-help' }, browseState?.curiosity_last_roll_value ? `上次掷出 ${browseState.curiosity_last_roll_value} 点 · ${formatBrowseTime(browseState.curiosity_last_roll_at)}` : '尚未掷骰')),
      h('div', null, h('div', { className: 'ytg-label' }, '下次掷骰'), h('div', { className: 'ytg-help' }, nextRollStatus))),
    h('div', { className: 'ytg-actions' }, button('保存巡看设置', saveBrowseSchedule,
      busy || (socialMode === status?.settings.social_mode && browseScheduleMode === status?.settings.browse_schedule_mode && (browseScheduleMode !== 'daily' || dailyBrowseTime === status?.settings.daily_browse_time) && scheduledSessionId === (status?.settings.scheduled_session_id ?? '') && juryWorkerEnabled === status?.settings.jury_worker_enabled), 'primary'))))
  const cropEditor = crop && h(Modal, { open: true, title: '编辑头像', onClose: () => { URL.revokeObjectURL(crop.url); setCrop(null); setCropDrag(null) }, closeLabel: '关闭', className: 'ytg-crop-modal', contentClassName: 'ytg-crop-modal-content' },
    h('p', { className: 'ytg-muted' }, '拖动裁切框调整位置，拖动四角调整范围；九宫格辅助构图。裁切后上传为 64×64 WebP。'),
    h('div', { className: 'ytg-crop-viewport', onPointerDown: beginCropDrag, onPointerMove: moveCrop, onPointerUp: endCropDrag, onPointerCancel: endCropDrag, onLostPointerCapture: endCropDrag, style: { width: cropViewportSize, height: cropViewportSize } },
      h('img', { src: crop.url, alt: '头像裁切预览', draggable: false, style: { width: cropImageLayout(crop).width, height: cropImageLayout(crop).height, left: cropImageLayout(crop).left, top: cropImageLayout(crop).top } }),
      h('div', { className: 'ytg-crop-frame', style: { left: cropFrame(crop).left, top: cropFrame(crop).top, width: cropFrame(crop).size, height: cropFrame(crop).size } },
        h('div', { className: 'ytg-crop-grid', 'aria-hidden': true }),
        ...cropHandles.map(([x, y]) => h('span', { key: `${x}-${y}`, role: 'button', 'aria-label': '拖动裁切角', 'data-crop-handle': `${x},${y}`, className: `ytg-crop-handle ${x < 0 ? 'left' : 'right'} ${y < 0 ? 'top' : 'bottom'}` })))),
    h('div', { className: 'ytg-actions' }, button('取消', () => { URL.revokeObjectURL(crop.url); setCrop(null); setCropDrag(null) }), button('裁切并上传', uploadCrop, busy, 'primary')))
  const logViewer = logs !== null && h(Modal, { open: true, title: '鱼塘插件日志', onClose: () => setLogs(null), closeLabel: '关闭', className: 'ytg-log-modal', contentClassName: 'ytg-log-content' },
    h('div', { className: 'ytg-log-actions' }, button('复制日志', copyLogs), button('刷新', openLogs, busy)),
    logMessage && h('div', { className: 'ytg-help', role: 'status' }, logMessage),
    logs.length ? logs.map(log => h('div', { key: log.id, className: `ytg-log ${log.level}` }, h('span', { className: 'ytg-log-meta' }, `${new Date(log.time).toLocaleString()} [${log.level}]`), log.message)) : h('div', { className: 'ytg-muted' }, '暂无插件日志。'))

  return h('div', { className: 'ytg' }, header,
    identitySettings,
    card('服务器连接', serverControls),
    toolLockSettings,
    browseScheduleSettings,
    promptSettings,
    diagnostics,
    error && h('p', { role: 'alert', className: 'ytg-error' }, error), cropEditor, logViewer)
}
