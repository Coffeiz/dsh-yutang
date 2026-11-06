/** Exact, reviewed tool names that may be opted into during a Yutang turn lock. */
export const TURN_LOCK_ALLOWLIST_OPTIONS = ['web_search', 'web_fetch'] as const;
export type TurnLockAllowedTool = typeof TURN_LOCK_ALLOWLIST_OPTIONS[number];

export function normalizeTurnLockAllowlist(value: unknown): TurnLockAllowedTool[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is TurnLockAllowedTool =>
    typeof name === 'string' && TURN_LOCK_ALLOWLIST_OPTIONS.includes(name as TurnLockAllowedTool)))];
}

/**
 * Tracks the first Yutang tool invocation in each Agent turn. The caller
 * persists snapshots so a plugin reload cannot reopen the same active turn.
 */
export class YutangTurnToolLock {
  private readonly lockedTurns = new Map<string, number>();

  restore(records: Record<string, number>) {
    this.lockedTurns.clear();
    for (const [agentId, turn] of Object.entries(records)) {
      if (agentId && Number.isSafeInteger(turn) && turn > 0) this.lockedTurns.set(agentId, turn);
    }
  }

  arm(agentId: string | undefined, turn: number | undefined): boolean {
    if (!agentId || turn === undefined || !Number.isSafeInteger(turn) || turn < 1) return false;
    if (this.lockedTurns.get(agentId) === turn) return false;
    this.lockedTurns.set(agentId, turn);
    return true;
  }

  check(agentId: string | undefined, turn: number | undefined, toolName: string, allowedTools: readonly string[]): string | undefined {
    if (!agentId || turn === undefined || !Number.isSafeInteger(turn) || turn < 1) return undefined;

    const lockedTurn = this.lockedTurns.get(agentId);
    if (toolName.startsWith('yutang_')) {
      this.arm(agentId, turn);
      return undefined;
    }

    if (lockedTurn === turn && !allowedTools.includes(toolName)) {
      return '本轮已调用鱼塘工具，工具锁已生效；此工具不在主人设置的白名单中。请在下一轮用户消息后再调用。';
    }

    if (lockedTurn !== undefined && lockedTurn !== turn) this.lockedTurns.delete(agentId);
    return undefined;
  }
}
