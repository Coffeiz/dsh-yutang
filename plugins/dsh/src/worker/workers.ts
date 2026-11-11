import type { Context } from '@deepseek-ai/cordis';
import type { YutangRuntime } from '../service/runtime.js';
import { YutangWorker, laneKeyOf, type WorkerLane } from './controller.js';

type LaneStatus = { worker: string; realtime: string; last_error?: string; lanes?: number };

/**
 * Supervises one {@link YutangWorker} per bound DSH Session.
 *
 * Each entry of `state.session_bindings` gets its own lane, so five Sessions can run
 * five personas against five Connections concurrently without sharing a task slot,
 * a realtime socket or an identity.
 */
export class YutangWorkers {
  private readonly lanes = new Map<string, YutangWorker>();
  private reconciling: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly ctx: Context, private readonly runtime: YutangRuntime) {}

  async start() {
    this.runtime.setSettingsChangedHandler(() => this.reconcile());
    this.runtime.setWorkerStatusReader(() => this.status());
    await this.reconcile();
  }

  status(): LaneStatus {
    if (this.lanes.size === 0) return { worker: 'stopped', realtime: 'disconnected', lanes: 0 };
    let running = false;
    let connected = false;
    let lastError: string | undefined;
    for (const lane of this.lanes.values()) {
      const status = lane.status();
      if (status.worker === 'running') running = true;
      if (status.realtime === 'connected') connected = true;
      if (status.last_error) lastError = status.last_error;
    }
    return {
      worker: running ? 'running' : 'ready',
      realtime: connected ? 'connected' : 'disconnected',
      lanes: this.lanes.size,
      ...(lastError ? { last_error: lastError } : {}),
    };
  }

  /** Multi-lane detail for diagnostics surfaces. */
  statuses() {
    return [...this.lanes.values()].map(lane => ({ session_id: lane.sessionId, server_id: lane.connectionId, ...lane.status() }));
  }

  /** Diff the binding table and converge the running lanes onto it. */
  async reconcile(): Promise<void> {
    const previous = this.reconciling;
    let release: () => void = () => {};
    this.reconciling = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => {});
    try {
      if (this.disposed) return;
      const state = await this.runtime.state();
      const desired = new Map<string, WorkerLane>();
      for (const [sessionId, binding] of Object.entries(state.session_bindings)) {
        if (!state.servers.some(server => server.id === binding.connection_id)) continue;
        const lane: WorkerLane = { sessionId, connectionId: binding.connection_id };
        desired.set(laneKeyOf(lane), lane);
      }
      for (const [key, lane] of [...this.lanes]) {
        if (!desired.has(key)) {
          this.lanes.delete(key);
          await lane.dispose().catch(error => this.runtime.logWarn('Yutang worker lane dispose failed', error));
        }
      }
      for (const [key, lane] of desired) {
        const existing = this.lanes.get(key);
        if (existing) {
          await existing.onBindingChanged(lane).catch(error => this.runtime.logWarn('Yutang worker lane refresh failed', error));
          continue;
        }
        const worker = new YutangWorker(this.ctx, this.runtime, lane);
        this.lanes.set(key, worker);
        await worker.start().catch(error => this.runtime.logWarn('Yutang worker lane startup failed', error));
      }
    } finally {
      release();
    }
  }

  async dispose() {
    this.disposed = true;
    this.runtime.setSettingsChangedHandler(() => {});
    this.runtime.setWorkerStatusReader(() => ({ worker: 'stopped', realtime: 'disconnected', lanes: 0 }));
    const lanes = [...this.lanes.values()];
    this.lanes.clear();
    await Promise.all(lanes.map(lane => lane.dispose().catch(error => this.runtime.logWarn('Yutang worker lane dispose failed', error))));
  }
}
