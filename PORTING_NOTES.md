# Features from the previous EotM dashboard

This repo used to host a collaborative-timers server with an EotM dashboard
added to it. Both were replaced by the eotm-assist server and dashboard
(`server.js`, `public/`). This note lists what the previous dashboard
(`eotm-dashboard.html` and the EotM half of the old `server.js`, last in commit
2e6823f) did, whether the addon supports it, and how to bring it into the new
one.

**Every command the old dashboard sent is supported by the current addon.**
That covers `enter_map`, `reconnect`, `go_to_character_select`, `close_game`,
`close_server`, `close_character`, `set_fps`, `disable_fps_limiter`,
`set_memory_limit`, `minimize`, `bring_to_front`, `request_status`, `sqjoin`
and `sqleave`. The current addon accepts both plain-string and JSON commands. The new
server sends argument-free commands as plain strings exactly as the old one did
(`enter_map`, `bring_to_front`, `minimize`, `close_game`, `reconnect`,
`disable_fps_limiter`), so older addon builds keep working. It also asks
unnamed clients for `request_status` and ignores the `Unknown` / `0.0.0.0`
placeholders, as before.

Nothing below needs addon changes. All of it is server or dashboard work.

## Already covered by the new dashboard

| Old feature | New equivalent |
|---|---|
| Instances / machines / outside lists | Instances panel (with map age, fresh/old), client table grouped by instance or machine |
| Scoped bulk actions (all / instance / machine) | "Send to" target: all, selected, a machine or an instance |
| Per-client focus, minimize, close, enter map | Row actions + selection |
| Close excess per instance / keep N per machine | Close menu |
| Set FPS / disable limiter | FPS field, Uncap |
| sqjoin / sqleave (modal, bulk) | Squads panel: name box + Join squad / Leave squad, "Target joins" per squad |
| Reconnect outside / reconnect machine | Reconnect button on any target |
| Health endpoint | `/eotm/health` |

## Not ported yet, and how

### 1. Launch Sequence (Steps + Flood) - the big one

What it did, all in the browser:
- A queue of clients outside EotM, fresh ones first. Clients it had sent to
  character select re-enter with `reconnect` instead of `enter_map`.
- **Steps** (default 7, 17, fill, 7, fill): send `enter_map` to one client
  every *send interval* (500 ms) until the step's count is reached ("fill" =
  instance capacity minus clients already on the map).
- After each step, wait *check delay* (5 s). If a new instance IP appeared,
  pause and wait for "Resume".
- **Flood**: keep sending from the queue every interval, no steps.
- **Rotation**: whenever an instance holds more than *capacity* (30) clients,
  schedule `go_to_character_select` for the client that has been there
  longest, after an *overlap window* (8 s).

How to integrate:
- **Move it to the server** (`eotm/launch.js`), not the page. A
  browser-driven sequence stops when the tab sleeps or closes, and two open
  dashboards would both drive it. The server already knows each client's
  instance and when it arrived.
- Dashboard messages: `{type:'launch', action:'start'|'flood'|'pause'|'resume'|'stop', settings, steps}`.
  The server pushes `launch` state in the snapshot (mode, step i/n, sent, paused reason).
- **Better signals than the old one had.**
  - *New instance* = a new IP in `knownInstances`, which now also has its age.
    The pause can say "new instance 18.195.142.78, 1 min old - fresh".
  - Clients report `map_age`, so a step can wait until the new instance is
    confirmed fresh before continuing.
  - Map age gives an extra rule: only flood while the instance is fresh,
    under `FRESH_MINUTES`.
- **UI:** a "Launch" panel beside Instances, with interval / check delay /
  overlap / capacity fields, an editable step list, Start / Flood / Pause /
  Resume / Stop, and a status badge. That's the same controls as before, in
  the new style.

### 2. Character-select rotation for full instances
Part of the launch sequence above. It is also useful on its own as an
"auto-rotate" toggle: keep each instance at or under N clients by sending the
longest-present ones to character select. The server needs `arrived_at` per
client (set in `setInstance`), which it doesn't keep yet.

### 3. "Char Select Rest" per instance (keep N) - DONE
For one instance: keep N clients and send the rest to character select (the
old version kept the longest-present). New: add a "Character select" item to
the instance card, taking a keep count, built like `close_excess` but sending
`go_to_character_select`. The `COMMANDS` entry already exists; it needs a
dashboard button and a `keep` variant.

### 4. Throttled closing (350 ms per machine) - DONE
The old server spaced `close_game` commands 350 ms apart per machine
(`EOTM_CLOSE_COMMAND_INTERVAL_MS`), so closing dozens of clients on one PC
does not stall it. The new server sends closes all at once.
Port: a per-machine queue in `runCommand` / `closeExcess` for close commands.
About 30 lines; worth doing before closing many clients at once.

### 5. Staggered focus (1 s per machine) - DONE
`bring_to_front` to many clients on one machine was queued 1 s apart, so the
windows don't fight over the foreground. Same queue as above with a 1 s
interval for `bring_to_front`.

### 6. Enter-map / reconnect status in the table
The old dashboard showed each client's `enter_map_status` (started / complete
/ failed + reason) and `reconnect_status`. The new one shows these only as
feed events. Port: keep the last status per client in `ACKS` handling and
show it as a chip in the "Where" column (e.g. "Entering…", "Failed: timeout").

### 7. Character select per client - DONE
A row action for `go_to_character_select`. Trivial: add to the row actions /
command bar; the server already accepts it.

### 8. Memory limit - DONE
`set_memory_limit` is supported by the server's `COMMANDS` but has no
dashboard control. Add an "MB" field next to FPS in the command bar.

## Suggested order

1. ~~Throttled close + staggered focus (4, 5)~~ - done: `sendPaced` in server.js.
2. ~~Character select per client and per instance (7, 3); memory limit (8)~~ - done.
3. Enter-map status chips (6).
4. Launch Sequence on the server with fresh-instance awareness (1, 2).
