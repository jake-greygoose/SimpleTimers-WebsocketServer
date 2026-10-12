# EotM Control

Server and web dashboard for the [eotm-assist](https://github.com/jake-greygoose/eotm-assist)
Guild Wars 2 addon. Game clients connect over WebSocket; the dashboard shows
every client, the EotM instances they are on (with map age), squads, and sends
commands.

## Run

```
npm install
npm start
```

`PORT` defaults to 8080 (Render sets it).

## URLs

| What | Where |
|---|---|
| Dashboard | `https://<host>/` (also `/eotm/`) |
| Health check | `/health` |
| Addon WebSocket URL | `wss://<host>/` - any path works, e.g. `/eotm/ws` |
| Dashboard WebSocket | `/dashboard`, `/admin` or `/eotm/admin` (the page picks it) |

## Environment

| Variable | Meaning |
|---|---|
| `EOTM_TOKEN` | Shared secret. When set, the addon must send it ("Server token" in its options) and the dashboard asks for it. Unset = open to anyone who can reach the server. |
| `EOTM_FRESH_MINUTES` | An instance younger than this counts as fresh (default 10). |
| `EOTM_INSTANCE_FORGET_MINUTES` | How long an instance with none of our clients stays listed (default 180). |
| `EOTM_CLOSE_COMMAND_INTERVAL_MS` | Closes are sent one per machine this far apart (default 350). |
| `EOTM_FOCUS_INTERVAL_MS` | "Focus window" is sent one per machine this far apart (default 1000). |

The protocol is described in eotm-assist's `WEBSOCKET_SPEC.md`.
`PORTING_NOTES.md` lists features of the previous dashboard still to bring over.
