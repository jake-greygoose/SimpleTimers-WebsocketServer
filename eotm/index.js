// EotM Control: the eotm-assist addon's server and web dashboard, mounted on
// the timer server's HTTP server under /eotm:
//
//   /eotm/           dashboard (eotm/public)
//   /eotm/health     JSON health check
//   /eotm/ws         game clients (the addon's WebSocket URL)
//   /eotm/admin      dashboard WebSocket
//
// Usage from server.js:
//   const eotm = require('./eotm')({ basePath: '/eotm' });
//   if (eotm.handleRequest(req, res)) return;          // in the HTTP handler
//   if (eotm.handleUpgrade(req, socket, head)) return;  // in 'upgrade'
//   eotm.close();                                       // on shutdown
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Shared secret. When set, game clients must send it as
// "Authorization: Bearer <token>" (the addon's "Server token" setting) and the
// dashboard must send {"type":"auth","token":...} as its first message.
// Unset means no check at all - only acceptable on a private network.
const TOKEN = process.env.EOTM_TOKEN || '';

// Set by the factory at the bottom from options.basePath.
let BASE_PATH = '/eotm';

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
    map: c.map,
    game_state: c.game_state,
    map_age_s: c.map_age_s,
    map_fresh: c.map_fresh,
    map_age_at: c.map_age_at,
    eotm_reset_at: c.eotm_reset_at,
    eotm_reset_estimated: c.eotm_reset_estimated,
    render_skip_mode: c.render_skip_mode,
    render_skipping: c.render_skipping,
    pacer_patch: c.pacer_patch,
    travel_available: c.travel_available,
    fps_target: c.fps_target,
    connected_at: c.connected_at,
    last_update: c.last_update,
    group_type: c.group ? c.group.type : 'none',
    group_source: c.group_source || null,
    auto_accept: c.auto_accept || null,
    pending_invites: c.pending_invites || [],
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
    const overlapping = groups.filter(g => [...accounts].some(a => g.accounts.has(a)));
    const merged = { accounts, reporters: [c] };
    for (const g of overlapping) {
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
      id: accountKey(commander ? commander.account : list.map(m => m.account).sort()[0]),
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
  if (!client.server_ip || typeof ageSeconds !== 'number' || ageSeconds < 0) return;
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

function buildSnapshot() {
  pruneInstances();
  return {
    type: 'snapshot',
    server_time: Date.now(),
    fresh_minutes: FRESH_MINUTES,
    eotm_reset_at: nextEotmResetAt,
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
  addToIndex(instances, client.server_ip, ws);
  touchInstance(client.server_ip);
}

// Fields copied as-is from hello/status when present.
const STATUS_FIELDS = ['map', 'game_state', 'travel_available', 'render_skip_mode', 'render_skipping',
  'pacer_patch', 'fps_target', 'eotm_reset_at', 'eotm_reset_estimated'];

function applyStatus(ws, client, data) {
  updateIdentity(ws, client, data);
  for (const field of STATUS_FIELDS) {
    if (data[field] !== undefined) client[field] = data[field];
  }
  // A client already in EotM when it (re)connects - after a server restart,
  // say - names its instance here; one that is not in EotM is on no instance.
  const statusIp = realValue(data.server_ip);
  // Builds without in_eotm only report an IP while in EotM.
  if ((data.in_eotm === true || data.in_eotm === undefined) && statusIp) {
    setInstance(ws, client, statusIp);
  }
  else if (data.in_eotm === false) {
    setInstance(ws, client, null);
  }
  if (data.map_age_s != null) {
    client.map_age_s = data.map_age_s;
    client.map_fresh = data.map_fresh;
    client.map_age_at = Date.now();
    recordMapAge(client, data.map_age_s);
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
    machines: machines.size, dashboards: dashboards.size };
}

// Serves the dashboard and the health check. Returns false for paths that are
// not ours, so the host server can handle them.
function handleRequest(req, res) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname !== BASE_PATH && !pathname.startsWith(BASE_PATH + '/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
    return true;
  }
  // Relative asset URLs in index.html need the trailing slash.
  if (pathname === BASE_PATH) {
    res.writeHead(301, { Location: BASE_PATH + '/' });
    res.end();
    return true;
  }
  const rest = pathname.slice(BASE_PATH.length + 1);
  if (rest === 'health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthBody()));
    return true;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rest || 'index.html'));
  const type = CONTENT_TYPES[path.extname(file)];
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !type) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
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
  return true;
}

