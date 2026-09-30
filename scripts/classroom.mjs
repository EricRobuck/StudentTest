// Classroom mode: serve the exam from this computer to students on the same network.
//
//   npm run classroom
//
// Only the web page (port 4173) is opened to the network. It forwards API and
// terminal traffic to the backend, which stays private on 127.0.0.1:3001
// together with Docker. Students open the address printed below.

import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';

const PORT = 4173;

/**
 * This computer's address on the local network: the one Windows uses for
 * outgoing traffic (a UDP "connect" sends nothing, it only picks a route), so
 * virtual adapters from VirtualBox, WSL or Docker are never chosen.
 * Override with CLASSROOM_ADDRESS=... if needed.
 */
function lanAddress() {
  if (process.env.CLASSROOM_ADDRESS) return Promise.resolve(process.env.CLASSROOM_ADDRESS);
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    socket.on('error', () => resolve(fallbackAddress()));
    socket.connect(53, '1.1.1.1', () => {
      const { address } = socket.address();
      socket.close();
      resolve(address && address !== '0.0.0.0' ? address : fallbackAddress());
    });
  });
}

function fallbackAddress() {
  const skip = /vEthernet|WSL|Docker|VirtualBox|VMware|Loopback|Tailscale|ZeroTier/i;
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return undefined;
}

const address = await lanAddress();
if (!address) {
  console.error('Could not find this computer\'s network address. Is Wi-Fi/Ethernet connected?');
  process.exit(1);
}
const studentUrl = `http://${address}:${PORT}`;

/** True if something (usually `npm run dev`) is already listening on the port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

for (const port of [3001, PORT]) {
  if (await portInUse(port)) {
    console.error(
      `[classroom] Port ${port} is already in use. Stop "npm run dev" (Ctrl+C in its window) or any other copy of the exam server, then run "npm run classroom" again.`,
    );
    process.exit(1);
  }
}

function run(name, command, env = {}) {
  const child = spawn(command, { shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[classroom] ${name} stopped (exit ${code})`);
    process.exit(code ?? 0);
  });
  return child;
}

console.log('[classroom] building the student site…');
const build = spawn('npm run build -w @linuxlab/web', { shell: true, stdio: 'inherit' });
build.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1);

  run('backend', 'npm run start -w @linuxlab/server', {
    WEB_URL: studentUrl,
    ALLOWED_ORIGINS: [studentUrl, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`].join(','),
  });
  run('web', `npm run preview -w @linuxlab/web -- --host 0.0.0.0 --port ${PORT} --strictPort`);

  setTimeout(() => {
    console.log(`
==============================================================
  Students go to:     ${studentUrl}
  Instructor pages:   ${studentUrl}/instructor
  (on this PC you can also use http://localhost:${PORT})

  Stop with Ctrl+C.
==============================================================
`);
  }, 4000);
});
