// EotM Control: the server the eotm-assist addon connects to, and its web
// dashboard.
//
//   /  or /eotm/          dashboard (public/)
//   /health, /eotm/health JSON health check
//   WebSocket /dashboard, /admin, /eotm/admin   dashboard
//   WebSocket on any other path                 game client (the addon)
//
// Game clients are accepted on any path so that every addon URL in use keeps
// working: wss://host/, wss://host/eotm/ws, ...
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { planMapSubgroups } = require('./map_subgroups');
const { validIp, statusLocation, validMapAge, acceptMapAge } = require('./location_state');
let mapSubgroupAssignments = new Map();

const PORT = process.env.PORT || 8080;

// Shared secret. When set, game clients must send it as
// "Authorization: Bearer <token>" (the addon's "Server token" setting) and the
// dashboard must send {"type":"auth","token":...} as its first message.
// Unset means no check at all - only acceptable on a private network.
const TOKEN = process.env.EOTM_TOKEN || '';

// The dashboard used to live under /eotm on a shared server; both forms work.
const LEGACY_PREFIX = '/eotm';
const DASHBOARD_SOCKET_PATHS = new Set(['/dashboard', '/admin', '/eotm/admin']);

// A dashboard that has not authenticated within this long is disconnected.
const DASHBOARD_AUTH_TIMEOUT_MS = 10000;

// Protocol-level ping. ixwebsocket answers these automatically, so a client
// that misses one full interval is dead (crashed game, dropped network) and is
// dropped instead of lingering in its instance list forever.
const HEARTBEAT_MS = 30000;

// Dashboards get a fresh snapshot at most this often, however busy the clients.
const SNAPSHOT_THROTTLE_MS = 250;

// Recent events kept for dashboards that connect later.
const EVENT_LIMIT = 200;

// An EotM map instance younger than this is "fresh" on the dashboard.
// Matches the addon's default "Fresh map if younger than" setting.
const FRESH_MINUTES = Number(process.env.EOTM_FRESH_MINUTES) || 10;

// Instances none of our clients are on any more are remembered this long, so
// the dashboard still lists where they were and how old they are.
const INSTANCE_FORGET_MS = (Number(process.env.EOTM_INSTANCE_FORGET_MINUTES) || 180) * 60 * 1000;

// Map age is exact to the server tick, so two readings of one instance agree
// on its opening time to within a few seconds. A bigger gap means the IP now
// hosts a different instance.
const SAME_INSTANCE_TOLERANCE_MS = 2 * 60 * 1000;

// Client defaults (FPS cap, view distance, ...) survive restarts in this file.
// /data is the persistent disk on Render when one is attached; otherwise the
// file sits next to the server and lasts until the next deploy.
const DEFAULTS_FILE = process.env.EOTM_DEFAULTS_FILE ||
  path.join(fs.existsSync('/data') ? '/data' : __dirname, 'eotm-defaults.json');

// Constant-time comparison, so response timing does not leak the token a
// character at a time. Hashing first makes the lengths equal.
function tokenMatches(candidate) {
  if (!TOKEN) return true;
  if (typeof candidate !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

// Game clients and dashboards on separate paths; the upgrade handler below
// routes between them. Dashboards are never counted as clients and never
// receive game commands.
const clientWss = new WebSocket.Server({ noServer: true });
const dashboardWss = new WebSocket.Server({ noServer: true });

// ------------------------------------------------------------------ state

// Every connected game client: Map<WebSocket, ClientState>.
const clients = new Map();
const clientsById = new Map();   // id -> WebSocket
let nextClientId = 0;

// Indexes over `clients`. Sets, so a client can never be listed twice.
const instances = new Map(); // server_ip -> Set<WebSocket>
const machines = new Map();  // machine   -> Set<WebSocket>

// Every EotM instance we have seen, keyed by server IP (one IP = one map
// instance): { ip, opened_at, first_seen, last_seen }. opened_at is server
// time worked out from a client's map age reading; null until one arrives.
const knownInstances = new Map();

// EotM reset times (server ms): the next one clients report, and the most
// recent one that has passed. Instances last seen before a passed reset are gone.
let nextEotmResetAt = null;
let lastEotmResetAt = null;

const dashboards = new Set();

const events = [];
let nextEventId = 0;

function now() {
  return new Date().toISOString();
}

function addToIndex(index, key, ws) {
  if (!key) return;
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(ws);
}

function removeFromIndex(index, key, ws) {
  if (!key) return;
  const set = index.get(key);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) index.delete(key);
}

function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return true;
}

function label(client) {
  return `${client.character || 'unknown'} (${client.machine || 'unknown machine'})`;
}

function authedDashboards() {
  return [...dashboards].filter(d => d.authed);
}

// ------------------------------------------------------------------ dashboard feed

// Logs to the console and to every dashboard's event feed.
// level: info | good | warn | bad
function logEvent(level, text, client) {
  const event = { id: ++nextEventId, t: Date.now(), level, text, client: client ? client.id : null };
  events.push(event);
  if (events.length > EVENT_LIMIT) events.shift();
  console.log(`[${now()}] ${text}`);
  for (const d of authedDashboards()) send(d, { type: 'event', event });
}

// What a dashboard may see of a client.
function publicClient(c) {
  return {
    id: c.id,
    character: c.character,
    account: c.account,
    machine: c.machine,
    server_ip: c.server_ip,
    loading_server_ip: c.loading_server_ip || null,
    loading_map_id: c.loading_map_id || null,
    map: c.map,
    game_state: c.game_state,
    map_age_s: c.map_age_s,
    map_fresh: c.map_fresh,
    map_age_at: c.map_age_at,
    eotm_reset_at: c.eotm_reset_at,
    eotm_reset_estimated: c.eotm_reset_estimated,
    pacer_patch: c.pacer_patch,
    view_distance: c.view_distance,
    travel_available: c.travel_available,
    fps_target: c.fps_target,
    connected_at: c.connected_at,
    last_update: c.last_update,
    group_type: c.group ? c.group.type : 'none',
    group_source: c.group_source || null,
    auto_accept: c.auto_accept || null,
    pending_invites: c.pending_invites || [],
    squad_actions_available: c.squad_actions_available === true,
    wvw_team: c.wvw_team || null,
    portal_available: c.portal_available === true
  };
}

// ------------------------------------------------------------------ squads

const GROUP_TYPES = new Set(['none', 'party', 'raid_squad', 'squad']);
const GROUP_MEMBER_LIMIT = 60;

