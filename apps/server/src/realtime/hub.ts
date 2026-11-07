import type { WebSocket } from "@fastify/websocket";

export type RealtimeEvent = {
  type: string;
  version: 1;
  data: Record<string, unknown>;
  emitted_at: string;
};

export type HubConnection = {
  socket: WebSocket;
  agentId: string | null;
  channels: Set<string>;
  topics: Set<string>;
  inbox: boolean;
  jury: boolean;
  lastHeartbeatAt: number;
};

const heartbeatSweepMs = 15_000;
const heartbeatTimeoutMs = 150_000;

export class RealtimeHub {
  private readonly connections = new Set<HubConnection>();
  private readonly presenceHandlers = new Set<(agentId: string, online: boolean) => void>();
  private readonly inboxHandlers = new Set<(agentId: string) => void>();
  private readonly juryHandlers = new Set<(agentId: string) => void>();
  private readonly livenessSweep: NodeJS.Timeout;

  constructor() {
    this.livenessSweep = setInterval(() => {
      for (const connection of this.connections) {
        if (connection.socket.readyState !== 1) {
          this.remove(connection);
          continue;
        }
        if (Date.now() - connection.lastHeartbeatAt > heartbeatTimeoutMs) {
          connection.socket.terminate();
          this.remove(connection);
        }
      }
    }, heartbeatSweepMs);
    this.livenessSweep.unref();
  }

  metrics(): { connections: number; channel_subscriptions: number; topic_subscriptions: number; inbox_connections: number; jury_connections: number } {
    const active = [...this.connections].filter((connection) => connection.socket.readyState === 1);
    return {
      connections: active.length,
      channel_subscriptions: active.reduce((total, connection) => total + connection.channels.size, 0),
      topic_subscriptions: active.reduce((total, connection) => total + connection.topics.size, 0),
      inbox_connections: active.filter((connection) => connection.inbox).length,
      jury_connections: active.filter((connection) => connection.jury).length,
    };
  }

  onPresenceChange(handler: (agentId: string, online: boolean) => void): void {
    this.presenceHandlers.add(handler);
  }

  onInboxReady(handler: (agentId: string) => void): void {
    this.inboxHandlers.add(handler);
  }

  onJuryReady(handler: (agentId: string) => void): void {
    this.juryHandlers.add(handler);
  }

  isAgentOnline(agentId: string): boolean {
    return [...this.connections].some((connection) => connection.agentId === agentId && connection.socket.readyState === 1);
  }

  isAgentInboxAvailable(agentId: string): boolean {
    return [...this.connections].some((connection) => connection.agentId === agentId && connection.inbox && connection.socket.readyState === 1);
  }

  isAgentJuryAvailable(agentId: string): boolean {
    return [...this.connections].some((connection) => connection.agentId === agentId && connection.jury && connection.socket.readyState === 1);
  }

  closeAgent(agentId: string): void {
    for (const connection of this.connections) {
      if (connection.agentId !== agentId) continue;
      connection.socket.close(1008, "Agent unregistered");
      this.remove(connection);
    }
  }

  add(socket: WebSocket, agentId: string | null): HubConnection {
    const wasOnline = agentId ? this.isAgentOnline(agentId) : false;
    const connection: HubConnection = {
      socket,
      agentId,
      channels: new Set(),
      topics: new Set(),
      inbox: false,
      jury: false,
      lastHeartbeatAt: Date.now(),
    };
    this.connections.add(connection);
    socket.on("close", () => this.remove(connection));
    socket.on("error", () => this.remove(connection));
    if (agentId && !wasOnline) for (const handler of this.presenceHandlers) handler(agentId, true);
    return connection;
  }

  receivedHeartbeat(connection: HubConnection): void {
    connection.lastHeartbeatAt = Date.now();
  }

  private remove(connection: HubConnection): void {
    if (!this.connections.delete(connection)) return;
    if (connection.agentId && !this.isAgentOnline(connection.agentId)) for (const handler of this.presenceHandlers) handler(connection.agentId, false);
  }

  subscribeChannel(connection: HubConnection, channelId: string): void {
    connection.channels.add(channelId);
  }

  subscribeTopic(connection: HubConnection, topicId: string): void {
    connection.topics.add(topicId);
  }

  unsubscribeChannel(connection: HubConnection, channelId: string): void {
    connection.channels.delete(channelId);
  }

  unsubscribeTopic(connection: HubConnection, topicId: string): void {
    connection.topics.delete(topicId);
  }

  subscribeInbox(connection: HubConnection): void {
    if (connection.agentId) {
      connection.inbox = true;
      for (const handler of this.inboxHandlers) handler(connection.agentId);
    }
  }

  subscribeJury(connection: HubConnection): void {
    if (connection.agentId) {
      connection.jury = true;
      for (const handler of this.juryHandlers) handler(connection.agentId);
    }
  }

  publishJury(agentId: string, event: RealtimeEvent): void {
    this.publish((connection) => connection.agentId === agentId && connection.jury, event);
  }

  send(connection: HubConnection, event: RealtimeEvent): void {
    if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify(event));
  }

  closeAll(): void {
    clearInterval(this.livenessSweep);
    for (const connection of this.connections) {
      connection.socket.close(1001, "Server is shutting down");
    }
    this.connections.clear();
  }

  publishChannel(channelId: string, event: RealtimeEvent): void {
    this.publish((connection) => connection.channels.has(channelId), event);
  }

  publishTopic(topicId: string, event: RealtimeEvent): void {
    this.publish((connection) => connection.topics.has(topicId), event);
  }

  publishInbox(agentId: string, event: RealtimeEvent): void {
    this.publish((connection) => connection.agentId === agentId && connection.inbox, event);
  }

  private publish(predicate: (connection: HubConnection) => boolean, event: RealtimeEvent): void {
    const encoded = JSON.stringify(event);
    for (const connection of this.connections) {
      if (!predicate(connection)) continue;
      if (connection.socket.readyState !== 1) {
        this.remove(connection);
        continue;
      }
      if (connection.socket.bufferedAmount > 512 * 1024) {
        connection.socket.close(1013, "Client is too slow; recover with REST");
        this.remove(connection);
        continue;
      }
      try {
        connection.socket.send(encoded);
      } catch {
        connection.socket.close(1011, "Realtime delivery failed");
        this.remove(connection);
      }
    }
  }
}

export function realtimeEvent(type: string, data: Record<string, unknown>): RealtimeEvent {
  return { type, version: 1, data, emitted_at: new Date().toISOString() };
}
