# Architecture — Linux Practical Exam Platform

Status: Phase 1 (project skeleton) complete. This document records the target
architecture and the decisions made up front to avoid rewrites later. Update it
whenever a decision changes.

## 1. System overview

```text
Browser (React + xterm.js)
   │  REST  /api/*           (exam data, submit, results; JSON)
   │  WS    /ws/terminal     (terminal bytes + small JSON control messages)
   ▼
Node.js backend (Express + ws)            ← the ONLY process that talks to Docker
   ├─ auth            sessions, roles (student / instructor)
   ├─ exams           exam + question definitions, attempts, timer (server clock)
   ├─ terminal        WS ⇄ PTY bridge, reconnect buffer, command logging
   ├─ containers      create / exec / destroy / reap student containers
   ├─ grading         validator registry, runs checks via `docker exec`
   └─ db              repository layer (SQLite now, PostgreSQL later)
   ▼
Docker Engine
   ▼
One container per exam attempt: Ubuntu + Bash, user `student`, no network,
resource-limited, no host mounts, no Docker socket.
```

## 2. Repository layout

```text
gradeProgram/
├─ package.json            npm workspaces root; `npm run dev` starts everything
├─ tsconfig.base.json      strict TS settings shared by all packages
├─ packages/
│  └─ shared/              types + (later) zod schemas shared by client & server
│     └─ src/
│        ├─ api.ts         REST DTOs
│        ├─ (later) terminal-protocol.ts   WS message types
│        └─ (later) validators.ts          ValidatorSpec union + schemas
├─ apps/
│  ├─ server/              Node + Express + ws
│  │  └─ src/
│  │     ├─ index.ts       process entry: http server, signals, shutdown
│  │     ├─ app.ts         Express app factory (testable without listening)
│  │     ├─ config.ts      all env parsing lives here
│  │     ├─ routes/        thin HTTP handlers → call services
│  │     └─ (later) modules/
│  │        ├─ auth/
│  │        ├─ exams/
│  │        ├─ terminal/
│  │        ├─ containers/    ContainerRuntime interface + DockerRuntime
│  │        ├─ grading/       Validator interface, registry, validators/*
│  │        └─ db/            schema, migrations, repositories
│  └─ web/                 React + Vite
│     └─ src/
│        ├─ api/           typed fetch client
│        ├─ hooks/
│        ├─ components/
│        └─ (later) pages/ student exam, results, instructor
├─ docker/
│  └─ (Phase 3) student-ubuntu/Dockerfile
└─ docs/
   └─ ARCHITECTURE.md
```

Rule: routes are thin; business logic lives in services inside `modules/`,
never in React components or route handlers. Anything that crosses the network
is typed once in `packages/shared`.

## 3. Key decisions (made now to avoid rewrites)

1. **Monorepo with a shared contracts package.** Validator specs, question DTOs
   and WS messages are defined once. Runtime validation (zod) lives in shared
   too, so the server validates every payload with the same schema the client
   is typed against. The browser is never trusted.

2. **`ContainerRuntime` / lab-provider interface.** The rest of the server
   calls `createSession`, `exec`, `attachShell`, `destroy`, and never calls
   dockerode directly. Future lab types (Python, networking, forensics) plug in
   as new providers + new validators without touching the exam flow. This also
   allows swapping Docker for gVisor/Kata/Firecracker or a remote runner later.

3. **Grading runs out-of-band as root, the student shell runs as `student`.**
   Validators use `docker exec` with a fixed argv array (never a shell string
   built from input), as root, with absolute tool paths. Because the student
   is unprivileged, they cannot replace `/usr/bin/stat` or similar to fool
   the grader. Output from the container is untrusted: size-capped, time-limited, parsed strictly.
   Filesystem checks use `lstat` semantics so a symlink cannot impersonate a
   directory unless the rule allows it.

4. **Validators are pure plug-ins.** `interface Validator<P> { type; paramsSchema;
   run(ctx, params): Promise<ValidatorResult> }` registered in a registry.
   Results carry `passed`, `score` (0..1 for future partial credit) and a
   `detail` string for instructors. Compound rules = `{ mode: 'all' | 'any', rules[] }`.

5. **`current_directory` reads the real shell, not a file the student could edit.**
   The grader resolves the foreground process of the student's PTY and reads
   `/proc/<pid>/cwd` as root. Final design is chosen in Phase 6.

6. **Question templates vs. question instances.** The DB stores question
   *templates* (may contain `{{random_directory}}` etc.). When an attempt
   starts, each is resolved into an *instance* with concrete variable
   bindings stored on the attempt. Validators receive only resolved params.
   The MVP has no variables, but the tables exist so randomization is additive.