function shortString(value, max = 140) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// The addon's group report, reduced to what we expect - it is client input.
function sanitizeGroup(group) {
  if (!group || typeof group !== 'object' || !GROUP_TYPES.has(group.type)) return null;
  const members = Array.isArray(group.members) ? group.members.slice(0, GROUP_MEMBER_LIMIT) : [];
  return {
    id: shortString(group.id),
    type: group.type,
    count: Number.isInteger(group.count) ? group.count : members.length,
    complete: group.complete !== false,
    members: members
      .filter(m => m && typeof m.account === 'string' && m.account)
      .map(m => ({
        account: shortString(m.account).replace(/^:/, ''),  // GW2 prefixes account names with ':'
        character: shortString(m.character),
        subgroup: Number.isInteger(m.subgroup) ? m.subgroup : 0,
        profession: Number.isInteger(m.profession) ? m.profession : 0,
        self: m.self === true,
        in_instance: m.in_instance === true,
        commander: m.commander === true,
        lieutenant: m.lieutenant === true
      }))
  };
}

// RTAPI account names may carry the client's leading ':'.
function accountKey(name) {
  return (name || '').replace(/^:/, '').toLowerCase();
}

// Every squad/party at least one of our clients is in, merged across the
// clients that report it, with each member placed on an instance where we
// can tell:
//   own  - the member is one of our clients, which reports its own IP
//   seen - one of our clients on that IP sees the member on its instance
//   elsewhere - our clients in the group are in EotM and none sees them
function buildSquads() {
  const reporters = [...clients.values()].filter(c => c.group && c.group.type !== 'none' && c.group.members.length);
  const ourByAccount = new Map();
  for (const c of clients.values()) {
    if (c.account) ourByAccount.set(accountKey(c.account), c);
  }

  // Clients whose rosters share an account are in the same group.
  const groups = [];
  for (const c of reporters) {
    const accounts = new Set(c.group.members.map(m => accountKey(m.account)));
    const overlapping = groups.filter(g => c.group.id && g.id ? c.group.id === g.id : [...accounts].some(a => g.accounts.has(a)));
    const merged = { id: c.group.id, accounts, reporters: [c] };
    for (const g of overlapping) {
      if (!merged.id) merged.id = g.id;
      g.accounts.forEach(a => merged.accounts.add(a));
      merged.reporters.push(...g.reporters);
      groups.splice(groups.indexOf(g), 1);
    }
    groups.push(merged);
  }

  return groups.map(g => {
    const members = new Map();
    for (const r of g.reporters) {
      for (const m of r.group.members) {
        const key = accountKey(m.account);
        const entry = members.get(key) || { ...m, seenOn: new Set(), notSeenOn: new Set() };
        // The member's own report wins for its own fields.
        if (m.self || !members.has(key)) Object.assign(entry, m);
        if (r.server_ip) (m.in_instance || m.self ? entry.seenOn : entry.notSeenOn).add(r.server_ip);
        members.set(key, entry);
      }
    }

    const list = [...members.entries()].map(([key, m]) => {
      const ours = ourByAccount.get(key);
      let instance = null;
      let source = 'unknown';
      if (ours && ours.server_ip) {
        instance = ours.server_ip;
        source = 'own';
      }
      else if (ours && !ours.server_ip) {
        source = 'not_in_eotm';
      }
      else if (m.seenOn.size) {
        instance = [...m.seenOn][0];
        source = 'seen';
      }
      else if (m.notSeenOn.size) {
        source = 'elsewhere';
      }
      return {
        account: m.account,
        character: m.character,
        subgroup: m.subgroup,
        profession: m.profession,
        commander: m.commander,
        lieutenant: m.lieutenant,
        client: ours ? ours.id : null,
        instance,
        instance_source: source
      };
    });
    list.sort((a, b) => (a.subgroup - b.subgroup)
      || (b.commander - a.commander)
      || (a.character || a.account).localeCompare(b.character || b.account));

    const commander = list.find(m => m.commander) || null;
    const type = g.reporters.some(r => r.group.type === 'squad' || r.group.type === 'raid_squad') ? 'squad' : 'party';
    return {
      id: g.id || accountKey(commander ? commander.account : list.map(m => m.account).sort()[0]),
      type,
      commander: commander ? (commander.character || commander.account) : null,
      commander_account: commander ? commander.account : null,
      count: Math.max(...g.reporters.map(r => r.group.count), list.length),
      complete: g.reporters.every(r => r.group.complete),
      reporters: g.reporters.map(r => r.id),
      members: list
    };
  }).sort((a, b) => b.members.length - a.members.length);
}

// ------------------------------------------------------------------ instances

function touchInstance(ip) {
  if (!ip) return null;
  let inst = knownInstances.get(ip);
  if (!inst) {
    inst = { ip, opened_at: null, first_seen: Date.now(), last_seen: Date.now() };
    knownInstances.set(ip, inst);
  }
  inst.last_seen = Date.now();
  return inst;
}

// A client on its instance read the map's age. The first reading fixes the
// instance's opening time; one that disagrees by minutes means a different
// instance now runs on that IP.
function recordMapAge(client, ageSeconds) {
  if (!validIp(client.server_ip) || !validMapAge(ageSeconds)) return;
  const inst = touchInstance(client.server_ip);
  const openedAt = Date.now() - ageSeconds * 1000;
  const minutes = Math.round(ageSeconds / 60);
  const fresh = ageSeconds < FRESH_MINUTES * 60;
  if (inst.opened_at === null) {
    inst.opened_at = openedAt;
    logEvent(fresh ? 'good' : 'info',
      `Instance ${inst.ip} is ${minutes} min old${fresh ? ' - fresh' : ''}`, client);
  }
  else if (Math.abs(openedAt - inst.opened_at) > SAME_INSTANCE_TOLERANCE_MS) {
    inst.opened_at = openedAt;
    inst.first_seen = Date.now();
    logEvent(fresh ? 'good' : 'info', `${inst.ip} now hosts a different instance, ${minutes} min old`, client);
  }
}

function notePassedReset() {
  if (nextEotmResetAt && nextEotmResetAt <= Date.now()) lastEotmResetAt = nextEotmResetAt;
}

function noteEotmReset(resetAt) {
  if (typeof resetAt !== 'number' || resetAt <= 0) return;
  notePassedReset();
  nextEotmResetAt = resetAt < 1e12 ? resetAt * 1000 : resetAt;  // the addon sends unix seconds
}

