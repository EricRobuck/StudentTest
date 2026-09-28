import Docker from 'dockerode';
import { Writable } from 'node:stream';
import type { ContainerConfig } from '../../config.js';
import {
  ContainerError,
  type ContainerRuntime,
  type ExecOptions,
  type ExecResult,
  type RuntimeStatus,
  type SessionContainer,
  type ShellHandle,
} from './types.js';

const LABEL_MANAGED = 'linuxlab.managed';
const LABEL_SESSION = 'linuxlab.session';
// Which backend installation owns the container. Several backends can share
// one Docker host (dev + test, two courses); each only manages its own.
const LABEL_INSTANCE = 'linuxlab.instance';
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const HOME = '/home/student';
const SHELL_ENV = ['TERM=xterm-256color', 'LANG=C.UTF-8', `HOME=${HOME}`, 'USER=student'];

// The home directory is a fresh tmpfs, so fill it from the image's skeleton
// once the container starts. A constant script; nothing is interpolated.
const POPULATE_HOME = `cp -a /etc/skel/. ${HOME}/ && mkdir -p ${HOME}/Documents ${HOME}/Downloads ${HOME}/Desktop && chown -R 1000:1000 ${HOME}`;

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Docker-backed student environments.
 *
 * Every container is created with the same locked-down settings; nothing in
 * the request path can loosen them. See docs/ARCHITECTURE.md §5.
 */
