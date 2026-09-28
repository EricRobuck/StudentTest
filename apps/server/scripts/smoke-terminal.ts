// Phase 4 verification: drives the terminal exactly like a browser would.
// Requires a running backend (npm run dev, or npm run dev:server).
//
//   npm run smoke:terminal                          → http://127.0.0.1:3001
//   npm run smoke:terminal -- http://127.0.0.1:3101

import WebSocket from 'ws';
import { TERMINAL_CLOSE, TERMINAL_WS_PATH, type SessionResponse } from '@linuxlab/shared';

const base = process.argv[2] ?? 'http://127.0.0.1:3001';
const wsUrl = base.replace(/^http/, 'ws') + TERMINAL_WS_PATH;
const ORIGIN = 'http://127.0.0.1:5173';

let failures = 0;
function report(ok: boolean, name: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

/** Removes colors, cursor codes, window titles and carriage returns, leaving plain lines. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, '');
}

/** Opens a terminal socket and collects its output (as plain text). */
function openTerminal(headers: Record<string, string>) {
  const ws = new WebSocket(wsUrl, { headers });
  let output = '';
  const control: Array<Record<string, unknown>> = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) output = stripAnsi(output + data.toString());
    else control.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const failed = new Promise<string>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode))));
  return {
    ws,
    closed,
    failed,
    control,
    get output() {
      return output;
    },
    opened: new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    }),
    type(text: string) {
      ws.send(Buffer.from(text), { binary: true });
    },
    async waitFor(pattern: RegExp, timeoutMs = 8000): Promise<boolean> {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (pattern.test(output)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    },
  };
}

async function main(): Promise<void> {
  console.log(`Testing ${base}\n`);

  // 1. Session creation sets an httpOnly cookie.
  const res = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: ORIGIN } });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const body = (await res.json()) as SessionResponse;
  report(res.ok && body.resumed === false, 'POST /api/session creates a new session', `${res.status} ${JSON.stringify(body)}`);
  report(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), 'Session cookie is HttpOnly + SameSite=Strict', setCookie);
  const cookie = setCookie.split(';')[0]!;

  // 2. Resuming with the same cookie returns the same session.
  const again = (await (await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie } })).json()) as SessionResponse;
  report(again.sessionId === body.sessionId && again.resumed, 'Same cookie resumes the same session');

  // 3. Security: foreign origin and missing cookie are refused.
  const foreignPost = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
  report(foreignPost.status === 403, 'POST from a foreign website is refused (403)', String(foreignPost.status));

  const foreign = openTerminal({ Origin: 'https://evil.example', Cookie: cookie });
  report((await foreign.failed) === '403', 'WebSocket from a foreign website is refused (403)');

  const noCookie = openTerminal({ Origin: ORIGIN });
  report((await noCookie.closed) === TERMINAL_CLOSE.NO_SESSION, 'WebSocket without a session is closed (4001)');

  // 4. Real Bash in the container.
  const t1 = openTerminal({ Origin: ORIGIN, Cookie: cookie });
  await t1.opened;
  t1.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
  report(await t1.waitFor(/student@linux:~\$ $/m), 'Bash prompt appears (student@linux:~$)', JSON.stringify(t1.output.slice(-200)));

  t1.type('whoami; hostname; tput cols\r');
  report(await t1.waitFor(/\nstudent\nlinux\n100\n/),'Commands run in the container (whoami, hostname, resize)', JSON.stringify(t1.output.slice(-300)));

  t1.type('mkdir -p /tmp/cybersecurity && cd /etc && echo MARK-$((6*7))\r');
  report(await t1.waitFor(/MARK-42/), 'Shell state changes (mkdir, cd /etc)');

  // 5. Disconnect + reconnect lands in the same shell (the "refresh" test).
  t1.ws.close();
  await t1.closed;
  const t2 = openTerminal({ Origin: ORIGIN, Cookie: cookie });
  await t2.opened;
  await new Promise((r) => setTimeout(r, 300));
  const attached = t2.control.find((m) => m.type === 'attached');
  report(attached?.resumed === true, 'Reconnect is reported as resumed');
  report(t2.output.includes('MARK-42'), 'Previous output is replayed after reconnect');
  t2.type('pwd; ls -d /tmp/cybersecurity\r');
  report(await t2.waitFor(/\n\/etc\n\/tmp\/cybersecurity\n/),'Same shell after reconnect (still in /etc)', JSON.stringify(t2.output.slice(-200)));

  // 6. A second tab takes over; the first is told why.
  const t3 = openTerminal({ Origin: ORIGIN, Cookie: cookie });
  await t3.opened;
  report((await t2.closed) === TERMINAL_CLOSE.REPLACED, 'Second window takes over; first gets 4002');

  // 7. `exit` gives a fresh shell instead of a dead terminal.
  await new Promise((r) => setTimeout(r, 300));
  t3.type('exit\r');
  report(await t3.waitFor(/student@linux:~\$ $/m, 8000) && t3.control.some((m) => m.type === 'shell-restarted'), '`exit` starts a new shell');

  t3.ws.close();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  console.log(`(Session ${body.sessionId} is left to the idle timeout / reaper.)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