function pruneInstances() {
  const t = Date.now();
  notePassedReset();
  for (const [ip, inst] of knownInstances) {
    if (instances.has(ip)) continue;  // still occupied
    const resetSince = lastEotmResetAt && inst.last_seen < lastEotmResetAt;
    if (resetSince || t - inst.last_seen > INSTANCE_FORGET_MS) knownInstances.delete(ip);
  }
}

function publicInstance(inst) {
  const members = [...(instances.get(inst.ip) || [])].map(ws => clients.get(ws)).filter(Boolean);
  return {
    ip: inst.ip,
    opened_at: inst.opened_at,
    first_seen: inst.first_seen,
    last_seen: inst.last_seen,
    clients: members.map(c => c.id),
    machines: [...new Set(members.map(c => c.machine).filter(Boolean))]
  };
}

// ------------------------------------------------------------------ client defaults

// What every client should be set to when it connects. null = not managed:
// the client keeps whatever it has.
//   fps            0 = uncapped, 1-200
//   view_distance  0 = game default, 1-100
//   memory_mb      256-32768
//   pacer_patch    true / false
//   auto_accept    'off' | 'squad' | 'both'
//   wvw_team       team id joined by accounts that have no WvW team
// World restructuring team ids, in the order the game's Matchmaking list shows
// them. Names are for display only; clients send and receive ids.
const WVW_TEAM_NAMES = {
  11001: 'Moogooloo', 11002: "Rall's Rest", 11003: 'Domain of Torment', 11004: 'Yohlon Haven',
  11005: 'Tombs of Drascir', 11006: 'Hall of Judgment', 11007: 'Throne of Balthazar', 11008: "Dwayna's Temple",
  11009: "Abaddon's Prison", 11010: 'Cathedral of Blood', 11011: 'Lutgardis Conservatory', 11012: 'Mosswood',
  12001: 'Skrittsburgh', 12002: "Fortune's Vale", 12003: 'Silent Woods', 12004: "Ettin's Back",
  12005: 'Domain of Anguish', 12006: 'Palawadan', 12007: 'Bloodstone Gulch', 12008: 'Frost Citadel',
  12009: 'Dragrimmar', 12010: "Grenth's Door", 12011: 'Mirror of Lyssa', 12012: "Melandru's Dome",
  12013: "Kormir's Library", 12014: 'Great House Aviary', 12015: 'Bava Nisos'
};

function teamName(id) {
  return WVW_TEAM_NAMES[id] || `team ${id}`;
}

const EMPTY_DEFAULTS = { fps: null, view_distance: null, memory_mb: null, pacer_patch: null, auto_accept: null, wvw_team: null };
let clientDefaults = { ...EMPTY_DEFAULTS };

function sanitizeDefaults(input) {
  if (!input || typeof input !== 'object') return null;
  const out = { ...EMPTY_DEFAULTS };
  const num = (v, lo, hi) => (v === null || v === undefined || v === '' ? null : intInRange(v, lo, hi, undefined));
  out.fps = num(input.fps, 0, 200);
  out.view_distance = num(input.view_distance, 0, 100);
  out.memory_mb = num(input.memory_mb, 256, 32768);
  out.wvw_team = num(input.wvw_team, 1, 99999);
  if (out.fps === undefined || out.view_distance === undefined || out.memory_mb === undefined ||
    out.wvw_team === undefined) return null;
  if (input.pacer_patch !== null && input.pacer_patch !== undefined) {
    if (typeof input.pacer_patch !== 'boolean') return null;
    out.pacer_patch = input.pacer_patch;
  }
  if (input.auto_accept !== null && input.auto_accept !== undefined) {
    if (!['off', 'squad', 'both'].includes(input.auto_accept)) return null;
    out.auto_accept = input.auto_accept;
  }
  return out;
}

function loadDefaults() {
  try {
    const parsed = sanitizeDefaults(JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8')));
    if (parsed) clientDefaults = parsed;
  }
  catch (err) {
    if (err.code !== 'ENOENT') console.error(`[${now()}] Could not read ${DEFAULTS_FILE}:`, err.message);
  }
}

function saveDefaults() {
  fs.writeFile(DEFAULTS_FILE, JSON.stringify(clientDefaults, null, 2), (err) => {
    if (err) console.error(`[${now()}] Could not save ${DEFAULTS_FILE}:`, err.message);
  });
}

function describeDefaults(d) {
  const parts = [];
  if (d.fps !== null) parts.push(d.fps ? `${d.fps} fps` : 'uncapped');
  if (d.view_distance !== null) parts.push(d.view_distance ? `view ${d.view_distance}%` : 'view default');
  if (d.memory_mb !== null) parts.push(`RAM ${d.memory_mb} MB`);
  if (d.pacer_patch !== null) parts.push(`pacer ${d.pacer_patch ? 'on' : 'off'}`);
  if (d.auto_accept !== null) parts.push(`auto-accept ${d.auto_accept === 'both' ? 'squad + party' : d.auto_accept}`);
  if (d.wvw_team !== null) parts.push(`WvW team ${teamName(d.wvw_team)} when missing`);
  return parts.join(', ') || 'nothing managed';
}

// The commands that bring one client to the defaults, skipping what it already
// reports. Memory is not reported back, so it is always sent.
function defaultCommands(client) {
  const d = clientDefaults;
  const out = [];
  if (d.fps !== null) {
    if (d.fps === 0 && client.fps_target) out.push('disable_fps_limiter');
    else if (d.fps > 0 && client.fps_target !== d.fps) out.push({ type: 'set_fps', fps: d.fps });
  }
  if (d.view_distance !== null && client.view_distance !== d.view_distance) {
    out.push({ type: 'set_view_distance', percent: d.view_distance });
  }
  if (d.memory_mb !== null) out.push({ type: 'set_memory_limit', mb: d.memory_mb });
  if (d.pacer_patch !== null && client.pacer_patch !== d.pacer_patch) {
    out.push({ type: 'set_pacer_patch', enabled: d.pacer_patch });
  }
  if (d.auto_accept !== null) {
    const a = client.auto_accept || {};
    const current = a.squad && a.party ? 'both' : a.squad ? 'squad' : 'off';
    if (current !== d.auto_accept) {
      out.push({ type: 'set_auto_accept', squad: d.auto_accept !== 'off', party: d.auto_accept === 'both' });
    }
  }
  if (d.wvw_team !== null && needsTeam(client) && !client.team_join_sent) {
    out.push({ type: 'set_wvw_team', team: d.wvw_team });
  }
  return out;
}

// Known to have no team, and able to join one. The client also refuses to
// switch a team it already has.
function needsTeam(client) {
  const t = client.wvw_team;
  return !!(t && t.available && t.known && t.team === null);
}

// The default team is joined once per connection, as soon as the client has
// read its team - which can be after hello.
function joinDefaultTeam(ws, client) {
  if (clientDefaults.wvw_team === null || client.team_join_sent || !needsTeam(client)) return;
  client.team_join_sent = true;
  send(ws, { type: 'set_wvw_team', team: clientDefaults.wvw_team });
  logEvent('info', `${label(client)} has no WvW team - joining ${teamName(clientDefaults.wvw_team)}`, client);
}

function applyDefaults(ws, client) {
  const commands = defaultCommands(client);
  for (const command of commands) {
    if (command.type === 'set_wvw_team') client.team_join_sent = true;
    send(ws, command);
  }
  return commands.length;
}

function setDefaults(input, applyNow) {
  const parsed = sanitizeDefaults(input);
  if (!parsed) {
    logEvent('warn', 'Dashboard sent invalid client defaults');
    return;
  }
  clientDefaults = parsed;
  saveDefaults();
  let touched = 0;
  if (applyNow) {
    for (const [ws, client] of clients) if (applyDefaults(ws, client)) touched++;
  }
  logEvent('info', `Client defaults: ${describeDefaults(clientDefaults)}` +
    (applyNow ? ` - applied to ${touched} client(s)` : ' - for clients as they connect'));
  scheduleSnapshot();
}

function buildSnapshot() {
  pruneInstances();
  return {
    type: 'snapshot',
    server_time: Date.now(),
    fresh_minutes: FRESH_MINUTES,
    eotm_reset_at: nextEotmResetAt,
    defaults: clientDefaults,
    wvw_team_names: WVW_TEAM_NAMES,
    clients: [...clients.values()].map(publicClient),
    instances: [...knownInstances.values()].map(publicInstance),
    squads: buildSquads()
  };
}

let snapshotTimer = null;
function scheduleSnapshot() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    const targets = authedDashboards();
    if (targets.length === 0) return;
    const snapshot = JSON.stringify(buildSnapshot());
    for (const d of targets) send(d, snapshot);
  }, SNAPSHOT_THROTTLE_MS);
}

