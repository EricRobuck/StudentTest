import { TERMINAL_CLOSE } from '@linuxlab/shared';
import type { WebSocket } from 'ws';
import type { ContainerRuntime } from '../containers/index.js';
import { TerminalBridge, type BridgeConfig, type BridgeTarget } from './terminalBridge.js';

/** Owns one TerminalBridge per active exam session. */
export class TerminalHub {
  private readonly bridges = new Map<string, TerminalBridge>();

  constructor(
    private readonly runtime: ContainerRuntime,
    private readonly cfg: BridgeConfig,
    private readonly onActivity: (sessionId: string) => void,
  ) {}

  attach(target: BridgeTarget, ws: WebSocket): void {
    let bridge = this.bridges.get(target.sessionId);
    // The session's container was replaced (e.g. after an idle timeout):
    // the old bridge points at a container that no longer exists.
    if (bridge && bridge.containerId !== target.containerId) {
      this.closeSession(target.sessionId, TERMINAL_CLOSE.ENDED, 'Environment replaced');
      bridge = undefined;
    }
    if (!bridge) {
      bridge = new TerminalBridge(target, this.runtime, this.cfg, () => this.onActivity(target.sessionId));
      this.bridges.set(target.sessionId, bridge);
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
