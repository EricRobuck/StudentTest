# Linux Practical Exam Platform

A web platform where students complete Linux tasks in a real, isolated Bash shell
inside a Docker container, and the platform grades the resulting system state.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

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
```

## Layout

```text
apps/server      Node + TypeScript backend
apps/web         React + TypeScript frontend
packages/shared  types shared by both
docker/          student container image
docs/            architecture notes
```