// ------------------------------------------------------------------ client state updates

// Applies identity fields a client sent, keeping what we already know for any
// it left out (the addon omits fields it cannot read, e.g. no RTAPI).
// Older addon builds send placeholders for what they cannot read.
const PLACEHOLDERS = new Set(['Unknown', 'Unknown IP', '0.0.0.0']);

function realValue(value) {
  return typeof value === 'string' && value.trim() && !PLACEHOLDERS.has(value) ? value : null;
}

function updateIdentity(ws, client, data) {
  const character = realValue(data.character);
  const account = realValue(data.account);
  const machine = realValue(data.machine);
  if (character) client.character = character;
  if (account) client.account = account;
  if (machine && machine !== client.machine) {
    removeFromIndex(machines, client.machine, ws);
    client.machine = machine;
    addToIndex(machines, client.machine, ws);
  }
  client.last_update = Date.now();
}

// Older addon builds never say hello: ask clients we cannot name yet, at most
// every 30 seconds, as the previous server did.
const STATUS_REQUEST_COOLDOWN_MS = 30000;

function requestStatusIfUnknown(ws, client) {
  if (client.character && client.machine) return;
  const t = Date.now();
  if (t - (client.last_status_request || 0) < STATUS_REQUEST_COOLDOWN_MS) return;
  client.last_status_request = t;
  send(ws, { type: 'request_status' });
}

function setInstance(ws, client, serverIp) {
  if (client.server_ip === serverIp) return;
  touchInstance(client.server_ip);  // the one being left was last seen now
  removeFromIndex(instances, client.server_ip, ws);
  client.server_ip = serverIp || null;
  client.map_age_s = client.map_fresh = client.map_age_at = null;
  addToIndex(instances, client.server_ip, ws);
  touchInstance(client.server_ip);
}

// Fields copied as-is from hello/status when present.
const STATUS_FIELDS = ['map', 'game_state', 'travel_available', 'view_distance',
  'pacer_patch', 'fps_target', 'eotm_reset_at', 'eotm_reset_estimated'];

function applyStatus(ws, client, data) {
  updateIdentity(ws, client, data);
  for (const field of STATUS_FIELDS) {
    if (data[field] !== undefined) client[field] = data[field];
  }
  // A client already in EotM when it (re)connects - after a server restart,
  // say - names its instance here; one that is not in EotM is on no instance.
  if (data.in_eotm === undefined) {
    // Builds without in_eotm only report an IP while in EotM.
    const statusIp = realValue(data.server_ip);
    if (statusIp && validIp(statusIp)) setInstance(ws, client, statusIp);
    if (data.map_age_s != null && validIp(client.server_ip) && validMapAge(data.map_age_s)) {
      client.map_age_s = data.map_age_s;
      client.map_fresh = data.map_fresh;
      client.map_age_at = Date.now();
      recordMapAge(client, data.map_age_s);
    }
  }
  else {
    // Full snapshots must agree on gameplay, map identity and address.
    // A loading destination never counts as an occupied instance.
    const location = statusLocation(data);
    client.loading_server_ip = location.loadingIp;
    client.loading_map_id = location.loadingMapId;
    setInstance(ws, client, location.activeIp);
    if (acceptMapAge(client, data)) {
      client.map_age_s = data.map_age_s;
      client.map_fresh = data.map_fresh;
      client.map_age_at = Date.now();
      recordMapAge(client, data.map_age_s);
    }
    else {
      client.map_age_s = client.map_fresh = client.map_age_at = null;
    }
  }
  if (data.auto_accept && typeof data.auto_accept === 'object') {
    client.auto_accept = {
      party: data.auto_accept.party === true,
      squad: data.auto_accept.squad === true,
      leaders: shortString(data.auto_accept.leaders, 512)
    };
  }
  if (Array.isArray(data.pending_invites)) {
    client.pending_invites = data.pending_invites.slice(0, 8)
      .filter(i => i && typeof i === 'object')
      .map(i => ({ type: i.type === 'squad' ? 'squad' : 'party', leader: shortString(i.leader) }));
  }
  if (typeof data.portal_available === 'boolean') client.portal_available = data.portal_available;
  if (typeof data.squad_actions_available === 'boolean') client.squad_actions_available = data.squad_actions_available;
  if (data.wvw_team && typeof data.wvw_team === 'object') {
    const t = data.wvw_team;
    const id = v => (Number.isInteger(v) && v > 0 && v < 1e6 ? v : null);
    client.wvw_team = {
      available: t.available === true,
      known: t.known === true,
      team: id(t.team),
      required: t.required === true,
      teams: Array.isArray(t.teams) ? t.teams.map(id).filter(Boolean).slice(0, 64) : []
    };
    joinDefaultTeam(ws, client);
  }
  if (data.group && typeof data.group.source === 'string') client.group_source = shortString(data.group.source, 16);
  if (data.group !== undefined) {
    const before = client.group;
    client.group = sanitizeGroup(data.group);
    logGroupChange(client, before, client.group);
  }
  noteEotmReset(data.eotm_reset_at);
  touchInstance(client.server_ip);
}