// Takes the WebSocket upgrades for /eotm/ws (game clients) and /eotm/admin
// (dashboards). Game clients are refused at the handshake (HTTP 401) without
// the token, so an unauthorised connection never reaches the message handlers.
// The dashboard authenticates by message instead - browsers cannot send headers.
function handleUpgrade(req, socket, head) {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname === BASE_PATH + '/admin') {
    dashboardWss.handleUpgrade(req, socket, head, ws => dashboardWss.emit('connection', ws, req));
    return true;
  }
  if (pathname === BASE_PATH + '/ws') {
    if (!tokenMatches(bearerToken(req))) {
      console.log(`[${now()}] Refused game client from ${req.socket.remoteAddress}: missing or wrong token`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return true;
    }
    clientWss.handleUpgrade(req, socket, head, ws => clientWss.emit('connection', ws, req));
    return true;
  }
  return false;
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
      render_skip_mode: null,
      render_skipping: null,
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
  clientWss.close();
  dashboardWss.close();
}

// ------------------------------------------------------------------ game client -> server

// Command acknowledgements, with how they read in the event feed.
const ACKS = {
  travel_sent: d => [d.ok ? 'info' : 'warn', `travel request ${d.ok ? 'sent' : 'failed'} (${d.source || '?'})`],
  enter_map_started: () => ['info', 'entering EotM'],
  enter_map_complete: () => ['good', 'load screen reached'],
  enter_map_failed: d => ['bad', `could not enter EotM (${d.reason || '?'})`],
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
  join_in_map_queued: d => ['info', `joining ${d.name}'s instance`],
  group_event: d => [/^Accepted|sent$/.test(d.text || '') ? 'good' : 'warn', d.text || 'group event'],
  sqinvite_sent: d => ['info', `invited ${d.name} to squad`],
  sqleave_sent: () => ['info', 'left squad'],
  render_skip_set: d => ['info', `render skip ${d.mode}`],
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
      break;

    case 'status':
      applyStatus(ws, client, data);
      break;

    case 'map_update':
      updateIdentity(ws, client, data);
      if (!realValue(data.server_ip)) {
        return;
      }
      client.map = 'eotm';
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
      client.map_age_s = null;
      client.map_fresh = null;
      client.map_age_at = null;
      logEvent('info', `${label(client)} left EotM (${data.reason || 'unknown reason'})`, client);
      break;

    case 'map_age':
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
  set_render_skip: c => (['off', 'always', 'unfocused'].includes(c.mode) ? { type: 'set_render_skip', mode: c.mode } : null),
  set_pacer_patch: c => (typeof c.enabled === 'boolean' ? { type: 'set_pacer_patch', enabled: c.enabled } : null),
  invite: c => (validName(c.name) ? { type: 'invite', name: c.name.trim() } : null),
  sqinvite: c => (validName(c.name) ? { type: 'sqinvite', name: c.name.trim() } : null),
  sqjoin: c => (validName(c.name) ? { type: 'sqjoin', name: c.name.trim() } : null),
  sqleave: () => ({ type: 'sqleave' }),
  accept_invites: () => ({ type: 'accept_invites' }),
  join_in_map: c => (validName(c.name) ? { type: 'join_in_map', name: c.name.trim() } : null),
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
  let sent = 0;
  const wire = toWire(payload);
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
    default:
      console.log(`[${now()}] Unknown dashboard command: ${data.type}`);
  }
}

// Closes all but the first `keep` clients of every group (instance or machine).
function closeExcess(index, keep, groupName) {
  let total = 0;
  for (const set of index.values()) {
    for (const ws of [...set].slice(keep)) {
      if (send(ws, 'close_game')) total++;
    }
  }
  logEvent('warn', `Closed ${total} client(s), keeping ${keep} per ${groupName}`);
}

module.exports = function createEotm(options = {}) {
  BASE_PATH = (options.basePath || '/eotm').replace(/\/+$/, '');
  if (TOKEN) {
    console.log('EotM: token check ON (EOTM_TOKEN is set)');
  }
  else {
    console.log('EotM: WARNING - token check is OFF; anyone who can reach this server can control every client.');
    console.log('      Set EOTM_TOKEN to a long random string to require it.');
  }
  console.log(`EotM: dashboard ${BASE_PATH}/, clients ${BASE_PATH}/ws`);
  return { handleRequest, handleUpgrade, close };
};
