# Linux Practical Exam Platform

A web platform where students complete Linux tasks in a real, isolated Bash shell
inside a Docker container, and the platform grades the resulting system state.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/SECURITY.md](docs/SECURITY.md) for the security review and the
checklist to complete before real students use it.

## Requirements

- Node.js 22 or later (developed on Node 24)
- Docker Desktop with WSL 2, running (only on the server / your dev machine;
  students need nothing but a browser)

## Run locally

```bash
npm install
npm run image:build        # once, and again whenever docker/student-ubuntu changes
npm run dev
```

This starts:

| Process | URL | Notes |
|---------|-----|-------|
| Backend (Express) | http://127.0.0.1:3001 | e.g. http://127.0.0.1:3001/api/health |
| Web (Vite + React) | http://127.0.0.1:5173 | open this in the browser |

The web dev server proxies `/api` and `/ws` to the backend, so the browser only
ever talks to port 5173.

Other scripts:

```bash
npm run dev:server   # backend only
npm run dev:web      # frontend only
npm run typecheck    # type-check every package
npm run build        # production build of the web app

npm run smoke:containers              # create a student container, verify isolation, destroy it
npm run smoke:containers -- --keep    # same, but leave it running to explore
npm run containers:cleanup            # remove every container this project created
npm run smoke:terminal                # (backend running) terminal + security checks
npm run smoke:grading                 # validators against a real container
npm run smoke:scoring                 # (backend running) scoring, finish, exam rules
npm run smoke:commands -- <url> <db>  # (backend running) command logging
npm run commands:show                 # command history of the latest attempt (--all for every attempt)
npm run smoke:instructor -- <url> <pw> # (backend running) instructor access + results views
npm run smoke:security                # student attack attempts (see docs/SECURITY.md)
```

Try the stricter exam mode (no hints, hidden results, 2 attempts, 30 minutes)
by starting the backend with `SAMPLE_EXAM_MODE=exam` (PowerShell:
`$env:SAMPLE_EXAM_MODE='exam'; npm run dev`).

Exam data is stored in `data/linuxlab.sqlite` (git-ignored). Delete that file
to start completely fresh.

## Students

Students open http://127.0.0.1:5173, enter their name and class, and click
**Start exam**. To offer a fixed list of classes instead of a text box, add
`CLASS_LIST=CS120-01,CS120-02` (your sections) to `.env`.

## Instructor pages

Open http://127.0.0.1:5173/instructor. Access needs `INSTRUCTOR_PASSWORD`
(at least 10 characters), set in a `.env` file in the project root (copy
`.env.example`) or as an environment variable. Restart the server after
changing it. Without it, the instructor pages are disabled.

## Layout

```text
apps/server      Node + TypeScript backend
apps/web         React + TypeScript frontend
packages/shared  types shared by both
docker/          student container image
docs/            architecture notes
```