// Joining or leaving a squad/party is worth a line in the feed; roster churn
// inside it is not.
function logGroupChange(client, before, after) {
  const wasIn = before && before.type !== 'none';
  const isIn = after && after.type !== 'none';
  if (!wasIn && isIn) {
    const cmdr = after.members.find(m => m.commander);
    logEvent('info', `${label(client)} joined a ${after.type === 'party' ? 'party' : 'squad'}` +
      (cmdr ? ` (commander ${cmdr.character || cmdr.account})` : ''), client);
  }
  else if (wasIn && !isIn) {
    logEvent('info', `${label(client)} left their ${before.type === 'party' ? 'party' : 'squad'}`, client);
  }
}

// ------------------------------------------------------------------ http

const PUBLIC_DIR = path.join(__dirname, 'public');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function healthBody() {
  return { status: 'ok', clients: clients.size, instances: instances.size, known_instances: knownInstances.size,
    machines: machines.size, dashboards: dashboards.size, paced_pending: pacedPending() };
}

// Serves the dashboard and the health check.
function handleRequest(req, res) {
  let pathname = new URL(req.url, 'http://local').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return;
  }
  // Relative asset URLs in index.html need the trailing slash.
  if (pathname === LEGACY_PREFIX) {
    res.writeHead(301, { Location: LEGACY_PREFIX + '/' });
    res.end();
    return;
  }
  if (pathname.startsWith(LEGACY_PREFIX + '/')) pathname = pathname.slice(LEGACY_PREFIX.length);
  const rest = pathname.slice(1);
  if (rest === 'health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthBody()));
    return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rest || 'index.html'));
  const type = CONTENT_TYPES[path.extname(file)];
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end(err.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

// Dashboards on their own paths, game clients on any other. Game clients are
// refused at the handshake (HTTP 401) without the token, so an unauthorised
// connection never reaches the message handlers. The dashboard authenticates
// by message instead - browsers cannot send headers.
function handleUpgrade(req, socket, head) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (DASHBOARD_SOCKET_PATHS.has(pathname)) {
    dashboardWss.handleUpgrade(req, socket, head, ws => dashboardWss.emit('connection', ws, req));
    return;
  }
  if (!tokenMatches(bearerToken(req))) {
    console.log(`[${now()}] Refused game client from ${req.socket.remoteAddress}: missing or wrong token`);
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  clientWss.handleUpgrade(req, socket, head, ws => clientWss.emit('connection', ws, req));
}

// ------------------------------------------------------------------ connections

dashboardWss.on('connection', (ws, req) => onConnection(ws, req, true));
clientWss.on('connection', (ws, req) => onConnection(ws, req, false));

function onConnection(ws, req, isDashboard) {
  // Behind Render's proxy the socket address is the proxy's.
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const remote = forwarded || req.socket.remoteAddress;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (isDashboard) {
    dashboards.add(ws);
    // Without a token configured there is nothing to prove.
    ws.authed = !TOKEN;
    if (ws.authed) {
      sendDashboardWelcome(ws);
    }
    else {
      ws.authTimer = setTimeout(() => {
        if (!ws.authed) ws.close(1008, 'authentication required');
      }, DASHBOARD_AUTH_TIMEOUT_MS);
    }
    console.log(`[${now()}] Dashboard connected from ${remote}`);
  }
  else {
    const client = {
      id: ++nextClientId,
      character: null,
      account: null,
      machine: null,
      server_ip: null,
      map: null,
      game_state: null,
      map_age_s: null,
      map_fresh: null,
      map_age_at: null,
      eotm_reset_at: null,
      eotm_reset_estimated: null,
      pacer_patch: null,
      travel_available: null,
      fps_target: null,
      connected_at: Date.now(),
      last_update: Date.now()
    };
    clients.set(ws, client);
    clientsById.set(client.id, ws);
    logEvent('info', `Game client #${client.id} connected from ${remote}`, client);
    setTimeout(() => { if (clients.has(ws)) requestStatusIfUnknown(ws, client); }, 3000);
    scheduleSnapshot();
  }

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      console.error(`[${now()}] Ignoring non-JSON message: ${String(raw).slice(0, 100)}`);
      return;
    }
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return;
    }
    try {
      if (dashboards.has(ws)) handleDashboardMessage(ws, data);
      else handleClientMessage(ws, data);
    } catch (err) {
      console.error(`[${now()}] Error handling ${data.type}:`, err);
    }
  });

  ws.on('close', () => {
    clearTimeout(ws.authTimer);
    if (dashboards.delete(ws)) {
      console.log(`[${now()}] Dashboard disconnected`);
      return;
    }
    const client = clients.get(ws);
    if (client) logEvent('warn', `${label(client)} disconnected`, client);
    cleanupClient(ws);
    scheduleSnapshot();
  });

  ws.on('error', (error) => {
    console.error(`[${now()}] WebSocket error:`, error.message);
  });
}

// Drop connections that stopped answering pings.
const heartbeat = setInterval(() => {
  [...clientWss.clients, ...dashboardWss.clients].forEach((ws) => {
    if (!ws.isAlive) {
      const client = clients.get(ws);
      if (client) logEvent('bad', `No heartbeat from ${label(client)}, dropping it`, client);
      ws.terminate(); // fires 'close', which cleans up
      return;
    }
    ws.isAlive = false;
    const known = clients.get(ws);
    if (known) requestStatusIfUnknown(ws, known);
    ws.ping();
  });
}, HEARTBEAT_MS);

// Forgotten instances drop off the dashboard even when nothing else changes.
const instanceSweep = setInterval(() => {
  const before = knownInstances.size;
  pruneInstances();
  if (knownInstances.size !== before) scheduleSnapshot();
}, 60000);

