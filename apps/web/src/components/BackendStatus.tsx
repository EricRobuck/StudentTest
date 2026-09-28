import type { BackendHealth } from '../hooks/useBackendHealth';

export function BackendStatus({ health }: { health: BackendHealth }) {
  switch (health.state) {
    case 'checking':
      return <span className="status status-checking">Checking backend…</span>;
    case 'online': {
      const { info } = health;
      const dockerReady = info.docker.available && info.docker.imagePresent;
      return (
        <span className="footer-statuses">
          <span className="status status-online">
            Backend online · {info.service} v{info.version} · server time{' '}
            {new Date(info.serverTime).toLocaleTimeString()}
          </span>
          <span className={`status ${dockerReady ? 'status-online' : 'status-offline'}`}>
            {dockerReady ? 'Linux environments ready' : `Linux environments unavailable: ${info.docker.message}`}
          </span>
        </span>
      );
    }
    case 'offline':
      return (
        <span className="status status-offline">Backend unreachable: {health.message}</span>
      );
  }
}