export function createDockerRuntime(cfg: ContainerConfig, docker = new Docker()): ContainerRuntime {
  const hostConfig: Docker.HostConfig = {
    // Isolation
    NetworkMode: 'none',
    Privileged: false,
    CapDrop: ['ALL'],
    // Only used by root execs (setup/grading) to read and fix up student files.
    // The student's own processes run as uid 1000 and get no capabilities.
    CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER'],
    SecurityOpt: ['no-new-privileges:true'],
    IpcMode: 'private',
    // No Binds, Mounts, or Volumes: nothing from the host is visible inside.

    // Resource limits
    Memory: cfg.memoryBytes,
    MemorySwap: cfg.memoryBytes, // no swap beyond the memory limit
    NanoCpus: cfg.nanoCpus,
    PidsLimit: cfg.pidsLimit, // stops fork bombs
    Ulimits: [
      { Name: 'nofile', Soft: cfg.maxOpenFiles, Hard: cfg.maxOpenFiles },
      { Name: 'fsize', Soft: cfg.maxFileSizeBytes, Hard: cfg.maxFileSizeBytes },
    ],
    // Every directory the student can write to is a size-limited tmpfs, so
    // nothing a student does can fill the host's disk (the image's root
    // filesystem is only writable by root, i.e. by setup/grading). tmpfs
    // pages count against the container's memory limit too. `exec` lets
    // students run their own scripts (chmod +x; ./script.sh) as expected.
    Tmpfs: {
      '/tmp': `rw,exec,nosuid,nodev,size=${cfg.tmpSizeMb}m,mode=1777`,
      '/var/tmp': 'rw,exec,nosuid,nodev,size=16m,mode=1777',
      '/run/lock': 'rw,noexec,nosuid,nodev,size=1m,mode=1777',
      [HOME]: `rw,exec,nosuid,nodev,size=${cfg.homeSizeMb}m,mode=0755,uid=1000,gid=1000`,
    },
    ShmSize: 16 * 1024 * 1024,

    // Lifecycle
    Init: true, // reap zombie processes
    AutoRemove: false, // removal is explicit so failures are visible
    RestartPolicy: { Name: 'no' },
    LogConfig: { Type: 'none', Config: {} },
  };

  async function status(): Promise<RuntimeStatus> {
    try {
      await docker.ping();
    } catch (err) {
      return {
        available: false,
        imagePresent: false,
        image: cfg.image,
        message: `Docker is not reachable (${errorMessage(err)}). Is Docker Desktop running?`,
      };
    }
    try {
      await docker.getImage(cfg.image).inspect();
      return { available: true, imagePresent: true, image: cfg.image };
    } catch (err) {
      if (statusCode(err) === 404) {
        return {
          available: true,
          imagePresent: false,
          image: cfg.image,
          message: `Image ${cfg.image} not found. Run: npm run image:build`,
        };
      }
      return { available: true, imagePresent: false, image: cfg.image, message: errorMessage(err) };
    }
  }

  async function listManaged(options: { allInstances?: boolean } = {}): Promise<SessionContainer[]> {
    const labels = [`${LABEL_MANAGED}=true`];
    if (!options.allInstances) labels.push(`${LABEL_INSTANCE}=${cfg.instanceId}`);
    const containers = await docker.listContainers({ all: true, filters: { label: labels } });
    return containers.map((c) => ({
      containerId: c.Id,
      name: (c.Names[0] ?? '').replace(/^\//, ''),
      sessionId: c.Labels[LABEL_SESSION] ?? '',
      createdAt: new Date(c.Created * 1000),
      running: c.State === 'running',
    }));
  }

  async function createSessionContainer(sessionId: string): Promise<SessionContainer> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new ContainerError('INVALID_INPUT', 'Invalid session id');
    }

    const st = await status();
    if (!st.available) throw new ContainerError('DOCKER_UNAVAILABLE', st.message ?? 'Docker unavailable');
    if (!st.imagePresent) throw new ContainerError('IMAGE_MISSING', st.message ?? 'Image missing');

    const existing = await listManaged();
    if (existing.length >= cfg.maxConcurrent) {
      throw new ContainerError('CAPACITY', 'Too many active exam environments; try again shortly');
    }

    const name = `linuxlab-${sessionId}`;
    let container: Docker.Container;
    try {
      container = await docker.createContainer({
        name,
        Image: cfg.image,
        Hostname: 'linux',
        User: 'student',
        WorkingDir: '/home/student',
        Env: SHELL_ENV,
        Cmd: ['sleep', 'infinity'],
        NetworkDisabled: true,
        Labels: { [LABEL_MANAGED]: 'true', [LABEL_SESSION]: sessionId, [LABEL_INSTANCE]: cfg.instanceId },
        HostConfig: hostConfig,
      });
    } catch (err) {
      throw new ContainerError('DOCKER_ERROR', `Could not create container: ${errorMessage(err)}`, {
        cause: err,
      });
    }

    try {
      await container.start();
      const home = await exec(container.id, ['/bin/bash', '-c', POPULATE_HOME], { user: 'root', timeoutMs: 10_000 });
      if (home.exitCode !== 0) throw new Error(`home setup failed: ${home.stderr.trim().slice(0, 200)}`);
    } catch (err) {
      await container.remove({ force: true }).catch(() => undefined);
      throw new ContainerError('DOCKER_ERROR', `Could not start container: ${errorMessage(err)}`, {
        cause: err,
      });
    }

    return { containerId: container.id, name, sessionId, createdAt: new Date(), running: true };
  }

  async function exec(
    containerId: string,
    argv: readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    if (argv.length === 0) throw new ContainerError('INVALID_INPUT', 'Empty command');
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    // `timeout` runs inside the container so the process is really killed,
    // not just abandoned, when the limit is reached.
    const cmd = ['/usr/bin/timeout', '-s', 'KILL', `${(timeoutMs / 1000).toFixed(3)}s`, ...argv];

    const container = docker.getContainer(containerId);
    const execution = await container.exec({
      Cmd: cmd,
      User: options.user ?? 'root',
      WorkingDir: options.workingDir,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stdout = new CappedCollector(maxBytes);
    const stderr = new CappedCollector(maxBytes);
    const started = Date.now();

    const stream = await execution.start({ hijack: true, stdin: false });
    docker.modem.demuxStream(stream, stdout, stderr);

    await new Promise<void>((resolve, reject) => {
      // Backstop in case the in-container timeout itself hangs.
      const guard = setTimeout(() => {
        stream.destroy();
        resolve();
      }, timeoutMs + 5_000);
      const done = () => {
        clearTimeout(guard);
        resolve();
      };
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', (err) => {
        clearTimeout(guard);
        reject(new ContainerError('DOCKER_ERROR', `Exec stream failed: ${errorMessage(err)}`));
      });
    });

    const exitCode = await waitForExitCode(execution);
    const elapsed = Date.now() - started;
    // `timeout` exits 124, or 137 (128 + SIGKILL) when it had to kill the command.
    const timedOut = (exitCode === 124 || exitCode === 137) && elapsed >= timeoutMs - 50;

    return {
      exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut,
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  async function isRunning(containerId: string): Promise<boolean> {
    try {
      const info = await docker.getContainer(containerId).inspect();
      return info.State.Running;
    } catch (err) {
      if (statusCode(err) === 404) return false;
      throw new ContainerError('DOCKER_ERROR', `Could not inspect container: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  async function attachShell(
    containerId: string,
    size: { cols: number; rows: number },
  ): Promise<ShellHandle> {
    const execution = await docker.getContainer(containerId).exec({
      Cmd: ['/bin/bash', '--login'],
      User: 'student',
      WorkingDir: '/home/student',
      Env: SHELL_ENV,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });
    const stream = await execution.start({ hijack: true, stdin: true, Tty: true });
    // The PTY only exists once the exec has started, so size it afterwards.
    await execution.resize({ h: size.rows, w: size.cols }).catch(() => undefined);

    let exited = false;
    const exitListeners: Array<() => void> = [];
    const fireExit = () => {
      if (exited) return;
      exited = true;
      for (const listener of exitListeners) listener();
    };
    stream.on('end', fireExit);
    stream.on('close', fireExit);
    stream.on('error', fireExit);

    return {
      write: (data) => {
        if (!exited) stream.write(data);
      },
      resize: async (cols, rows) => {
        if (exited) return;
        await execution.resize({ h: rows, w: cols }).catch(() => undefined);
      },
      onData: (listener) => {
        // With a TTY, Docker sends raw bytes (no stdout/stderr multiplexing).
        stream.on('data', (chunk: Buffer) => listener(chunk));
      },
      onExit: (listener) => {
        if (exited) listener();
        else exitListeners.push(listener);
      },
      pause: () => stream.pause(),
      resume: () => stream.resume(),
      close: () => {
        stream.end();
        stream.destroy();
      },
    };
  }

  async function destroy(containerId: string): Promise<void> {
    try {
      await docker.getContainer(containerId).remove({ force: true });
    } catch (err) {
      if (statusCode(err) === 404) return; // already gone
      throw new ContainerError('DOCKER_ERROR', `Could not remove container: ${errorMessage(err)}`, {
        cause: err,
      });
    }
  }

  return { status, createSessionContainer, isRunning, attachShell, exec, destroy, listManaged };
}

async function waitForExitCode(execution: Docker.Exec): Promise<number | null> {
  // The stream can close a moment before Docker records the exit code.
  for (let i = 0; i < 20; i++) {
    const info = await execution.inspect();
    if (!info.Running) return info.ExitCode ?? null;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** Collects stream output up to a byte limit and discards the rest. */
class CappedCollector extends Writable {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly limit: number) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    const room = this.limit - this.size;
    if (room > 0) {
      const take = chunk.subarray(0, room);
      this.chunks.push(take);
      this.size += take.length;
    }
    if (chunk.length > Math.max(room, 0)) this.truncated = true;
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function statusCode(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'statusCode' in err
    ? (err as { statusCode?: number }).statusCode
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