function close() {
  clearInterval(heartbeat);
  clearInterval(instanceSweep);
  for (const queue of pacedQueues.values()) clearTimeout(queue.timer);
  pacedQueues.clear();
  clientWss.close();
  dashboardWss.close();
}

// ------------------------------------------------------------------ game client -> server

const ENTER_FAIL_REASONS = {
  already_in_progress: 'already entering',
  reconnect_in_progress: 'a login is already in progress',
  loading_screen: 'on a loading screen'
};

// Command acknowledgements, with how they read in the event feed.
const ACKS = {
  travel_sent: d => [d.ok ? 'info' : 'warn', `travel request ${d.ok ? 'sent' : 'failed'} (${d.source || '?'})`],
  enter_map_started: d => ['info', d.from === 'character_select'
    ? 'at character select - logging in, then entering EotM' : 'entering EotM'],
  enter_map_complete: () => ['good', 'load screen reached'],
  enter_map_failed: d => ['bad', `could not enter EotM (${ENTER_FAIL_REASONS[d.reason] || d.reason || '?'})`],
  reconnect_started: () => ['info', 'reconnecting'],
  reconnect_complete: () => ['good', 'reconnected'],
  reconnect_failed: d => ['bad', `reconnect failed (${d.reason || '?'})`],
  fps_updated: d => ['info', `FPS set to ${d.fps}`],
  fps_limiter_disabled: () => ['info', 'FPS limiter disabled'],
  memory_limit_set: d => ['info', `memory limit set to ${d.mb} MB`],
  memory_limit_failed: d => ['warn', `memory limit failed (error ${d.error})`],
  minimized: () => ['info', 'minimized'],
  focused: () => ['info', 'focused'],
  go_to_character_select_sent: () => ['info', 'sent to character select'],
  sqjoin_sent: d => ['info', `joining squad of ${d.name}`],
  invite_sent: d => ['info', `invited ${d.name} to party`],
  auto_accept_set: d => ['info', `auto-accept ${[d.squad && 'squad', d.party && 'party'].filter(Boolean).join(' + ') || 'off'}` +
    (d.leaders ? ` (only from ${d.leaders})` : '') + (d.available === false ? ' - not available on this client' : '')],
  accept_invites_queued: d => ['info', `accepting ${d.pending} pending invite(s)`],
  squad_action_queued: d => ['info', `${d.command} queued`],
  wvw_team_join_queued: d => ['info', `joining WvW team ${teamName(d.team)}`],
  wvw_team_result: d => [d.ok ? 'good' : 'warn', d.ok ? `on WvW team ${teamName(d.team)}${d.reason === 'joined' ? ' (joined)' : ''}`
    : `could not join WvW team ${teamName(d.team)}: ${String(d.reason || 'unknown').replace(/_/g, ' ')}`],
  squad_action_result: d => [d.confirmed ? 'good' : 'warn', `${d.command}: ${d.reason}${d.subgroup ? ` (subgroup ${d.subgroup})` : ''}`],
  join_in_map_queued: d => ['info', `joining ${d.name}'s instance`],
  group_event: d => [/^Accepted|sent$/.test(d.text || '') ? 'good' : 'warn', d.text || 'group event'],
  sqinvite_sent: d => ['info', `invited ${d.name} to squad`],
  sqleave_sent: () => ['info', 'left squad'],
  view_distance_set: d => ['info', `view distance ${d.percent ? d.percent + '%' : 'game default'} (from the next map load)`],
  pacer_patch_set: d => ['info', `pacer patch ${d.enabled ? 'on' : 'off'}`],
  command_rejected: d => ['warn', `rejected ${d.command}: ${d.reason}`]
};

function handleClientMessage(ws, data) {
  const client = clients.get(ws);
  if (!client) return;

  switch (data.type) {
    case 'hello':
      applyStatus(ws, client, data);
      logEvent('info', `${label(client)} online - ${client.map || 'unknown map'}`, client);
      applyDefaultsOnce(ws, client);
      break;

    case 'status':
      applyStatus(ws, client, data);
      // Older builds never say hello; their first status stands in for it.
      applyDefaultsOnce(ws, client);
      break;

    case 'map_update':
      updateIdentity(ws, client, data);
      if (!validIp(data.server_ip) || (data.game_state !== undefined && data.game_state !== 'gameplay')) {
        return;
      }
      client.map = 'eotm';
      client.game_state = 'gameplay';
      client.loading_server_ip = client.loading_map_id = null;
      client.map_age_s = null;   // reported separately once read
      client.map_fresh = null;
      client.map_age_at = null;
      setInstance(ws, client, data.server_ip);
      logEvent('info', `${label(client)} entered EotM on ${client.server_ip} ` +
        `(${instances.get(client.server_ip).size} on that instance)`, client);
      break;

    case 'map_leave':
      updateIdentity(ws, client, data);
      setInstance(ws, client, null);
      client.map = null;
      client.loading_server_ip = client.loading_map_id = null;
      client.game_state = ['loading', 'character_select', 'login', 'disconnect_error'].includes(data.reason) ? data.reason : 'unknown';
      client.map_age_s = null;
      client.map_fresh = null;
      client.map_age_at = null;
      logEvent('info', `${label(client)} left EotM (${data.reason || 'unknown reason'})`, client);
      break;

    case 'map_age':
      if (!acceptMapAge(client, data)) return;
      client.map_age_s = data.map_age_s;
      client.map_fresh = data.fresh;
      client.map_age_at = Date.now();
      client.last_update = Date.now();
      logEvent(data.fresh ? 'good' : 'warn',
        `${label(client)} landed on ${data.fresh ? 'a fresh' : 'an old'} map ` +
        `${client.server_ip || ''} (${Math.round((data.map_age_s || 0) / 60)} min old)`, client);
      recordMapAge(client, data.map_age_s);
      break;

    case 'pong':
      client.last_update = Date.now();
      return;

    default: {
      const ack = ACKS[data.type];
      if (!ack) {
        console.log(`[${now()}] Unknown message type from ${label(client)}: ${data.type}`);
        return;
      }
      client.last_update = Date.now();
      const [level, text] = ack(data);
      logEvent(level, `${label(client)}: ${text}`, client);
    }
  }
  scheduleSnapshot();
}

function cleanupClient(ws) {
  const client = clients.get(ws);
  if (!client) return;
  touchInstance(client.server_ip);
  removeFromIndex(instances, client.server_ip, ws);
  removeFromIndex(machines, client.machine, ws);
  clientsById.delete(client.id);
  clients.delete(ws);
}