7. **Scoring stored for partial credit from day one.** Per submission store
   `max_points`, `points_awarded` (numeric), `validator_results` (JSON per
   rule), `attempt_number`, timestamps. MVP awards all-or-nothing.

8. **Server-authoritative time and state.** Exam deadline = `started_at +
   duration`, computed on the server. The client only displays it. Submissions
   after the deadline are rejected server-side.

9. **Terminal sessions survive browser refresh.** The backend keeps the
   container's PTY exec alive for a grace period and buffers recent output.
   On reconnect it reattaches the new WebSocket and replays the buffer, so the
   shell (and its cwd) is unchanged. Containers are destroyed only on exam
   completion, timeout, or an idle reaper — never on WS disconnect.

10. **WS protocol:** binary frames = raw terminal bytes; text frames = JSON
    control messages (`resize`, `ping`, `status`). Typed in `packages/shared`.

11. **Database behind a repository layer using a portable query builder**
    (planned: Kysely with SQLite, which also has a PostgreSQL dialect). No
    SQLite-specific SQL outside migrations. IDs are UUIDs/text, timestamps are
    ISO strings/UTC, so the move to PostgreSQL is a dialect change.

12. **Command logging from two sources.** (a) An in-shell hook (bash
    `PROMPT_COMMAND`) reports each command + cwd to the backend — accurate
    but tamperable by the student. (b) The backend records raw WS input — the student cannot tamper with it, but it is noisy. Command-based validation is
    therefore opt-in and treated as weaker evidence than state-based grading.
    Password-style exercises must suppress logging (see §5).

## 4. npm packages

| Where  | Package | Purpose | Phase |
|--------|---------|---------|-------|
| root   | typescript, concurrently | type checking, run both apps | 1 ✅ |
| server | express, tsx, @types/node, @types/express | HTTP API, TS runtime | 1 ✅ |
| web    | react, react-dom, vite, @vitejs/plugin-react | UI + dev server/proxy | 1 ✅ |
| web    | @xterm/xterm, @xterm/addon-fit | terminal UI | 2 |
| server | dockerode, @types/dockerode | Docker Engine API | 3 |
| server | ws, @types/ws | WebSocket server | 4 |
| shared | zod | runtime input validation | 5 |
| server | kysely, better-sqlite3 | DB + migrations | 7 |
| server | helmet, express-rate-limit, argon2 (or bcrypt), pino | hardening, auth, logs | 7–10 |
| web    | react-router | student / instructor pages | 9 |
| dev    | vitest | unit tests (validators first) | 6 |

## 5. Docker requirements

- **Development (Windows):** Docker Desktop with the WSL 2 backend. dockerode
  connects via the named pipe `//./pipe/docker_engine`.
- **Production:** a dedicated Linux host/VM. Strongly consider the gVisor
  (`runsc`) runtime, or at least userns-remap / rootless Docker, since students
  are given a shell by design.
- **Image `linuxlab/student-ubuntu`** (Phase 3): Ubuntu 24.04 LTS, user
  `student` (uid 1000, home `/home/student`, no sudo, no password), packages:
  coreutils, findutils, grep, less, procps, file, nano, vim-tiny, man-db (maybe),
  tini. No SSH, no compilers by default.
- **Container create options (baseline):**
  - `User: student` for the interactive shell; grader execs as root
  - `NetworkMode: none` (instructor can opt in per exercise, later)
  - `CapDrop: ALL`, add back only what setup/grading needs (e.g. CHOWN, FOWNER, DAC_OVERRIDE)
  - `SecurityOpt: ['no-new-privileges']`, default seccomp + AppArmor profiles
  - `Privileged: false`, no bind mounts, no volumes, no Docker socket
  - `Memory` ≈ 256 MB, `MemorySwap` = Memory, `NanoCpus` ≈ 0.5 CPU,
    `PidsLimit` ≈ 128, `Ulimits` (nofile, nproc, fsize)
  - Disk: `StorageOpt size` only works on overlay2+xfs (not Docker Desktop), so
    also use size-limited `tmpfs` for `/tmp` and a file-size ulimit
  - `Init: true` (reaps zombies), labels `linuxlab.session=<id>` for reaping
  - Hard lifetime timeout + a reaper that removes orphaned labelled containers
    on server start and periodically

## 6. Security concerns (threat model: the student is trying to break out)

