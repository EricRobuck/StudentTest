import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalStatus, TerminalTransport } from './transport';

interface TerminalViewProps {
  /** Called once per mount. Must return a fresh transport. */
  createTransport: () => TerminalTransport;
}

const theme = {
  background: '#111418',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  selectionBackground: '#3b4252',
};

const statusClass: Record<TerminalStatus, string> = {
  connecting: 'status-checking',
  connected: 'status-online',
  disconnected: 'status-offline',
};

export function TerminalView({ createTransport }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ status: TerminalStatus; detail?: string }>({
    status: 'connecting',
  });
  const [label, setLabel] = useState('');
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 15,
      scrollback: 5000,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const transport = createTransport();
    setLabel(transport.label);

    const fitToHost = () => {
      // fit() is a no-op if the host has no size yet (e.g. hidden).
      try {
        fit.fit();
      } catch {
        return;
      }
      setSize({ cols: term.cols, rows: term.rows });
    };

    const resizeSub = term.onResize(({ cols, rows }) => transport.resize(cols, rows));
    const dataSub = term.onData((data) => transport.sendInput(data));

    transport.connect({
      onOutput: (data) => term.write(data),
      onStatus: (s, detail) => setStatus({ status: s, detail }),
      onReset: () => term.reset(),
    });

    fitToHost();
    transport.resize(term.cols, term.rows);
    term.focus();

    const observer = new ResizeObserver(() => fitToHost());
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      transport.dispose();
      term.dispose();
    };
  }, [createTransport]);

  return (
    <div className="terminal-view">
      <div className="terminal-toolbar">
        <span className={`status ${statusClass[status.status]}`}>
          {label || 'Terminal'} · {status.status}
          {status.detail ? ` (${status.detail})` : ''}
        </span>
        {size && (
          <span className="muted">
            {size.cols}×{size.rows}
          </span>
        )}
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
