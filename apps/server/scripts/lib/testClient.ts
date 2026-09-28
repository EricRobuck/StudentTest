// Helpers shared by the smoke scripts: act like a browser against a running backend.

import WebSocket from 'ws';
import { TERMINAL_WS_PATH } from '@linuxlab/shared';

export const ORIGIN = 'http://127.0.0.1:5173';

export function createReporter() {
  let failures = 0;
  return {
    report(ok: boolean, name: string, detail = ''): void {
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
    },
    finish(): never {
      console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
      process.exit(failures === 0 ? 0 : 1);
    },
  };
}

/** Removes colors, cursor codes, window titles and carriage returns, leaving plain lines. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, '');
}

/** Opens a terminal socket and collects its output (as plain text). */
export function openTerminal(base: string, headers: Record<string, string>) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + TERMINAL_WS_PATH, { headers });
  let output = '';
  const control: Array<Record<string, unknown>> = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) output = stripAnsi(output + data.toString());
    else control.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const failed = new Promise<string>((resolve) =>
    ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode))),
  );
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

/** A browser-like HTTP client that keeps the session cookie. */
export function createHttpClient(base: string) {
  let cookie = '';
  return {
    get cookie() {
      return cookie;
    },
    async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; setCookie: string }> {
      const headers: Record<string, string> = { Origin: ORIGIN };
      if (cookie) headers.Cookie = cookie;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie') ?? '';
      if (setCookie) cookie = setCookie.split(';')[0]!;
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T, setCookie };
    },
  };
}
