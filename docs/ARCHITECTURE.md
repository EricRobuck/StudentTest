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
- **Phase 6** — Validators (`modules/grading/`).
  - `Validator<S>` interface + compile-time-checked registry: adding a
    validator = extend `ValidatorSpec`, add one file, add one registry line.
  - `gradeQuestion()` runs rules sequentially, combines `all`/`any`, and
    turns validator exceptions into failed rules. `RuleResult.score` (0..1)
    is there for future partial credit; `detail` is instructor-only.
  - Probes (`inspect.ts`): `stat -c … -- path` as root (does not follow a
    final symlink, so a symlink can't impersonate a file/dir), `head -c` for
    contents (root, so student permissions don't matter), paths checked by
    `assertSafePath`.
  - `current_directory`: the terminal shell is the newest `bash` with PPID 0
    (only `docker exec` can create those) that owns a TTY; we read the cwd of
    the TTY's foreground process group (handles nested shells, `less`, and
    ignores background jobs). Runs as `student`, because reading another
    user's `/proc/<pid>/cwd` would need CAP_SYS_PTRACE.
  - `POST /api/exam/questions/:id/submit` (Origin + session checked, one
    grading run per session at a time). Results are not stored yet (Phase 7).
  - Verified by `npm run smoke:grading` (18 scenarios incl. symlink, wrong
    case, background `cd`, nested bash, chmod 000).
- **Phase 7** — Scoring and persistence.
  - SQLite via Node's built-in `node:sqlite` (no native add-on to install).
    `modules/db/`: numbered migrations, async repository interfaces
    (`repositories.ts`) with a SQLite implementation — PostgreSQL = a new
    implementation of the same interfaces. File: `data/linuxlab.sqlite`.
  - Tables: `exam_attempts`, `attempt_questions` (per-student variables for
    future randomization), `sessions` (token hash, container), `submissions`
    (every submit; score 0..1 + points for partial credit; full rule results
    incl. instructor detail as JSON).
  - `AttemptService` holds the scoring rules: a question's points = its best
    submission (later tasks can undo earlier state, e.g. leaving /etc);
    server-side deadline (lazy check on every access + 30 s sweep);
    attempt limits, lock-after-submit, hidden feedback/score per exam settings.
  - Sessions are in the database: after a server restart students reconnect
    to the same attempt and container. If a container is gone (idle timeout),
    a new one is created and the student is told files were reset; points stay.
  - Finish / time-out completes the attempt and removes its containers; the
    browser then only ever gets the results page for that attempt.
  - Endpoints: `GET /api/attempt`, `PUT /api/attempt/current-question`,
    `POST /api/attempt/finish`, `GET /api/attempt/result`.
  - Containers carry a `linuxlab.instance` label (hash of the database path
    by default, or `LINUXLAB_INSTANCE`). Each backend only lists and reaps its
    own containers, so several backends can share one Docker host.
  - `SAMPLE_EXAM_MODE=exam` runs the sample exam with exam-mode settings.
  - Verified by `npm run smoke:scoring` (practice mode incl. time-out when
    given the DB path; exam mode on a server started with SAMPLE_EXAM_MODE=exam).
- **Phase 8** — Command logging (requirements §14).
  - Hook in the image (`docker/student-ubuntu/command-hook.sh`, sourced from
    `/etc/bash.bashrc`, so nested shells are covered). `PS0` reports each
    command *before* it runs (history number, cwd, command, base64) and
    `PROMPT_COMMAND` reports its exit status, as OSC 7337 sequences on the
    terminal output. Both hooks are `readonly`, so `unset`/redefining them
    fails — and the attempt is itself logged first. Ubuntu's
    `HISTCONTROL=ignoreboth` is removed so repeats are logged.
  - Server: `CommandMarkerParser` (per shell) strips markers from the
    output before the replay buffer and the browser, handles markers split
    across chunks, pairs command + exit status, de-duplicates by history
    number, and flushes a still-running command when the shell ends.
  - `CommandLogService` stores to `command_log` (migration 2) in arrival
    order with the attempt's current question and server timestamps, and
    flags commands that touch the logging machinery (`logging-tamper`).
  - Only command lines are logged, never program input, so text typed at
    password prompts is never stored.
  - Still advisory evidence: a student could start a shell that skips the
    system bashrc (`bash --norc`), but that command is logged and flagged.
  - `npm run commands:show` prints logs until the instructor page (Phase 9).
    Verified by `npm run smoke:commands` (parser unit checks + end to end).
- **Phase 9** — Instructor results pages (`/instructor`).
  - Interim auth (`modules/instructor/instructorAuth.ts`): one shared
    `INSTRUCTOR_PASSWORD` (≥10 chars, no default; unset = disabled), read from
    the environment or a git-ignored `.env`. Constant-time comparison,
    5 failures per client address → 15 min lockout, random session token in
    an httpOnly SameSite=Strict cookie (hash kept in memory, 8 h), audit log
    lines for every login. Student session cookies never grant access
    (`http/requireInstructor.ts`). To be replaced by instructor accounts.
  - `InstructorService`: attempts list (score, status, counts, flagged
    commands) and attempt detail (per question: validators, every
    submission with instructor-only `detail`, commands while it was open,
    time spent) — `GET /api/instructor/attempts[/:id]`.
  - Time spent: `question_visits` (migration 3) records each time a
    question becomes the open one.
  - Final filesystem state: `SnapshotService` runs just before a finished
    or timed-out exam's container is removed (`beforeExamEnvironmentRemoved`
    hook): listing of `/tmp` and `/home/student` (type, mode, owner, size,
    symlink target) + contents of up to 50 small files, stored in
    `fs_snapshots`. Snapshot failure never blocks ending the exam.
  - UI: `main.tsx` routes `/instructor*` to `InstructorApp` (so no student
    session/container is created). Student-controlled text is rendered as
    React text with control characters made visible (`printable`).
  - Verified by `npm run smoke:instructor` (access control, lockout,
    grader detail, commands, time, snapshot).
- **Phase 10** — Security review; see [SECURITY.md](SECURITY.md).
  - All student-writable paths are size-limited tmpfs (home populated from
    `/etc/skel` at container start); scripts may run from student areas.
  - Rate limits (`http/rateLimit.ts`): new sessions per address, submits and
    writes per session; command-log token bucket with `log-flood` flag.
  - Security headers on every API response; no framing of pages; production
    CSP in `vite.config.ts`; 16 KB JSON limit with clean 413/400 errors;
    `Secure` cookies automatic over HTTPS; student text JSON-quoted in logs.
  - Verified by `npm run smoke:security` (21 attack checks) + all earlier suites.
