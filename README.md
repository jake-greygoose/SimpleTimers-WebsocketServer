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

## Client defaults

"Client defaults" in the dashboard's top bar sets the FPS cap, view distance,
memory limit, pacer patch and auto-accept that every client is given when it
connects or reconnects (only what differs is sent). Empty fields are left to
each client. Saved to the defaults file below; attach a Render disk at `/data`
to keep them across deploys.

## Squad subgroups

The squad tools can create a squad, move clients to a subgroup, and "Group by
EotM map": one subgroup per EotM instance for the targeted clients already in
the same squad (planned in `map_subgroups.js`; clients check the instance and
squad id before moving).

## Environment

| Variable | Meaning |
|---|---|
| `EOTM_TOKEN` | Shared secret. When set, the addon must send it ("Server token" in its options) and the dashboard asks for it. Unset = open to anyone who can reach the server. |
| `EOTM_FRESH_MINUTES` | An instance younger than this counts as fresh (default 10). |
| `EOTM_INSTANCE_FORGET_MINUTES` | How long an instance with none of our clients stays listed (default 180). |
| `EOTM_CLOSE_COMMAND_INTERVAL_MS` | Closes are sent one per machine this far apart (default 350). |
| `EOTM_FOCUS_INTERVAL_MS` | "Focus window" is sent one per machine this far apart (default 1000). |
| `EOTM_DEFAULTS_FILE` | Where client defaults are saved (default `/data/eotm-defaults.json` when a `/data` disk exists, else next to `server.js`). |

The protocol is described in eotm-assist's `WEBSOCKET_SPEC.md`.
`PORTING_NOTES.md` lists features of the previous dashboard still to bring over.