// ------------------------------------------------------------------ dashboard -> server

function intInRange(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

// Once per connection, as soon as the client has said what it currently has.
function applyDefaultsOnce(ws, client) {
  if (client.defaults_applied) return;
  client.defaults_applied = true;
  const n = applyDefaults(ws, client);
  if (n) logEvent('info', `${label(client)}: applied ${n} default setting(s)`, client);
}

function sendDashboardWelcome(ws) {
  send(ws, { type: 'auth_ok', token_required: !!TOKEN });
  send(ws, buildSnapshot());
  send(ws, { type: 'events', events });
}

// A character or account name going into a chat command: nothing that could
// end the command early or start another.
function validName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 64 && !/[\r\n\/]/.test(name);
}

// The commands a dashboard may send to game clients, and how each is built
// from the dashboard's request. null means the arguments were invalid.
const COMMANDS = {
  enter_map: () => ({ type: 'enter_map' }),
  bring_to_front: () => ({ type: 'bring_to_front' }),
  minimize: () => ({ type: 'minimize' }),
  close: () => ({ type: 'close_game' }),
  reconnect: () => ({ type: 'reconnect' }),
  go_to_character_select: () => ({ type: 'go_to_character_select' }),
  disable_fps_limiter: () => ({ type: 'disable_fps_limiter' }),
  set_fps: c => {
    const fps = intInRange(c.fps, 1, 200, null);
    return fps === null ? null : { type: 'set_fps', fps };
  },
  set_view_distance: c => {
    const percent = intInRange(c.percent, 0, 100, null);
    return percent === null ? null : { type: 'set_view_distance', percent };
  },
  set_pacer_patch: c => (typeof c.enabled === 'boolean' ? { type: 'set_pacer_patch', enabled: c.enabled } : null),
  invite: c => (validName(c.name) ? { type: 'invite', name: c.name.trim() } : null),
  sqinvite: c => (validName(c.name) ? { type: 'sqinvite', name: c.name.trim() } : null),
  sqjoin: c => (validName(c.name) ? { type: 'sqjoin', name: c.name.trim() } : null),
  sqleave: () => ({ type: 'sqleave' }),
  organize_eotm_subgroups: () => ({ type: 'organize_eotm_subgroups' }),
  create_squad: () => ({ type: 'create_squad' }),
  move_subgroup: c => {
    const subgroup = intInRange(c.subgroup, 1, 15, null);
    return subgroup === null ? null : { type: 'move_subgroup', subgroup };
  },
  accept_invites: () => ({ type: 'accept_invites' }),
  join_in_map: c => (validName(c.name) ? { type: 'join_in_map', name: c.name.trim() } : null),
  set_wvw_team: c => {
    const team = intInRange(c.team, 1, 99999, null);
    return team === null ? null : { type: 'set_wvw_team', team };
  },
  set_auto_accept: c => {
    const out = { type: 'set_auto_accept' };
    if (c.party !== undefined) {
      if (typeof c.party !== 'boolean') return null;
      out.party = c.party;
    }
    if (c.squad !== undefined) {
      if (typeof c.squad !== 'boolean') return null;
      out.squad = c.squad;
    }
    if (c.leaders !== undefined) {
      if (typeof c.leaders !== 'string' || c.leaders.length > 512 || /[\r\n]/.test(c.leaders)) return null;
      out.leaders = c.leaders;
    }
    return out;
  },
  set_memory_limit: c => {
    const mb = intInRange(c.mb, 256, 32768, null);
    return mb === null ? null : { type: 'set_memory_limit', mb };
  }
};

// target: { kind: 'all' } | { kind: 'machine', value } | { kind: 'instance', value } | { kind: 'clients', value: [ids] }
function resolveTarget(target) {
  if (!target || typeof target !== 'object') return null;
  switch (target.kind) {
    case 'all': return { sockets: [...clients.keys()], what: 'all clients' };
    case 'machine': return { sockets: [...(machines.get(target.value) || [])], what: `machine ${target.value}` };
    case 'instance': return { sockets: [...(instances.get(target.value) || [])], what: `instance ${target.value}` };
    case 'clients': {
      if (!Array.isArray(target.value)) return null;
      const sockets = target.value.map(id => clientsById.get(id)).filter(Boolean);
      return { sockets, what: `${sockets.length} selected client(s)` };
    }
    default: return null;
  }
}

// Commands without arguments go out as bare strings ("enter_map"), as the
// previous server sent them: older addon builds only understand that form, and
// current ones accept both.
// Exactly the set the previous server sent as strings; everything else stayed JSON.
const PLAIN_COMMANDS = new Set(['enter_map', 'bring_to_front', 'minimize', 'close_game', 'reconnect',
  'disable_fps_limiter']);

function toWire(payload) {
  return Object.keys(payload).length === 1 && PLAIN_COMMANDS.has(payload.type) ? payload.type : payload;
}

// ------------------------------------------------------------------ paced sends

// Some commands hurt when a whole machine gets them at once: closing dozens of
// games together stalls the PC, and bring_to_front on every window at once
// just has them fight over the foreground. Those go through a queue per
// machine, one message per interval; machines run in parallel.
const PACED = {
  close_game: Number(process.env.EOTM_CLOSE_COMMAND_INTERVAL_MS) || 350,
  bring_to_front: Number(process.env.EOTM_FOCUS_INTERVAL_MS) || 1000
};

const pacedQueues = new Map();  // "command|machine" -> { items: [ws], timer }

function pacedKey(type, ws) {
  const client = clients.get(ws);
  // A client that has not named its machine gets a queue of its own.
  return `${type}|${client && client.machine ? `m:${client.machine}` : `c:${client ? client.id : '?'}`}`;
}

// Queues `type` (a plain-string command) for each socket. Returns how many
// were queued; a socket already waiting for the same command is not queued
// twice.
function sendPaced(type, sockets) {
  let queued = 0;
  for (const ws of sockets) {
    if (!clients.has(ws)) continue;
    const key = pacedKey(type, ws);
    let queue = pacedQueues.get(key);
    if (!queue) {
      queue = { type, items: [], timer: null };
      pacedQueues.set(key, queue);
    }
    if (queue.items.includes(ws)) continue;
    queue.items.push(ws);
    queued++;
    if (!queue.timer) {
      drainPaced(key);  // the first one goes immediately
    }
  }
  return queued;
}

