# Security Review — Linux Practical Exam Platform

Phase 10 review of the MVP (Phases 1–9), 2026-09-28. The platform gives
students a real shell by design, so the review assumes students **will**
try to break out, cheat the grader, and disrupt other students.

## 1. Summary

- **Containment is solid for a classroom MVP.** In 13 escape and abuse
  attempts from inside a student container, every one was blocked or
  confined to that student's own environment. Checks cover privilege
  escalation, namespaces, mounts, kernel settings, the network, disk,
  memory, and fork bombs.
- **Nine issues were found and fixed** in this phase, two of them high
  severity: one student could fill the server's disk, and nothing limited
  how many containers could be created.
- **The largest remaining risks are deployment decisions, not code bugs.**
  There is no student login yet. The Docker runtime shares the host kernel,
  and the backend effectively has root on its host. These must be
  addressed before real exams (§5, §6).

Verification: `npm run smoke:security` (21 checks) plus the earlier suites
(93 checks) all pass after the fixes.

## 2. Threat model

| Actor | Can do | Wants to |
|---|---|---|
| Student (primary threat) | Any command as uid 1000 in their container; any HTTP/WebSocket request with their own cookie | Get root, escape to the host, see or alter others' work, get points without doing the task, fake the command log, slow down or crash the exam for others |
| Another website | Make a student's browser send requests | Hijack a student's terminal or act as the instructor (CSRF / cross-site WebSocket) |
| Anyone who can reach the server | Unauthenticated HTTP requests | Exhaust containers or disk, guess the instructor password, read student data |

Out of scope: proctoring (a student looking things up in another window),
and attackers who already have access to the host.

## 3. Findings fixed in this phase

| # | Finding | Severity | Fix |
|---|---|---|---|
| F1 | `/home/student`, `/var/tmp` and `/run/lock` were written to the host-backed disk with no size limit. The 50 MB per-file limit did not stop *many* files, so one student could fill the server's disk and break the exam for everyone. | **High** | Every student-writable folder is now a size-limited tmpfs (home 64 MB, `/tmp` 64 MB, `/var/tmp` 16 MB, `/run/lock` 1 MB, `/dev/shm` 16 MB). These count against the container's 256 MB memory limit. Tested: writing stops at 64 MB, and no student-writable folder is on the host disk. |
| F2 | Nothing limited `POST /api/session`. Each call creates a container, so a script could consume the whole container capacity (50). | **High** | At most `NEW_SESSIONS_PER_IP` (default 60) new sessions per address per 10 minutes. Resuming a session never counts. Tested. See R1 for the school-network (NAT) trade-off. |
| F3 | A student can print fake command-log markers. A loop of thousands per second would flood the database. | Medium | Each session's log is rate-limited (burst of 40, then 5 per second, 5000 per attempt). Dropped reports become a single entry flagged `log-flood`. Tested: about 3000 forged reports were stored as 42 rows. |
| F4 | Unlimited Submit clicks and other write requests. Each Submit runs commands in the container. | Medium | Limits per session: Submit 20 per minute, other writes 120 per minute (on top of the existing one-grading-at-a-time lock). Tested. |
| F5 | No security headers. Pages could be framed by another site (clickjacking), and API responses could be cached. | Medium | API responses: `nosniff`, `X-Frame-Options: DENY`, `CSP default-src 'none'`, `Cache-Control: no-store`, `Referrer-Policy`, `CORP`. Pages: no framing (dev server); a full production CSP is in `vite.config.ts` (`preview`). |
| F6 | Oversized or malformed JSON bodies produced HTTP 500s. | Low | Body limit lowered to 16 KB. These now return clean 413 and 400 errors with no internal details. Tested. |
| F7 | Grading log lines included student-controlled text (file contents, paths), so a student could forge server log lines or inject terminal escape codes. | Low | That text is now JSON-quoted in logs. |
| F8 | Session cookies weren't marked `Secure` when served over HTTPS unless configured manually. | Medium (prod) | `Secure` is automatic when `WEB_URL` is `https://`. |
| F9 | Functional: `/tmp` was mounted `noexec`, so students couldn't run their own scripts (`chmod 755 s.sh; ./s.sh`). | — | Student areas now allow running programs. This adds no privilege: the student could already run programs in their home folder. |

### Fixed in earlier phases (found during development)

- **Cross-site terminal hijacking:** the WebSocket and every state-changing request check `Origin`, and cookies are `SameSite=Strict` and `HttpOnly`.
- **Test backends deleting each other's containers:** backends sharing one Docker host reaped each other's student containers. Containers are now labelled per instance.
- **Command logger silently disabled:** `unset PROMPT_COMMAND` switched logging off. The hooks are now read-only, and each command is reported before it runs.
- **Symlink tricks against the grader:** a symlink named like the expected directory passed as a directory. The validators now use `lstat` semantics.
- **Unsafe command construction:** grading runs as root with fixed argv arrays and never builds shell strings from input.

## 4. Verified defenses

Tested by `npm run smoke:security`:

