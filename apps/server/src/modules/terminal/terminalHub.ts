import type { WebSocket } from 'ws';
import type { ContainerRuntime } from '../containers/index.js';
import type { ExamSession } from '../sessions/sessionManager.js';
import { TerminalBridge, type BridgeConfig } from './terminalBridge.js';

/** Owns one TerminalBridge per active exam session. */
export class TerminalHub {
  private readonly bridges = new Map<string, TerminalBridge>();

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly cfg: BridgeConfig,
    private readonly onActivity: (sessionId: string) => void,
  ) {}

  attach(session: ExamSession, ws: WebSocket): void {
    let bridge = this.bridges.get(session.id);
    if (!bridge) {
      bridge = new TerminalBridge(session, this.runtime, this.cfg, () => this.onActivity(session.id));
      this.bridges.set(session.id, bridge);
    }
    bridge.attach(ws);
  }

  isAttached(sessionId: string): boolean {
    return this.bridges.get(sessionId)?.isAttached ?? false;
  }

  closeSession(sessionId: string, code: number, reason: string): void {
    this.bridges.get(sessionId)?.close(code, reason);
    this.bridges.delete(sessionId);
  }

  closeAll(code: number, reason: string): void {
    for (const id of [...this.bridges.keys()]) this.closeSession(id, code, reason);
  }
}
