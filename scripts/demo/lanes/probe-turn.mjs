#!/usr/bin/env node
/** Probe: boot one demo-lanes Session and print exactly what a model turn returns. */
import { DeepSeekHarness } from '/Users/coffeiz/Desktop/workspace/deepseek-harness/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const harness = new DeepSeekHarness({
  profile: 'demo-lanes',
  dshHome: join(homedir(), '.dsh'),
  provider: process.argv[2] ?? 'zai-coding-cn',
  model: process.argv[3] ?? 'glm-4.5-air',
  patches: [join(here, 'cordis.patch.yml')],
  initializeTimeoutMs: 120_000,
  requestTimeoutMs: 180_000,
})

try {
  const session = harness.session()
  await session.setWorkingDirectory(join(here, 'workspaces', 'chen'))
  const result = await session.run('只回复两个字：就绪')
  console.log('finalResponse:', JSON.stringify(result?.finalResponse))
  console.log('finishReason:', JSON.stringify(result?.finishReason))
  const events = result?.events ?? []
  console.log('event types:', JSON.stringify(events.map(event => event.type)))
  for (const event of events.slice(-4)) {
    console.log('tail event:', event.type, JSON.stringify(event.data).slice(0, 1500))
  }
  const notifications = result?.notifications ?? []
  console.log('notifications:', JSON.stringify(notifications).slice(0, 2000))
} catch (error) {
  console.error('probe failed:', error?.message ?? error)
} finally {
  await harness.close()
}
