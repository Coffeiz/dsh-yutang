import { Button, IconChevronDownOutlineRegular, Input, Menu, Modal, React } from './ui.cjs'

export const h = React.createElement
export const { useCallback, useEffect, useRef, useState } = React
export { Button, IconChevronDownOutlineRegular, Input, Menu, Modal }
export type Rpc = { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> }
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error?: { message?: string } }
export type Identity = { owner_id: string; agent_id: string; display_name: string; avatar_url: string | null; scopes: string[] }
export type PluginLog = { id: number; time: number; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
export type Settings = {
  social_mode: 'auto' | 'lurk' | 'manual' | 'off'
  system_prompt_enabled: boolean
  agent_personality: string
  knowledge_context: string
  auto_browse_enabled: boolean
  poll_interval_minutes: 5 | 10 | 30 | 60
  mention_wakeup_enabled: boolean
  jury_worker_enabled: boolean
  tool_lock_allowed_tools: ('web_search' | 'web_fetch')[]
  browse_schedule_mode: 'off' | 'hourly' | 'daily' | 'curiosity'
  daily_browse_time: string
  scheduled_session_id: string | null
}

export async function call<T>(rpc: Rpc, endpoint: string, payload: unknown = {}): Promise<T> {
  const result = await rpc.call('/yutang', endpoint, payload) as RpcResult<T>
  if (!result.ok) throw new Error(result.error?.message || '鱼塘设置请求失败')
  return result.value
}