- **Privilege:** no `unshare`, `mount`, `/proc/sys` writes, `su`, root-only files, or writes to the logging hook. The student has zero capabilities, `no-new-privileges` is set, and there are no setuid binaries.
- **Network:** nothing reachable, neither the internet nor the cloud metadata address.
- **Resources:**
  - Memory: a runaway program is killed, and the container survives.
  - Fork bomb: another student's container is unaffected.
  - Output floods (`yes`): the terminal stays responsive.
- **Server:** rate limits hold, security headers are present, and bad input gets clean errors.

Tested elsewhere:

- **Browser security:**
  - HttpOnly and SameSite cookies.
  - Foreign origins are refused.
  - Instructor pages are refused to students.
  - The instructor login locks out after 5 failures.
- **Exam rules:** deadlines, attempt limits and locks are enforced on the server.
- **Answer secrecy:** answers never reach the browser.

## 5. Remaining risks

| # | Risk | Severity | Recommendation |
|---|---|---|---|
| R1 | **No student login.** Anyone who can reach the site can start an exam. Students type their own name and class on the start screen, which is validated but **self-reported**, so a student could enter someone else's name. A finished exam can be retaken in a private window. The session rate limit is per address, and a whole classroom behind one school router shares one address, so the limit must stay above class size. | **High** before real exams | Add student accounts or college single sign-on. Tie attempts to a student, allow one exam attempt per student, and rate-limit per student. |
| R2 | **Shared kernel.** Docker containers share the host's Linux kernel. A kernel vulnerability could allow escape despite all the settings above. | **High** for production | Run students on a dedicated Linux host with **gVisor** (`runsc`), which is the standard for untrusted code. At minimum use user-namespace remapping, keep the host patched, and put nothing else on it. |
| R3 | **The backend controls Docker**, which is root-equivalent on its host. A compromise of the backend is a compromise of the host. | High | Dedicated VM, backend under its own OS account, Docker API never exposed over the network, host firewall. Later: split container control into a small separate service. |
| R4 | **The command log is evidence, not proof.** A student can start a shell that skips the hook (`bash --norc`; logged and flagged) or print forged entries (rate-limited and flagged). | Medium (by design) | Keep grading state-based. Treat logs as supporting evidence. |
| R5 | **A fork bomb breaks the student's own environment.** Other students are unaffected, but no new processes, including the grader, can start in it until it's replaced. | Low–Medium | Add "Reset my environment" (practice mode) and an instructor "replace environment" action. |
| R6 | **The instructor login is one shared password.** No per-instructor identity in the audit log; sessions are in memory. | Medium | Instructor accounts, ideally through the same single sign-on as R1. |
| R7 | Rate limits live in memory in a single process. Behind a reverse proxy every client appears as the proxy's address. | Medium (deployment) | Configure trusted-proxy handling (`X-Forwarded-For`) when deploying behind a proxy. Use a shared store if the backend is ever run as several processes. |
| R8 | **Student data.** The SQLite file holds scores, command history and file snapshots unencrypted. These are education records (FERPA). | Medium | Restrict file permissions, back it up, set a retention period, and don't copy it to personal devices. Check with Alvernia IT on hosting requirements. |
| R9 | The GitHub repository is **public** and contains the sample exam's answers. | Low now | Keep real exams in the database only. Consider making the repository private. |
| R10 | **No HTTPS** in development. | High (prod) | Serve through an HTTPS reverse proxy (for example Caddy or nginx) with `WEB_URL=https://…`. Cookies become `Secure` automatically. |

## 6. Deployment checklist (before real students)

1. **Host:** a dedicated Linux VM, fully patched, running Docker with **gVisor** as the student runtime, with nothing else on it. (R2, R3)
2. **HTTPS:** a reverse proxy that serves the built site (`npm run build`) with the production CSP from `vite.config.ts`, and proxies `/api` and `/ws` to the backend on `127.0.0.1:3001`. Set `WEB_URL` and `ALLOWED_ORIGINS` to the real `https://` address. (R10)
3. **Secrets:** a strong, unique `INSTRUCTOR_PASSWORD` in the host's environment, not in the repository. (R6)
4. **Accounts:** student sign-in (R1). Until then, use only for practice, and take the site down between sessions.
5. **Limits:** set `NEW_SESSIONS_PER_IP` above the largest class that shares a network. Size `maxConcurrent`, memory and CPU for the class (roughly 256 MB and 0.5 CPU per student).
6. **Data:** set permissions on and back up `data/linuxlab.sqlite`, and define retention. (R8)
7. **Image:** rebuild the student image regularly (`npm run image:build`) to pick up Ubuntu security updates.
8. **Monitoring:** watch the server log for `[audit]` lines, `logging-tamper` and `log-flood` flags, and orphaned-container messages.

## 7. Re-running the checks

```bash
npm run smoke:security                             # container attacks (no backend needed)
# full run, against a backend started with NEW_SESSIONS_PER_IP=5 and its own DATABASE_PATH:
npm run smoke:security -- http://127.0.0.1:3001 <path-to-that-database>
```
