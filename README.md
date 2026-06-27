# idan-engine

Node.js execution engine for the idan assistant. Designed to run on **Termux** (Android)
and communicate with the Android app over local HTTP on port `3788`.

---

## Termux Quick Start

### Prerequisites (on the phone)
- [Termux](https://f-droid.org/en/packages/com.termux/) from **F-Droid** (not Google Play)
- [Termux:API](https://f-droid.org/en/packages/com.termux.api/) companion app — **same source** as Termux

### 1 · One-command install

Open Termux and run:

```bash
curl -fsSL https://raw.githubusercontent.com/tobeski03/idan-engine/main/engine/install-termux.sh | bash
```

Or clone first then run the installer:

```bash
git clone https://github.com/tobeski03/idan-engine ~/idan-engine
bash ~/idan-engine/install-termux.sh
```

The script will:
1. Install `git`, `nodejs-lts`, `curl`, `termux-api` via `pkg`
2. Clone/pull the repo into `~/idan-engine`
3. Write production config silently — no prompts
4. Generate a one-time **pairing token** and display it (enter it in the Android app)
5. Run `npm install`
6. Register the engine with **termux-services** for auto-restart on boot/crash
7. Print a health-check confirmation

The installer is **fully non-interactive** after you run it.

### 2 · Update

```bash
bash ~/idan-engine/update.sh
```

Pulls the latest code, re-runs `npm install`, restarts the service, and health-checks.

### 3 · Logs

```bash
tail -f ~/idan-engine/engine.log
```

### 4 · Health check

```bash
curl http://127.0.0.1:3788/health
```

Expected response:
```json
{ "ok": true, "version": "0.2.0", "state": "running", ... }
```

### 5 · Auto-restart (termux-services)

The installer registers the engine as a **runit service** via `termux-services`.
It restarts automatically on crash (5 s cooldown) and on every Termux launch.

```bash
# Manual service control
sv up   idan-engine   # start
sv down idan-engine   # stop
sv restart idan-engine
```

To disable auto-start:
```bash
sv-disable idan-engine
```

---

## Files

| File | Purpose |
|---|---|
| `server.js` | Main HTTP engine — all routes and logic |
| `install-termux.sh` | One-command Termux installer |
| `update.sh` | Pull + restart from the phone |
| `service/run` | runit run script (symlinked by installer) |
| `service/finish` | runit finish script (crash cooldown) |
| `bootstrap.js` | Legacy helper: writes engine-state.json, runs npm install |
| `bootstrap-termux.sh` | Legacy installer (superseded by install-termux.sh) |
| `skills/*.skill.json` | Pluggable skill declarations for the AI tool router |
| `.env` | Local secrets — **gitignored, never committed** |
| `engine-state.json` | Runtime pairing token — **gitignored** |

---

## Running on PC (development)

```bash
npm start          # or: node server.js
npm run health     # quick health-only boot
```

Requires Node ≥ 18.
