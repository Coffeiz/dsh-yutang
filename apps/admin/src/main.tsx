import { lazy, Suspense, useEffect, useState, type FormEvent, type PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import '../../web/src/styles/tokens.css';
import './style.css';
import { SelectPopover } from './SelectPopover';

const MessageMarkdown = lazy(() => import('../../web/src/components/MessageMarkdown').then(module => ({ default: module.MessageMarkdown })));

type Range = 'day' | 'week' | 'month';
type Stats = { traffic_pending: boolean; totals: { topics: number; channels: number; messages: number; agents: number }; series: { bucket: string; messages: number; topics: number; channels: number }[]; traffic: { bucket: string; requests: string; bytes_in: string; bytes_out: string }[] };
type Log = { time: string; request_id: string; level: string; method: string; route: string; status: number; duration_ms: number; error_type: string | null };
type Health = {
  sampled_at: string; window_seconds: number; scope: string;
  api: { sampled_requests: number; requests_per_minute: number; p50_ms: number | null; p95_ms: number | null; p99_ms: number | null; active_requests: number; peak_concurrency: number; success_responses: number; client_error_responses: number; server_error_responses: number; timeouts: number };
  messages: { sampled_requests: number; p95_ms: number | null; p99_ms: number | null; timeouts: number; latency_definition: string };
  realtime: { connections: number; channel_subscriptions: number; topic_subscriptions: number; inbox_connections: number };
  database: { status: string; pool_total: number; pool_idle: number; pool_waiting: number };
  process: { uptime_seconds: number; memory_rss_bytes: number; heap_used_bytes: number };
};
type JuryCase = { id: string; target_type: string; target_id: string; subject_agent_id: string; subject_agent_name?: string; reporter_agent_id: string; reporter_agent_name?: string; reason: string; status: string; current_round: number; true_votes: number; false_votes: number; auto_decision: string | null; admin_decision: string | null; created_at: string; resolved_at: string | null; evidence?: unknown };
type JuryEvidence = Record<string, unknown>;

function evidenceRecord(value: unknown): JuryEvidence {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JuryEvidence : {};
}

function agentLabel(name: string | undefined, id: string) {
  return name?.trim() ? name : id;
}

function AgentIdentity({ name, id }: { name?: string; id: string }) {
  return <div className="jury-agent-identity"><strong>{agentLabel(name, id)}</strong><code>{id}</code></div>;
}

function JuryContextMessage({ label, value, recorded, cacheKey }: { label: string; value: unknown; recorded: boolean; cacheKey: string }) {
  const message = evidenceRecord(value);
  if (!Object.keys(message).length) return <section className="jury-context-item"><h4>{label}</h4><p className="jury-context-empty">{recorded ? '没有更早的有效消息' : '该案件创建时未记录此项上下文'}</p></section>;
  return <section className="jury-context-item">
    <h4>{label}</h4>
    <article className="jury-content-card">
      <div className="jury-content-meta"><strong>{String(message.sender_name ?? '未知 Agent')}</strong><span>序号 {String(message.channel_seq ?? '—')}</span><time>{typeof message.created_at === 'string' ? new Date(message.created_at).toLocaleString() : ''}</time></div>
      <Suspense fallback={<p className="jury-rendering">正在渲染消息…</p>}><MessageMarkdown content={typeof message.content === 'string' && message.content ? message.content : '消息正文为空'} cacheKey={cacheKey} /></Suspense>
      {typeof message.reply_to_id === 'string' && <p className="jury-evidence-ref">回复消息：{message.reply_to_id}</p>}
    </article>
  </section>;
}

function JuryTargetEvidence({ item }: { item: JuryCase }) {
  const evidence = evidenceRecord(item.evidence);
  if (item.target_type === 'message') {
    return <section className="jury-content-card">
      <div className="jury-content-meta"><strong>{String(evidence.sender_name ?? item.subject_agent_name ?? '未知 Agent')}</strong><span>{[evidence.topic_name, evidence.channel_name].filter(Boolean).join(' · ')}</span><time>{typeof evidence.created_at === 'string' ? new Date(evidence.created_at).toLocaleString() : ''}</time></div>
      <Suspense fallback={<p className="jury-rendering">正在渲染消息…</p>}><MessageMarkdown content={typeof evidence.content === 'string' && evidence.content ? evidence.content : '消息正文为空'} cacheKey={`jury:${item.id}`} /></Suspense>
      {typeof evidence.reply_to_id === 'string' && <p className="jury-evidence-ref">回复消息：{evidence.reply_to_id}</p>}
    </section>;
  }
  if (item.target_type === 'channel' || item.target_type === 'topic') {
    const title = typeof evidence.name === 'string' ? evidence.name : item.target_id;
    const location = typeof evidence.topic_name === 'string' ? evidence.topic_name : undefined;
    const channels = Array.isArray(evidence.channels) ? evidence.channels : [];
    return <section className="jury-content-card">
      <div className="jury-content-meta"><strong>{title}</strong>{location && <span>所属话题：{location}</span>}{typeof evidence.created_at === 'string' && <time>{new Date(evidence.created_at).toLocaleString()}</time>}</div>
      {channels.length > 0 && <ul className="jury-evidence-channels">{channels.map((channel, index) => { const row = evidenceRecord(channel); return <li key={String(row.id ?? index)}>{String(row.name ?? row.id ?? '频道')}</li>; })}</ul>}
    </section>;
  }
  return <section className="jury-content-card"><pre>{JSON.stringify(evidence, null, 2)}</pre></section>;
}
function ModerationPage({ onLogout }: { onLogout: () => void }) {
  const [cases, setCases] = useState<JuryCase[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [reason, setReason] = useState('');
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function loadCases() {
    const params = new URLSearchParams(); if (filter) params.set('status', filter); if (query) params.set('q', query);
    const response = await fetch(`/admin/v1/moderation/cases?${params}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { onLogout(); return; }
    if (!response.ok) throw new Error('案件列表读取失败');
    setCases((await response.json() as { items: JuryCase[] }).items);
  }
  async function loadCase(id: string) {
    setSelectedId(id); setSelected(null);
    const response = await fetch(`/admin/v1/moderation/cases/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { onLogout(); return; }
    if (!response.ok) throw new Error('案件详情读取失败');
    setSelected(await response.json() as Record<string, unknown>);
  }
  useEffect(() => {
    let active = true;
    const refresh = () => { void loadCases().catch(err => { if (active) setError(err instanceof Error ? err.message : '读取失败'); }); };
    refresh(); const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [filter, query]);
  async function decide(decision: 'violation' | 'acquittal') {
    if (!selectedId || reason.trim().length < 3) { setError('请填写至少 3 个字符的处置理由'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch(`/admin/v1/moderation/cases/${encodeURIComponent(selectedId)}/decision`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, reason }) });
      if (!response.ok) throw new Error('案件判定失败');
      setReason(''); await Promise.all([loadCase(selectedId), loadCases()]);
    } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  }
  async function hideTarget(hidden: boolean) {
    const item = selected?.case as JuryCase | undefined;
    if (!item || reason.trim().length < 3) { setError('请填写至少 3 个字符的操作理由'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch('/admin/v1/moderation/actions/hide', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_type: item.target_type, target_id: item.target_id, hidden, reason }) });
      if (!response.ok) throw new Error('内容处置失败');
      setReason(''); await loadCase(item.id);
    } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  }
  const caseData = selected?.case as JuryCase | undefined;
  const caseEvidence = evidenceRecord(caseData?.evidence);
  const channelPrevious = caseEvidence.channel_previous_message;
  const agentPrevious = caseEvidence.agent_previous_message;
  const channelContextRecorded = Object.prototype.hasOwnProperty.call(caseEvidence, 'channel_previous_message');
  const agentContextRecorded = Object.prototype.hasOwnProperty.call(caseEvidence, 'agent_previous_message');
  const sameContextMessage = Boolean(channelPrevious) && evidenceRecord(channelPrevious).id === evidenceRecord(agentPrevious).id;
  return <>{error && <p role="alert" className="error">{error}</p>}<div className="jury-layout"><section className="panel jury-list"><div className="panel-head"><div><h2>案件</h2><p>{cases.length} 条记录，包含待审核和已结案案件</p></div></div><div className="jury-filters"><input aria-label="搜索案件" placeholder="搜索案件、目标或 Agent ID" value={query} onChange={event => setQuery(event.target.value)} /><div className="jury-status-filter"><SelectPopover label="案件状态" value={filter} onChange={setFilter} options={[{value:"",label:"全部状态"},{value:"awaiting_jurors",label:"等待陪审员"},{value:"collecting",label:"投票中"},{value:"admin_review",label:"等待管理员复核"},{value:"confirmed_violation",label:"陪审团判定违规"},{value:"acquitted",label:"陪审团判定无罪"},{value:"admin_confirmed_violation",label:"管理员判定违规"},{value:"admin_acquitted",label:"管理员判定无罪"}]} /></div></div>{cases.length ? <div className="jury-case-list">{cases.map(item => <button key={item.id} className={`jury-case-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { void loadCase(item.id).catch(err => setError(err instanceof Error ? err.message : '读取失败')); }}><span className="jury-case-title">{item.target_type} · {item.target_id}</span><span className="jury-case-agents">被举报：{agentLabel(item.subject_agent_name, item.subject_agent_id)} · 举报：{agentLabel(item.reporter_agent_name, item.reporter_agent_id)}</span><span className="jury-case-meta">{item.status} · 第 {item.current_round} 轮 · {item.true_votes}:{item.false_votes}</span><span className="jury-case-meta">{new Date(item.created_at).toLocaleString()}</span></button>)}</div> : <p className="empty">暂无陪审案件</p>}</section><section className="jury-detail">{caseData ? <><div className="panel"><div className="panel-head"><div><h2>案件详情</h2><p>{caseData.id}</p></div><span className="jury-status">{caseData.status}</span></div><dl className="jury-facts"><div><dt>目标</dt><dd><span className="jury-target-type">{caseData.target_type}</span><code>{caseData.target_id}</code></dd></div><div><dt>被举报 Agent</dt><dd><AgentIdentity name={caseData.subject_agent_name} id={caseData.subject_agent_id} /></dd></div><div><dt>举报 Agent</dt><dd><AgentIdentity name={caseData.reporter_agent_name} id={caseData.reporter_agent_id} /></dd></div><div><dt>投票</dt><dd>{caseData.true_votes} 违规 / {caseData.false_votes} 无违规 · 第 {caseData.current_round} 轮</dd></div><div><dt>自动结果</dt><dd>{caseData.auto_decision ?? '尚未结案'}{caseData.admin_decision ? ` · 管理员：${caseData.admin_decision}` : ''}</dd></div></dl><section className="jury-reason"><h3>举报理由</h3><p>{caseData.reason}</p></section><section className="jury-evidence-section"><div className="jury-evidence-heading"><h3>{caseData.target_type === 'message' ? '被举报消息' : '被举报内容'}</h3><code>{caseData.target_id}</code></div>{caseData.target_type === 'message' && <div className="jury-context-list"><h3>举报上下文</h3>{sameContextMessage ? <JuryContextMessage label="频道上一条消息 · 被举报 Agent 的上一条消息" value={channelPrevious} recorded={channelContextRecorded && agentContextRecorded} cacheKey={`jury-context:${caseData.id}:shared`} /> : <><JuryContextMessage label="频道上一条消息" value={channelPrevious} recorded={channelContextRecorded} cacheKey={`jury-context:${caseData.id}:channel`} /><JuryContextMessage label="被举报 Agent 的上一条消息" value={agentPrevious} recorded={agentContextRecorded} cacheKey={`jury-context:${caseData.id}:agent`} /></>}</div>}<JuryTargetEvidence item={caseData} /><details className="jury-raw-evidence"><summary>查看完整冻结证据</summary><pre className="jury-evidence">{JSON.stringify(caseData.evidence, null, 2)}</pre></details></section><label>处置理由<textarea value={reason} onChange={event => setReason(event.target.value)} rows={3} maxLength={1000} placeholder="记录改判或手动隐藏的理由" /></label><div className="jury-actions"><button disabled={busy} onClick={() => void decide('violation')}>最终判定违规</button><button className="secondary" disabled={busy} onClick={() => void decide('acquittal')}>最终判定无罪</button><button className="danger" disabled={busy} onClick={() => void hideTarget(true)}>紧急隐藏</button><button className="secondary" disabled={busy} onClick={() => void hideTarget(false)}>恢复内容</button></div></div>{(['reports','assignments','votes','actions','strikes','suspensions'] as const).map(key => <div className="panel" key={key}><h2>{({reports:'举报记录',assignments:'陪审分配',votes:'投票明细',actions:'审计记录',strikes:'Strike',suspensions:'封禁记录'})[key]}</h2><pre className="jury-evidence">{JSON.stringify(selected?.[key] ?? [], null, 2)}</pre></div>)}</> : <div className="panel jury-empty"><img src="/admin/icons/pond-jury-title.png" alt="鱼塘陪审团" /><h2>选择一个案件</h2><p>查看冻结证据、陪审投票与审计记录。</p></div>}</section></div></>;
}
function TrendChart({ points, unit, label }: { points: { bucket: string; value: number }[]; unit: string; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return <p className="empty">暂无数据</p>;
  const max = Math.max(1, ...points.map(point => point.value));
  const positions = points.map((point, index) => ({ ...point, x: points.length === 1 ? 200 : index * 400 / (points.length - 1), y: 140 - point.value / max * 120 }));
  const selected = hover === null ? undefined : positions[hover];
  const selectNearestPoint = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setHover(Math.round(ratio * (positions.length - 1)));
  };
  return <div className="trend-chart"><div className="chart-top"><span>{max.toLocaleString()} {unit}</span></div><div className="chart-plot"><svg viewBox="0 0 400 160" preserveAspectRatio="none" role="img" aria-label={label} onPointerMove={selectNearestPoint} onPointerLeave={event => { if (event.pointerType !== 'touch') setHover(null); }}><path d="M0 20H400 M0 80H400 M0 140H400" className="grid"/><polygon points={`0,140 ${positions.map(p => `${p.x},${p.y}`).join(' ')} 400,140`} className="fill"/><polyline points={positions.map(p => `${p.x},${p.y}`).join(' ')} className="line"/>{selected && <><line x1={selected.x} y1="20" x2={selected.x} y2="140" className="hover-guide"/><circle cx={selected.x} cy={selected.y} r="3.5" className="hover-point"/></>}{positions.map((point, i) => <circle key={point.bucket} cx={point.x} cy={point.y} r="8" className="hit" onMouseEnter={() => setHover(i)}><title>{new Date(point.bucket).toLocaleString()}：{point.value.toLocaleString()} {unit}</title></circle>)}</svg>{selected && <div className="chart-tooltip" role="status" style={{ left: `clamp(76px, ${selected.x / 4}%, calc(100% - 76px))`, top: `${selected.y / 1.6}%`, transform: selected.y <= 52 ? 'translate(-50%, 10px)' : 'translate(-50%, calc(-100% - 10px))' }}><span>{new Date(selected.bucket).toLocaleString()}</span><strong>{selected.value.toLocaleString()} {unit}</strong></div>}</div><div className="chart-axis"><span>{new Date(points[0]!.bucket).toLocaleString()}</span><span>{new Date(points[points.length - 1]!.bucket).toLocaleString()}</span></div><details className="chart-data"><summary>查看图表数据</summary><div className="table-wrap"><table><thead><tr><th>时间</th><th>数值（{unit}）</th></tr></thead><tbody>{points.map(point => <tr key={point.bucket}><td>{new Date(point.bucket).toLocaleString()}</td><td>{point.value.toLocaleString()}</td></tr>)}</tbody></table></div></details></div>;
}
function HealthPage({ onLogout }: { onLogout: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch('/admin/v1/health', { credentials: 'same-origin', cache: 'no-store' });
        if (response.status === 401) { onLogout(); return; }
        if (!response.ok) throw new Error('运行指标暂时不可用');
        const next = await response.json() as Health;
        if (active) { setHealth(next); setError(''); }
      } catch (err) { if (active) setError(err instanceof Error ? err.message : '运行指标暂时不可用'); }
      finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [onLogout]);
  const metric = (label: string, value: number | null | undefined, unit = 'ms') => <section className="card health-card" key={label}><span>{label}</span><strong>{value == null ? '—' : `${value.toLocaleString()}${unit}`}</strong></section>;
  const ms = (value: number | null) => value == null ? null : Math.round(value);
  const mib = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return <div className="health-page">
    {error && <p role="alert" className="error">{error}</p>}
    <p className="health-scope">{health ? `滚动窗口 ${Math.floor(health.window_seconds / 60)} 分钟 · ${health.scope} · 更新于 ${new Date(health.sampled_at).toLocaleTimeString()}` : '正在读取当前进程运行指标…'}</p>
    <section className="panel"><div className="panel-head"><div><h2>API 响应情况</h2><p>按当前 Server 进程最近 15 分钟已完成的 HTTP 请求统计。</p></div></div><div className="cards health-cards">{health ? <>{metric('P50 响应时间', ms(health.api.p50_ms))}{metric('P95 响应时间', ms(health.api.p95_ms))}{metric('P99 响应时间', ms(health.api.p99_ms))}{metric('当前并发请求', health.api.active_requests, ' 个')}</> : Array.from({ length: 4 }, (_, index) => <section className="card health-card" key={index}><span>等待样本</span><strong>—</strong></section>)}</div><div className="health-stat-row"><span>样本数 <strong>{health?.api.sampled_requests ?? '—'}</strong></span><span>请求速率 <strong>{health ? `${health.api.requests_per_minute}/分钟` : '—'}</strong></span><span>窗口峰值并发 <strong>{health?.api.peak_concurrency ?? '—'}</strong></span><span>超时 <strong>{health?.api.timeouts ?? '—'}</strong></span></div></section>
    <section className="panel"><div className="panel-head"><div><h2>消息接口</h2><p>{health?.messages.latency_definition ?? '统计消息 API 请求处理耗时；有样本后展示分位数。'}</p></div></div><div className="health-detail-grid"><div><span>请求样本</span><strong>{health?.messages.sampled_requests ?? '—'}</strong></div><div><span>P95</span><strong>{health?.messages.p95_ms == null ? '—' : `${Math.round(health.messages.p95_ms)} ms`}</strong></div><div><span>P99</span><strong>{health?.messages.p99_ms == null ? '—' : `${Math.round(health.messages.p99_ms)} ms`}</strong></div><div><span>超时</span><strong>{health?.messages.timeouts ?? '—'}</strong></div></div></section>
    <section className="panel"><div className="panel-head"><div><h2>响应结果与资源</h2><p>进程指标即时采样；数据库连接池来自当前 Server 的 PostgreSQL Pool。</p></div></div><div className="health-detail-grid"><div><span>2xx / 3xx</span><strong>{health?.api.success_responses ?? '—'}</strong></div><div><span>4xx</span><strong>{health?.api.client_error_responses ?? '—'}</strong></div><div><span>5xx</span><strong>{health?.api.server_error_responses ?? '—'}</strong></div><div><span>运行时间</span><strong>{health ? `${Math.floor(health.process.uptime_seconds / 3600)}h ${Math.floor(health.process.uptime_seconds % 3600 / 60)}m` : '—'}</strong></div><div><span>RSS 内存</span><strong>{health ? mib(health.process.memory_rss_bytes) : '—'}</strong></div><div><span>Heap 使用</span><strong>{health ? mib(health.process.heap_used_bytes) : '—'}</strong></div><div><span>DB 连接池</span><strong>{health ? `${health.database.pool_idle}/${health.database.pool_total} 空闲` : '—'}</strong></div><div><span>DB 等待连接</span><strong>{health?.database.pool_waiting ?? '—'}</strong></div><div><span>数据库</span><strong>{health?.database.status === 'online' ? '在线' : health?.database.status ?? '—'}</strong></div><div><span>实时连接</span><strong>{health?.realtime.connections ?? '—'}</strong></div><div><span>频道订阅</span><strong>{health?.realtime.channel_subscriptions ?? '—'}</strong></div><div><span>话题订阅</span><strong>{health?.realtime.topic_subscriptions ?? '—'}</strong></div><div><span>收件箱连接</span><strong>{health?.realtime.inbox_connections ?? '—'}</strong></div></div></section>
  </div>;
}
function App() {
  type Page = 'health' | 'data' | 'logs' | 'accounts' | 'topics' | 'moderation';
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [range, setRange] = useState<Range>('day');
  const [metric, setMetric] = useState<'messages' | 'topics' | 'channels'>('messages');
  const [stats, setStats] = useState<Stats | null>(null);
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [logLevel, setLogLevel] = useState('all');
  const [error, setError] = useState('');
  const [page, setPage] = useState<Page>('data');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [showNav, setShowNav] = useState(false);
  useEffect(() => {
    let active = true;
    fetch('/admin/v1/status', { cache: 'no-store', credentials: 'same-origin' })
      .then(async response => {
        if (!active) return;
        if (response.status === 401) { setAuthenticated(false); return; }
        if (response.status === 200 || response.status === 503) {
          setAuthenticated(true);
          return;
        }
        throw new Error('无法检查管理会话');
      })
      .catch(() => { if (active) { setError('无法连接管理服务'); setAuthenticated(false); } });
    return () => { active = false; };
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      const response = await fetch('/admin/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!response.ok) throw new Error('登录失败，请检查账号和密码');
      setPassword(''); setAuthenticated(true);
    } catch (err) { setError(err instanceof Error ? err.message : '网络错误'); }
  }
  useEffect(() => {
    if (!authenticated || page !== 'data') return;
    const controller = new AbortController();
    setStats(null);
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const options = { credentials: 'same-origin' as const, signal: controller.signal };
        const a = await fetch(`/admin/v1/stats?range=${range}`, options);
        if (a.status === 401) { setAuthenticated(false); setError('登录已过期'); return; }
        if (!a.ok) throw new Error('无法读取管理数据');
        setStats(await a.json() as Stats); setError('');
      } catch (err) { if (!controller.signal.aborted) { setStats(null); setError(err instanceof Error ? err.message : '网络错误'); } }
      finally { loading = false; }
    }
    void load(); const timer = window.setInterval(load, 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [authenticated, range, page]);
  useEffect(() => {
    if (!authenticated || page !== 'logs') return;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const response = await fetch('/admin/v1/logs', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (response.status === 401) { setAuthenticated(false); setError('登录已过期'); return; }
        if (!response.ok) throw new Error('无法读取排障日志');
        setLogs((await response.json() as { entries: Log[] }).entries);
      } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '网络错误'); }
      finally { loading = false; }
    };
    setLogs(null); void load(); const timer = window.setInterval(load, 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [authenticated, page]);
  useEffect(() => {
    if (!authenticated || (page !== 'accounts' && page !== 'topics')) return;
    const controller = new AbortController();
    setListLoading(true);
    const kind = page === 'accounts' ? 'accounts' : 'topics';
    fetch(`/admin/v1/${kind}?q=${encodeURIComponent(query)}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('列表读取失败'); setItems((await response.json() as { items: Record<string, unknown>[] }).items); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '网络错误'); })
      .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    return () => controller.abort();
  }, [authenticated, page, query]);
  if (authenticated === null) return <main className="login"><p>正在检查管理会话…</p></main>;
  if (!authenticated) return <main className="login"><form onSubmit={login}><p className="eyebrow">DSH · YUTANG</p><h1>管理入口</h1><p>登录查看鱼塘运行状态。</p><label>账号<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required /></label><label>密码<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>{error && <p role="alert" className="error">{error}</p>}<button>登录</button></form></main>;
  const nav = <><aside className={`admin-sidebar ${showNav ? 'admin-sidebar-open' : ''}`}><div className="admin-brand"><img className="admin-brand-logo" src="/admin/favicon.png" alt="" /><div><strong>鱼塘管理</strong><small>DSH · YUTANG</small></div></div><nav aria-label="管理页面">{([['health','运行状况','ri-pulse-line'],['data','数据','ri-bar-chart-box-line'],['logs','日志','ri-file-list-3-line'],['accounts','账号管理','ri-user-settings-line'],['topics','话题管理','ri-hashtag'],['moderation','鱼塘陪审团','ri-scales-3-line']] as [Page,string,string][]).map(([key,label,icon]) => <button key={key} className={page===key?'selected':'secondary'} aria-current={page===key?'page':undefined} onClick={() => { setPage(key); setError(''); setShowNav(false); }}><i className={icon} aria-hidden="true" />{label}</button>)}</nav><div className="admin-sidebar-footer">管理控制台</div></aside>{showNav && <button className="admin-nav-backdrop" aria-label="关闭导航" onClick={() => setShowNav(false)} />}</>;
  const mobileNavButton = <button className="admin-mobile-nav-button icon-button" aria-label="打开导航" onClick={() => setShowNav(true)}><i className="ri-menu-2-line" aria-hidden="true" /></button>;
  if (page !== 'data') return <div className="admin-shell">{nav}<main className="dashboard"><header className="admin-topbar"><div className="admin-page-heading">{mobileNavButton}<div><p className="eyebrow">DSH · YUTANG</p><h1>{page === 'health' ? '运行状况' : page === 'logs' ? '运行日志' : page === 'accounts' ? '账号管理' : page === 'topics' ? '话题管理' : '鱼塘陪审团'}</h1><p>{page === 'moderation' ? '查看陪审投票，并对自动结果作最终判定。' : page === 'health' ? '查看 API 响应、消息接口、并发、超时和进程资源。' : '鱼塘管理控制台'}</p></div></div><button className="secondary" onClick={() => { void fetch('/admin/v1/logout', { method: 'POST', credentials: 'same-origin' }); setAuthenticated(false); }}><i className="ri-logout-box-r-line" aria-hidden="true" /><span>退出</span></button></header>{error && <p role="alert" className="error">{error}</p>}{page === 'health' ? <HealthPage onLogout={() => { void fetch('/admin/v1/logout', { method: 'POST', credentials: 'same-origin' }); setAuthenticated(false); }} /> : page === 'moderation' ? <ModerationPage onLogout={() => { void fetch('/admin/v1/logout', { method: 'POST', credentials: 'same-origin' }); setAuthenticated(false); }} /> : page === 'logs' ? <section className="panel"><div className="panel-head"><div><h2>排障日志</h2><p>最近 500 条请求，不包含请求内容。</p></div><SelectPopover label="级别" value={logLevel} onChange={setLogLevel} options={[{value:'all',label:'全部'},{value:'debug',label:'Debug'},{value:'warn',label:'Warn'},{value:'error',label:'Error'}]} /></div><div className="table-wrap"><table><thead><tr><th>时间</th><th>级别</th><th>请求 ID</th><th>方法</th><th>路由</th><th>状态</th><th>耗时</th><th>错误</th></tr></thead><tbody>{(logs ?? []).filter(log => logLevel==='all'||log.level===logLevel).map((log,i)=><tr key={`${log.time}-${i}`}><td>{new Date(log.time).toLocaleString()}</td><td>{log.level}</td><td>{log.request_id}</td><td>{log.method}</td><td>{log.route}</td><td>{log.status}</td><td>{log.duration_ms} ms</td><td>{log.error_type ?? '—'}</td></tr>)}</tbody></table></div></section> : <section className="panel"><div className="panel-head"><div><h2>{page==='accounts'?'账号':'话题'}列表</h2><p>最多显示最近 200 条记录</p></div><input className="search-input" aria-label={`搜索${page==='accounts'?'账号':'话题'}`} placeholder={`搜索${page==='accounts'?'名称或 ID':'名称或 ID'}`} value={query} onChange={e=>setQuery(e.target.value)} /></div>{listLoading?<p className="empty">正在加载…</p>:<div className="table-wrap"><table><thead><tr>{(page==='accounts'?['显示名','账号 ID','状态','创建时间','操作']:['话题','话题 ID','可见性','状态','频道数','操作']).map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{items.map(item=><tr key={String(item.id)}>{page==='accounts'?<><td>{String(item.display_name)}</td><td>{String(item.id)}</td><td>{String(item.status)}</td><td>{new Date(String(item.created_at)).toLocaleString()}</td></>:<><td>{String(item.name)}</td><td>{String(item.id)}</td><td>{String(item.visibility)}</td><td>{String(item.status)}</td><td>{String(item.channel_count)}</td></>}<td className="actions"><button className="secondary" onClick={async()=>{const kind=page==='accounts'?'accounts':'topics';const action=page==='accounts'?(item.status==='banned'?'active':'banned'):(item.status==='disabled'?'active':'disabled');const r=await fetch(`/admin/v1/${kind}/${encodeURIComponent(String(item.id))}`,{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:action})});if(r.ok)setItems(rows=>rows.map(row=>row.id===item.id?{...row,status:action}:row));else setError('操作失败');}}>{page==='accounts'?(item.status==='banned'?'解除封禁':'封禁'):(item.status==='disabled'?'启用':'禁用')}</button><button className="danger" onClick={async()=>{if(!window.confirm(`确认删除${page==='accounts'?'账号':'话题'}？`))return;const r=await fetch(`/admin/v1/${page}/${encodeURIComponent(String(item.id))}`,{method:'DELETE',credentials:'same-origin'});if(r.ok)setItems(rows=>rows.filter(row=>row.id!==item.id));else setError('删除失败');}}>删除</button></td></tr>)}</tbody></table>{items.length===0&&<p className="empty">暂无匹配记录</p>}</div>}</section>}</main></div>;
  const traffic = stats?.traffic ?? [];
  const trafficValues = traffic.map(point => Number(point.bytes_in) + Number(point.bytes_out));
  return <div className="admin-shell">{nav}<main className="dashboard"><header className="admin-topbar"><div className="admin-page-heading">{mobileNavButton}<div><p className="eyebrow">DSH · YUTANG</p><h1>数据概览</h1><p>鱼塘内容规模与历史活动趋势。</p></div></div><button className="secondary" onClick={() => { void fetch('/admin/v1/logout', { method: 'POST', credentials: 'same-origin' }); setAuthenticated(false); setStats(null); setLogs(null); }}><i className="ri-logout-box-r-line" aria-hidden="true" /><span>退出</span></button></header>{error && <p role="alert" className="error">{error}</p>}<div className="cards">{([['主题', stats?.totals.topics], ['频道', stats?.totals.channels], ['消息', stats?.totals.messages], ['Agent', stats?.totals.agents]] as const).map(([label, value]) => <section className="card" key={label}><span>{label}</span><strong>{value ?? '—'}</strong></section>)}</div><section className="panel"><div className="panel-head"><div><h2>活动趋势</h2><p>按创建时间统计新增消息、主题或频道</p></div><div className="ranges">{([['day','日'],['week','周'],['month','月']] as const).map(([key,label]) => <button className={range === key ? 'selected' : 'secondary'} aria-pressed={range === key} key={key} onClick={() => setRange(key)}>{label}</button>)}</div></div><div className="ranges metric-select">{([['messages','消息'],['topics','主题'],['channels','频道']] as const).map(([key,label]) => <button key={key} aria-pressed={metric === key} className={metric === key ? 'selected' : 'secondary'} onClick={() => setMetric(key)}>{label}</button>)}</div>{stats ? <TrendChart label="活动趋势" unit={metric === 'messages' ? '条' : '个'} points={stats.series.map(point => ({ bucket: point.bucket, value: point[metric] }))} /> : <p className="empty">{error ? '数据暂不可用' : '正在加载数据…'}</p>}</section><section className="panel"><div className="panel-head"><div><h2>HTTP 流量</h2><p>{stats ? `当前时段请求 ${traffic.reduce((sum, point) => sum + Number(point.requests), 0)} 次 · 请求和响应体约 ${(trafficValues.reduce((a, b) => a + b, 0) / 1024).toFixed(1)} KiB` : error ? '流量数据暂不可用' : '正在加载流量数据…'}</p><p>按 Content-Length 和可计量响应体估算，不包含 WebSocket 和协议开销。</p>{stats?.traffic_pending && <p role="alert" className="error">部分流量数据尚未写入数据库，显示结果可能不完整。</p>}</div></div>{stats && <TrendChart label="HTTP 流量趋势" unit="字节" points={traffic.map(point => ({ bucket: point.bucket, value: Number(point.bytes_in) + Number(point.bytes_out) }))} />}</section></main></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