| Risk | Mitigation |
|------|-----------|
| Container escape → host | non-root user, no-new-privileges, CapDrop ALL, seccomp/AppArmor, no privileged, no mounts; gVisor in production |
| Backend holds Docker access = root on host | bind to localhost, never expose the Docker API, minimal backend surface; later split into a separate container-manager service |
| Fork bomb / memory / CPU / disk exhaustion | pids, memory, cpu, ulimits, tmpfs sizes, max concurrent containers, lifetime timeout |
| Output flooding (`yes`, `cat /dev/urandom`) | backpressure + rate cap on the PTY→WS stream |
| Command injection in setup/validators | argv arrays only, strict path schemas (absolute, no NUL), instructor input validated too |
| Fooling the grader (symlinks, fake tools, aliases) | grader runs as root with absolute paths via exec, lstat semantics, no reliance on the student's shell environment |
| Tampering with command logs | treat shell-hook logs as advisory; keep raw server-side input log |
| WebSocket hijacking / another student's session | auth cookie checked on WS upgrade, Origin check, session ownership check on every message |
| XSS via logged commands / filenames in instructor UI | render as text only (React escaping; never `dangerouslySetInnerHTML`) |
| Client-side cheating on timer/score | server-authoritative timer, scoring and grading |
| Brute force / API abuse | rate limiting, audit log of auth + exam actions |
| Secrets in command logs (future password labs) | per-question "do not log" flag; never log input while a no-echo prompt is active |
| Network misuse / exfiltration | network disabled by default |

## 7. Phase log

- **Phase 1** — npm workspaces, shared types, Express `/api/health`, React
  shell calling the backend through the Vite proxy. ✅
- **Phase 2** — xterm.js `TerminalView` (fit-to-panel, resize tracking) behind
  a `TerminalTransport` interface (`apps/web/src/terminal/`). Uses a local
  echo transport for UI testing only; it executes nothing. Phase 4 adds a
  WebSocket transport and the view does not change. ✅
- **Phase 3** — `docker/student-ubuntu/Dockerfile` (user `student`, setuid bits
  stripped) and `apps/server/src/modules/containers/`: `ContainerRuntime`
  interface, `createDockerRuntime` (all hardening in one `hostConfig`), exec
  with in-container `timeout` + output caps, age-based reaper. Health endpoint
  reports Docker readiness. Verified with `npm run smoke:containers`.
  Notes: the rootfs has no disk quota on Docker Desktop (overlayfs); `/tmp` is
  a 64 MB tmpfs and single files are capped by the `fsize` ulimit. Containers
  are intentionally not removed on server shutdown (session recovery). The
  reaper is age-based only until sessions are tracked in the database.
- **Phase 4** — Browser terminal connected to real Bash.
  - `POST /api/session` (Origin-checked) creates or resumes the browser's
    session and sets an httpOnly, SameSite=Strict cookie holding a random
    token; the server stores only its SHA-256 (`modules/sessions/`).
  - `WS /ws/terminal` (`modules/terminal/terminalSocket.ts`) checks Origin +
    cookie on upgrade, then `TerminalHub` → one `TerminalBridge` per session:
    `docker exec -it bash --login` as `student`, binary frames for bytes,
    JSON for `resize`, 128 KB replay buffer, backpressure pause/resume,
    shell auto-restart on `exit`, ping/pong heartbeat.
  - A refresh/disconnect keeps the shell alive; the new socket reattaches to
    the same shell and the screen is replayed. A second tab takes over (the
    first is closed with code 4002).
  - Sessions are still in memory: idle sessions (no browser for 30 min) are
    ended; after a server restart old containers become orphans and the
    reaper removes them. Phase 7 persists sessions.
  - Not yet: login (any browser gets a session), rate limiting on
    `POST /api/session` (the `maxConcurrent` cap is the only brake).
- **Phase 5** — Five sample questions.
  - Question/validator/setup contracts in `packages/shared/src/exam.ts`
    (`ValidatorSpec` union, `ValidationSpec {mode: all|any}`, `SetupStep`).
  - Server-side definitions (`modules/exams/`): `ExamDefinition`,
    `QuestionDefinition` (incl. `labType` for future lab plug-ins), the
    hard-coded `sampleExam`, and `toStudentExam()` — an allow-list
    projection that is the only path from exam data to the browser.
  - `GET /api/exam` requires a session (`http/requireSession.ts`).
  - UI: progress steps, question panel (points, category, instructions,
    optional hint, Previous/Next). Current question is kept in
    sessionStorage until Phase 7 moves progress to the server.
  - The public repo contains the sample answers; real exams must live in
    the database, not in source.
