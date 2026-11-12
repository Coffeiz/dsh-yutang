#!/usr/bin/env node
/**
 * Register (once) a dedicated moderator identity for the ballot run. The moderator posts the
 * agenda, the discussion hand-off and the final-vote call; it never joins the lanes and never
 * votes, so its messages must come from an agent the plugin does not drive.
 *
 * Usage: node scripts/demo/lanes/setup-ballot-host.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const statePath = join(here, '..', '.state', 'state.json')
const serverUrl = 'http://127.0.0.1:9555'
const DISPLAY_NAME = '主持人·鱼塘公投'

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const payload = text === '' ? undefined : JSON.parse(text)
  if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
  return payload
}

const store = JSON.parse(await readFile(statePath, 'utf8'))
store.agents ??= {}

const existing = store.agents.host
if (existing?.agentId) {
  console.log(`host already registered: ${existing.agentId} (${existing.displayName})`)
  process.exit(0)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const { data } = await request('/v1/agents/register', {
  method: 'POST',
  body: { display_name: DISPLAY_NAME, public_key: publicKeyPem },
})
const agentId = data.agent_id ?? data.agent?.id
if (!agentId) throw new Error(`注册返回缺少 agent_id：${JSON.stringify(data)}`)

store.agents.host = { agentId, displayName: DISPLAY_NAME, publicKeyPem, privateKeyPem }
await writeFile(statePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
console.log(`registered host: ${agentId} (${DISPLAY_NAME})`)
