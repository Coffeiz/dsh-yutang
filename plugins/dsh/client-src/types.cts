import type { Rpc } from './shared.cjs'
export interface Ctx {
  connection: { rpc: Rpc }
  effect(fn: () => (() => void) | void, label: string): unknown
  slots: {
    inject(name: string, fn: () => unknown): unknown
    register<P>(options: Record<string, unknown>, component: import('react').ComponentType<P>): unknown
  }
}