function drainPaced(key) {
  const queue = pacedQueues.get(key);
  if (!queue) return;
  // Skip sockets that went away while waiting.
  let ws;
  while ((ws = queue.items.shift()) && !send(ws, queue.type)) { /* gone */ }
  if (queue.items.length === 0) {
    queue.timer = ws ? setTimeout(() => finishPaced(key), PACED[queue.type]) : null;
    if (!ws) pacedQueues.delete(key);
    return;
  }
  queue.timer = setTimeout(() => drainPaced(key), PACED[queue.type]);
}

// The interval after the last send still applies to anything queued during it.
function finishPaced(key) {
  const queue = pacedQueues.get(key);
  if (!queue) return;
  if (queue.items.length) {
    drainPaced(key);
  }
  else {
    pacedQueues.delete(key);
  }
}

function pacedPending() {
  let n = 0;
  for (const q of pacedQueues.values()) n += q.items.length;
  return n;
}

function runCommand(data) {
  const command = data.command || {};
  const build = COMMANDS[command.type];
  const resolved = resolveTarget(data.target);
  if (!build || !resolved) {
    logEvent('warn', `Dashboard sent an invalid command (${command.type || 'none'})`);
    return;
  }
  const payload = build(command);
  if (!payload) {
    logEvent('warn', `Dashboard sent ${command.type} with invalid arguments`);
    return;
  }
  if (payload.type === 'set_wvw_team') {
    // Accounts that already have a team keep it; don't ask them.
    const sockets = resolved.sockets.filter(ws => {
      const t = clients.get(ws)?.wvw_team;
      return !(t && t.known && t.team !== null);
    });
    let sent = 0;
    for (const ws of sockets) if (send(ws, payload)) sent++;
    logEvent('info', `Set WvW team ${teamName(payload.team)} on ${resolved.what}: ${sent} without a team asked, ` +
      `${resolved.sockets.length - sockets.length} already on a team`);
    return;
  }
  const wire = toWire(payload);
  if (typeof wire === 'string' && PACED[wire]) {
    const queued = sendPaced(wire, resolved.sockets);
    logEvent('info', `Sending ${command.type} to ${resolved.what}: ${queued} queued, ` +
      `one per machine every ${PACED[wire]} ms`);
    return;
  }
  if (payload.type === 'organize_eotm_subgroups') {
    const selected = new Set(resolved.sockets.map(ws => clients.get(ws)?.id).filter(id => id != null));
    const byId = new Map([...clients.values()].map(c => [c.id, c]));
    const plan = planMapSubgroups(buildSquads(), byId, mapSubgroupAssignments, selected);
    mapSubgroupAssignments = plan.next;
    let sent = 0;
    for (const move of plan.moves) {
      const ws = clientsById.get(move.client);
      if (ws && send(ws, { type: 'move_subgroup', subgroup: move.subgroup, expected_server_ip: move.expected_server_ip, expected_squad_id: move.expected_squad_id })) sent++;
    }
    for (const warning of plan.warnings) logEvent('warn', `Map subgroup assignment skipped: ${warning.reason}`);
    logEvent('info', `EotM subgroup plan: ${plan.assignments.length} instance(s), ${sent} move request(s)`);
    return;
  }
  let sent = 0;
  for (const ws of resolved.sockets) if (send(ws, wire)) sent++;
  logEvent('info', `Sent ${command.type} to ${resolved.what} (${sent} delivered)`);
}

function handleDashboardMessage(ws, data) {
  // Nothing but "auth" until the dashboard has proved it knows the token.
  if (!ws.authed) {
    if (data.type === 'auth' && tokenMatches(data.token)) {
      ws.authed = true;
      clearTimeout(ws.authTimer);
      sendDashboardWelcome(ws);
      console.log(`[${now()}] Dashboard authenticated`);
    }
    else {
      console.log(`[${now()}] Dashboard sent a wrong or missing token, disconnecting`);
      send(ws, { type: 'auth_failed' });
      ws.close(1008, 'invalid token');
    }
    return;
  }

  switch (data.type) {
    case 'auth': sendDashboardWelcome(ws); break;
    case 'request_snapshot': send(ws, buildSnapshot()); break;
    case 'command': runCommand(data); break;
    case 'close_excess': closeExcess(instances, intInRange(data.keep_count, 0, 100, 2), 'instance'); break;
    case 'keep_per_machine': closeExcess(machines, intInRange(data.keep_count, 0, 100, 5), 'machine'); break;
    case 'set_defaults': setDefaults(data.defaults, data.apply_now === true); break;
    case 'char_select_rest': charSelectRest(data.server_ip, intInRange(data.keep, 0, 100, null)); break;
    default:
      console.log(`[${now()}] Unknown dashboard command: ${data.type}`);
  }
}

// Sends all but the `keep` longest-present clients on one instance to
// character select. Instance sets keep arrival order, so the first ones are
// the clients that have been there longest.
function charSelectRest(serverIp, keep) {
  const set = typeof serverIp === 'string' ? instances.get(serverIp) : null;
  if (!set || keep === null) {
    logEvent('warn', 'Dashboard sent char_select_rest for an unknown instance or keep count');
    return;
  }
  let sent = 0;
  for (const ws of [...set].slice(keep)) {
    if (send(ws, { type: 'go_to_character_select' })) sent++;
  }
  logEvent('info', `Sent ${sent} client(s) on ${serverIp} to character select, keeping ${Math.min(keep, set.size)}`);
}

// Closes all but the first `keep` clients of every group (instance or machine).
function closeExcess(index, keep, groupName) {
  const victims = [];
  for (const set of index.values()) {
    victims.push(...[...set].slice(keep));
  }
  const queued = sendPaced('close_game', victims);
  logEvent('warn', `Closing ${queued} client(s), keeping ${keep} per ${groupName} ` +
    `(one per machine every ${PACED.close_game} ms)`);
}

// ------------------------------------------------------------------ start

loadDefaults();

const server = http.createServer(handleRequest);
server.on('upgrade', handleUpgrade);

server.listen(PORT, () => {
  console.log(`EotM Control listening on port ${PORT}`);
  console.log(`Client defaults: ${describeDefaults(clientDefaults)} (${DEFAULTS_FILE})`);
  if (TOKEN) {
    console.log('Token check: ON (EOTM_TOKEN is set)');
  }
  else {
    console.log('WARNING: token check is OFF - anyone who can reach this server can control every client.');
    console.log('         Set EOTM_TOKEN to a long random string to require it.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
