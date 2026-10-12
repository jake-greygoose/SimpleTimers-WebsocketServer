'use strict';

// EotM Control dashboard.
//
// The server pushes a full snapshot whenever something changes (at most four
// a second) plus individual activity events. Rows are keyed by client id and
// updated in place, cell by cell, only when a value actually changes, and are
// only moved when the order really changes - so nothing flashes or jumps.
// Ages and "last seen" tick locally once a second between snapshots.

// The page is served at <base>/ and its socket is <base>/admin (e.g. /eotm/admin).
const DASHBOARD_PATH = location.pathname.replace(/\/[^/]*$/, '') + '/admin';
const EVENT_LIMIT = 200;

const state = {
  clients: new Map(),      // id -> client
  instances: new Map(),    // ip -> instance
  squads: [],
  freshMinutes: 10,
  selected: new Set(),     // ids
  groupBy: loadPref('groupBy', 'instance'),
  filter: '',
  clockOffset: 0,          // server time - local time, ms
  lastSnapshot: 0,
  connected: false
};

let ws = null;
let authFailed = false;

const $ = id => document.getElementById(id);
const rowsEl = $('rows');
const rowEls = new Map();  // row key -> <tr>

// ------------------------------------------------------------------ helpers

function loadPref(key, fallback) {
  try { return localStorage.getItem('eotm.' + key) || fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem('eotm.' + key, value); } catch { /* private mode */ }
}
function storedToken() {
  try { return sessionStorage.getItem('eotm.token') || ''; } catch { return ''; }
}
function storeToken(token) {
  try { sessionStorage.setItem('eotm.token', token); } catch { /* private mode */ }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function setClass(el, cls) {
  if (el.className !== cls) el.className = cls;
}
function setTitle(el, title) {
  if (el.title !== title) el.title = title;
}

function serverNow() {
  return Date.now() + state.clockOffset;
}

// Map ages are minutes-to-hours; seconds would only add noise and width.
function fmtMinutes(seconds) {
  const m = Math.max(0, Math.floor(seconds / 60));
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// A stable colour per machine, so its clients are easy to spot in a flat list.
function hueOf(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return (h * 137) % 360;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// ------------------------------------------------------------------ connection

function setConn(text, kind) {
  setText($('conn-text'), text);
  setClass($('conn'), `status-pill status-${kind}`);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}${DASHBOARD_PATH}`);

  ws.onopen = () => {
    setConn('Authenticating…', 'muted');
    ws.send(JSON.stringify({ type: 'auth', token: storedToken() }));
  };

  ws.onmessage = (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    switch (data.type) {
      case 'auth_ok':
        state.connected = true;
        setConn('Connected', 'good');
        updateActionState();
        break;
      case 'auth_failed':
        authFailed = true;
        break;
      case 'snapshot':
        applySnapshot(data);
        break;
      case 'events':
        resetEvents(data.events || []);
        break;
      case 'event':
        addEvent(data.event, true);
        break;
    }
  };

  ws.onclose = () => {
    state.connected = false;
    updateActionState();
    if (authFailed) {
      setConn('Token required', 'bad');
      const dialog = $('auth');
      $('token').value = '';
      if (!dialog.open) dialog.showModal();
      return;
    }
    setConn('Disconnected – retrying', 'bad');
    setTimeout(connect, 2000);
  };
}

$('auth-form').addEventListener('submit', () => {
  storeToken($('token').value);
  authFailed = false;
  connect();
});

function send(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// ------------------------------------------------------------------ data

function applySnapshot(snapshot) {
  state.clockOffset = snapshot.server_time - Date.now();
  state.clients = new Map((snapshot.clients || []).map(c => [c.id, c]));
  state.instances = new Map((snapshot.instances || []).map(i => [i.ip, i]));
  state.squads = snapshot.squads || [];
  if (snapshot.fresh_minutes) state.freshMinutes = snapshot.fresh_minutes;
  for (const id of [...state.selected]) {
    if (!state.clients.has(id)) state.selected.delete(id);
  }
  state.lastSnapshot = Date.now();
  render();
}

function groupKeyOf(c) {
  if (state.groupBy === 'machine') return c.machine || '(unidentified)';
  if (state.groupBy === 'instance') return c.server_ip || 'Not in EotM';
  return null;
}

function matchesFilter(c) {
  if (!state.filter) return true;
  const hay = [c.character, c.machine, c.server_ip, c.account].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(state.filter);
}

function byName(a, b) {
  const an = (a.character || '').toLowerCase();
  const bn = (b.character || '').toLowerCase();
  return an < bn ? -1 : an > bn ? 1 : a.id - b.id;
}

// The rows to show, in order: [{ key, group?, client? }]
function layoutRows() {
  const visible = [...state.clients.values()].filter(matchesFilter);
  if (state.groupBy === 'none') {
    return visible.sort(byName).map(c => ({ key: `c:${c.id}`, client: c }));
  }
  const groups = new Map();
  for (const c of visible) {
    const key = groupKeyOf(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  // "Not in EotM" / "(unidentified)" go last.
  const names = [...groups.keys()].sort((a, b) => {
    const pa = a.startsWith('(') || a === 'Not in EotM';
    const pb = b.startsWith('(') || b === 'Not in EotM';
    if (pa !== pb) return pa ? 1 : -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  const rows = [];
  for (const name of names) {
    const members = groups.get(name).sort(byName);
    rows.push({ key: `g:${state.groupBy}:${name}`, group: name, members });
    for (const c of members) rows.push({ key: `c:${c.id}`, client: c });
  }
  return rows;
}

// One IP is one EotM map instance, so every client on it shares its age. The
// server works out when each instance opened from the clients' readings;
// fall back to a client's own reading until it has.
function instanceAgeSeconds(ip) {
  const inst = ip && state.instances.get(ip);
  if (inst && inst.opened_at) return (serverNow() - inst.opened_at) / 1000;
  return null;
}

function clientAgeSeconds(c) {
  if (state.instances.has(c.server_ip)) return instanceAgeSeconds(c.server_ip);
  if (c.server_ip && c.map_age_s != null) {
    return c.map_age_s + (c.map_age_at ? (serverNow() - c.map_age_at) / 1000 : 0);
  }
  return null;
}

function isFresh(ageSeconds) {
  return ageSeconds != null && ageSeconds < state.freshMinutes * 60;
}

// ------------------------------------------------------------------ rendering

function render() {
  renderTiles();
  renderInstances();
  renderSquads();
  renderTargets();
  renderRows();
  updateActionState();
  setText($('updated'), state.lastSnapshot ? `Updated ${new Date(state.lastSnapshot).toLocaleTimeString()}` : '');
}

function renderTiles() {
  const all = [...state.clients.values()];
  setText($('t-clients'), String(all.length));
  setText($('t-eotm'), String(all.filter(c => c.server_ip).length));
  setText($('t-instances'), String(new Set(all.map(c => c.server_ip).filter(Boolean)).size));
  setText($('t-machines'), String(new Set(all.map(c => c.machine).filter(Boolean)).size));
  const ages = [...state.instances.keys()].map(instanceAgeSeconds).filter(a => a != null);
  setText($('t-fresh'), String(ages.filter(isFresh).length));
  setText($('t-old'), String(ages.filter(a => !isFresh(a)).length));
  setText($('t-outside'), String(all.filter(c => !c.server_ip).length));
}

const ICONS = {
  charselect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>',
  focus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8"/></svg>',
  enter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="M6 6l12 12"/></svg>'
};

function iconButton(kind, label, extraClass) {
  const b = el('button', `icon-btn${extraClass ? ' ' + extraClass : ''}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.dataset.rowAction = kind;
  b.innerHTML = ICONS[kind];  // static markup only
  return b;
}

function createClientRow(id) {
  const tr = el('tr', 'client');
  tr.dataset.id = String(id);

  const check = el('td');
  const box = el('input');
  box.type = 'checkbox';
  box.setAttribute('aria-label', 'Select');
  check.appendChild(box);

  const cells = {
    check,
    name: el('td', 'c-char-cell'),
    machine: el('td', 'hide-sm'),
    where: el('td'),
    ip: el('td', 'hide-sm'),
    age: el('td'),
    render: el('td', 'hide-md'),
    seen: el('td', 'hide-md muted'),
    actions: el('td')
  };
  const char = el('div', 'char');
  cells.avatar = el('span', 'avatar');
  cells.nameText = el('span', 'char-name');
  char.append(cells.avatar, cells.nameText);
  cells.name.appendChild(char);
  cells.whereBadge = el('span', 'badge');
  cells.where.appendChild(cells.whereBadge);
  cells.ageBadge = el('span', 'badge');
  cells.age.appendChild(cells.ageBadge);
  cells.renderBadge = el('span', 'badge');
  cells.render.appendChild(cells.renderBadge);

  const actions = el('div', 'row-actions');
  actions.append(iconButton('focus', 'Focus window'), iconButton('enter', 'Enter EotM'),
    iconButton('charselect', 'Character select'), iconButton('close', 'Close game', 'danger'));
  cells.actions.appendChild(actions);

  tr.append(cells.check, cells.name, cells.machine, cells.where, cells.ip, cells.age, cells.render, cells.seen, cells.actions);
  tr._cells = cells;
  tr._box = box;
  return tr;
}

function createGroupRow() {
  const tr = el('tr', 'group-row');
  const td = el('td');
  td.colSpan = 9;
  const box = el('input');
  box.type = 'checkbox';
  box.setAttribute('aria-label', 'Select group');
  const name = el('span');
  const count = el('span', 'group-count');
  const age = el('span', 'badge');
  age.hidden = true;
  td.append(box, document.createTextNode(' '), name, count, age);
  tr.appendChild(td);
  tr._box = box;
  tr._name = name;
  tr._count = count;
  tr._age = age;
  return tr;
}

const WHERE = {
  eotm: ['EotM', 'badge badge-info'],
  lions_arch: ["Lion's Arch", 'badge'],
  armistice_bastion: ['Armistice Bastion', 'badge'],
  other: ['Other map', 'badge'],
  character_select: ['Character select', 'badge badge-warn'],
  loading: ['Loading', 'badge']
};

function updateClientRow(tr, c) {
  const cells = tr._cells;
  const selected = state.selected.has(c.id);
  setClass(tr, selected ? 'client selected' : 'client');
  if (tr._box.checked !== selected) tr._box.checked = selected;

  const name = c.character || `Client #${c.id}`;
  setText(cells.nameText, name);
  setTitle(cells.name, [c.account, c.machine].filter(Boolean).join(' · '));
  setText(cells.avatar, name.trim().charAt(0).toUpperCase() || '?');
  const hue = String(hueOf(c.machine || ''));
  if (cells.avatar.style.getPropertyValue('--hue') !== hue) cells.avatar.style.setProperty('--hue', hue);
  setText(cells.machine, c.machine || '—');

  const place = c.game_state === 'character_select' || c.game_state === 'loading' ? c.game_state : c.map;
  const [whereText, whereClass] = WHERE[place] || ['—', 'badge badge-empty'];
  setText(cells.whereBadge, whereText);
  setClass(cells.whereBadge, whereClass);

  setText(cells.ip, c.server_ip || '—');

  const age = clientAgeSeconds(c);
  if (age != null) {
    setText(cells.ageBadge, `${fmtMinutes(age)} · ${isFresh(age) ? 'fresh' : 'old'}`);
    setClass(cells.ageBadge, isFresh(age) ? 'badge badge-good' : 'badge badge-warn');
  }
  else {
    setText(cells.ageBadge, c.server_ip ? 'reading…' : '—');
    setClass(cells.ageBadge, c.server_ip ? 'badge' : 'badge badge-empty');
  }

  // Frame cap: the real lever on CPU and GPU per client.
  const view = c.view_distance ? ` · ${c.view_distance}% view` : '';
  setText(cells.renderBadge, (c.fps_target ? `${c.fps_target} fps` : 'Uncapped') + view);
  setClass(cells.renderBadge, c.fps_target ? 'badge badge-good' : 'badge badge-warn');
  const details = [
    c.fps_target ? `FPS cap ${c.fps_target}` : 'No FPS cap',
    c.pacer_patch ? 'pacer patch on' : 'pacer patch off',
    c.view_distance ? `view distance ${c.view_distance}%` : 'view distance: game default',
    c.travel_available === false ? 'travel unavailable' : null
  ].filter(Boolean).join(', ');
  setTitle(cells.renderBadge, details);

  setText(cells.seen, c.last_update ? fmtAgo(serverNow() - c.last_update) : '—');
}

function updateGroupRow(tr, row) {
  setText(tr._name, row.group);
  setText(tr._count, `${row.members.length}`);
  const age = state.groupBy === 'instance' ? instanceAgeSeconds(row.group) : null;
  if (tr._age.hidden !== (age == null)) tr._age.hidden = age == null;
  if (age != null) {
    setText(tr._age, `${fmtMinutes(age)} · ${isFresh(age) ? 'fresh' : 'old'}`);
    setClass(tr._age, isFresh(age) ? 'badge badge-good' : 'badge badge-warn');
  }
  const picked = row.members.filter(c => state.selected.has(c.id)).length;
  const all = picked === row.members.length && picked > 0;
  if (tr._box.checked !== all) tr._box.checked = all;
  tr._box.indeterminate = picked > 0 && !all;
  tr._members = row.members.map(c => c.id);
}

function renderRows() {
  const rows = layoutRows();
  const wanted = new Set(rows.map(r => r.key));

  rows.forEach((row, index) => {
    let tr = rowEls.get(row.key);
    if (!tr) {
      tr = row.client ? createClientRow(row.client.id) : createGroupRow();
      rowEls.set(row.key, tr);
    }
    if (row.client) updateClientRow(tr, row.client);
    else updateGroupRow(tr, row);

    // Only touch the DOM order when it is actually wrong.
    if (rowsEl.children[index] !== tr) {
      rowsEl.insertBefore(tr, rowsEl.children[index] || null);
    }
  });

  for (const [key, tr] of rowEls) {
    if (!wanted.has(key)) {
      tr.remove();
      rowEls.delete(key);
    }
  }

  $('empty').hidden = rows.length > 0;
  setText($('empty-text'), state.clients.size === 0 ? 'No game clients connected.' : 'Nothing matches the search.');

  const shown = rows.filter(r => r.client).map(r => r.client.id);
  const picked = shown.filter(id => state.selected.has(id)).length;
  const selectAll = $('select-all');
  selectAll.checked = shown.length > 0 && picked === shown.length;
  selectAll.indeterminate = picked > 0 && picked < shown.length;
}

// ------------------------------------------------------------------ instances

const instGrid = $('inst-grid');
const instEls = new Map();  // ip -> card

const COPY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

function createInstanceCard(ip) {
  const card = el('article', 'inst');
  card.dataset.ip = ip;

  const top = el('div', 'inst-top');
  const ipEl = el('span', 'inst-ip', ip);
  const copy = el('button', 'icon-btn');
  copy.type = 'button';
  copy.title = 'Copy IP';
  copy.setAttribute('aria-label', `Copy ${ip}`);
  copy.dataset.instAction = 'copy';
  copy.innerHTML = COPY_ICON;  // static markup only
  top.append(ipEl, copy);

  const ageRow = el('div', 'inst-age');
  const ageValue = el('span', 'inst-age-value');
  const chip = el('span', 'badge');
  ageRow.append(ageValue, chip);

  const meter = el('div', 'inst-meter');
  const fill = el('span');
  meter.appendChild(fill);

  const meta = el('div', 'inst-meta');

  const foot = el('div', 'inst-foot');
  const who = el('span', 'inst-who');
  const target = el('button', 'btn btn-flat btn-xs', 'Send to');
  target.type = 'button';
  target.dataset.instAction = 'target';
  target.title = 'Send commands to the clients on this instance';
  foot.append(who, target);

  const rotate = el('div', 'inst-rotate');
  const keepLabel = el('label', null, 'Keep');
  const keep = el('input');
  keep.type = 'number';
  keep.min = '0';
  keep.max = '100';
  keep.value = '5';
  keep.setAttribute('aria-label', `Clients to keep on ${ip}`);
  keepLabel.appendChild(keep);
  const charSelect = el('button', 'btn btn-flat btn-xs', 'Char select rest');
  charSelect.type = 'button';
  charSelect.dataset.instAction = 'charselect';
  charSelect.title = 'Keep the clients that have been here longest; send the rest to character select';
  rotate.append(keepLabel, charSelect);

  card.append(top, ageRow, meter, meta, foot, rotate);
  card._els = { ageValue, chip, fill, meta, who, target, rotate, keep, charSelect };
  return card;
}

function updateInstanceCard(card, inst) {
  const e = card._els;
  const age = instanceAgeSeconds(inst.ip);
  const occupied = inst.clients.length > 0;
  const fresh = isFresh(age);

  const targeted = $('target').value === `i:${inst.ip}`;
  setClass(card, `inst${occupied ? '' : ' inst-empty'}${age == null ? '' : fresh ? ' inst-fresh' : ' inst-old'}${targeted ? ' inst-targeted' : ''}`);
  setText(e.ageValue, age == null ? '—' : fmtMinutes(age));
  setText(e.chip, age == null ? 'Reading age' : fresh ? 'Fresh' : 'Old');
  setClass(e.chip, age == null ? 'badge' : fresh ? 'badge badge-good' : 'badge badge-warn');

  const pct = age == null ? 0 : Math.min(100, (age / (state.freshMinutes * 60)) * 100);
  const width = `${pct.toFixed(1)}%`;
  if (e.fill.style.width !== width) e.fill.style.width = width;

  const opened = inst.opened_at ? `Opened ${new Date(inst.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Opening time not read yet';
  setText(e.meta, opened);

  if (occupied) {
    const n = inst.clients.length;
    setText(e.who, `${n} client${n === 1 ? '' : 's'}${inst.machines.length ? ' · ' + inst.machines.join(', ') : ''}`);
  }
  else {
    setText(e.who, `Empty · seen ${fmtAgo(serverNow() - inst.last_seen)}`);
  }
  setTitle(e.who, inst.machines.join(', '));
  if (e.target.disabled !== !occupied) e.target.disabled = !occupied;
  if (e.rotate.hidden !== !occupied) e.rotate.hidden = !occupied;
  e.charSelect.disabled = !state.connected;
}

// Newest first - finding fresh instances is the point. Unread ages lead,
// since those clients have only just landed.
function instanceOrder() {
  const key = i => (i.opened_at == null ? Infinity : i.opened_at);
  return [...state.instances.values()].sort((a, b) => key(b) - key(a) || a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

function renderInstances() {
  const list = instanceOrder();
  list.forEach((inst, index) => {
    let card = instEls.get(inst.ip);
    if (!card) {
      card = createInstanceCard(inst.ip);
      instEls.set(inst.ip, card);
    }
    updateInstanceCard(card, inst);
    if (instGrid.children[index] !== card) instGrid.insertBefore(card, instGrid.children[index] || null);
  });
  for (const [ip, card] of instEls) {
    if (!state.instances.has(ip)) {
      card.remove();
      instEls.delete(ip);
    }
  }
  $('inst-empty').hidden = list.length > 0;
  const occupied = list.filter(i => i.clients.length > 0).length;
  setText($('inst-sub'), list.length
    ? `${occupied} occupied${list.length > occupied ? ` · ${list.length - occupied} recently left` : ''} · fresh under ${state.freshMinutes} min`
    : '');
}

instGrid.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-inst-action]');
  if (!button || button.disabled) return;
  const ip = button.closest('.inst').dataset.ip;
  if (button.dataset.instAction === 'copy') {
    try {
      await navigator.clipboard.writeText(ip);
      button.classList.add('done');
      setTimeout(() => button.classList.remove('done'), 1200);
    } catch { /* clipboard needs https or localhost */ }
    return;
  }
  if (button.dataset.instAction === 'charselect') {
    const inst = state.instances.get(ip);
    const keep = parseInt(button.closest('.inst')._els.keep.value, 10);
    if (!inst || !(keep >= 0 && keep <= 100)) return;
    const n = Math.max(0, inst.clients.length - keep);
    if (n === 0) return;
    if (await confirmAction(`Send ${n} of ${inst.clients.length} client${inst.clients.length === 1 ? '' : 's'} on ${ip} ` +
      `to character select, keeping the ${Math.min(keep, inst.clients.length)} that have been there longest?`)) {
      send({ type: 'char_select_rest', server_ip: ip, keep });
    }
    return;
  }
  const select = $('target');
  if ([...select.options].some(o => o.value === `i:${ip}`)) {
    select.value = `i:${ip}`;
    select.dispatchEvent(new Event('change'));
    select.focus();
  }
});

// ------------------------------------------------------------------ squads

const SOURCE_LABEL = {
  not_in_eotm: 'Ours, not in EotM',
  elsewhere: 'Not on our instances',
  unknown: 'Unknown'
};

let squadSignature = '';

// Members grouped by where they are: each instance first (biggest first),
// then the ones we cannot place.
function squadBuckets(squad) {
  const buckets = new Map();
  for (const m of squad.members) {
    const key = m.instance ? `i:${m.instance}` : `s:${m.instance_source}`;
    if (!buckets.has(key)) buckets.set(key, { ip: m.instance, source: m.instance_source, members: [] });
    buckets.get(key).members.push(m);
  }
  const order = { not_in_eotm: 1, elsewhere: 2, unknown: 3 };
  return [...buckets.values()].sort((a, b) => {
    if (!!a.ip !== !!b.ip) return a.ip ? -1 : 1;
    if (a.ip) return b.members.length - a.members.length;
    return (order[a.source] || 9) - (order[b.source] || 9);
  });
}

function memberChip(m) {
  const chip = el('span', `member${m.client != null ? ' ours' : ''}${m.commander ? ' cmdr' : ''}${m.lieutenant ? ' lt' : ''}`);
  const role = m.commander ? 'Commander' : m.lieutenant ? 'Lieutenant' : null;
  chip.title = [m.account, m.subgroup ? `subgroup ${m.subgroup}` : null, role, m.client != null ? 'one of our clients' : null]
    .filter(Boolean).join(' · ');
  if (m.commander || m.lieutenant) chip.appendChild(el('span', 'member-role', m.commander ? '★' : '☆'));
  chip.appendChild(el('span', 'member-name', m.character || m.account));
  return chip;
}

function renderSquads() {
  const list = $('squad-list');
  const squads = state.squads;
  // Ages tick separately; rebuild only when membership or placement changes.
  const signature = JSON.stringify(squads.map(s => [s.id, s.count, s.complete, s.reporters,
    s.members.map(m => [m.account, m.character, m.subgroup, m.commander, m.lieutenant, m.client, m.instance, m.instance_source])]));
  if (signature !== squadSignature) {
    squadSignature = signature;
    list.replaceChildren(...squads.map(squadCard));
  }
  updateSquadAges();

  $('squad-empty').hidden = squads.length > 0;
  const ours = squads.reduce((n, s) => n + s.members.filter(m => m.client != null).length, 0);
  const pending = [...state.clients.values()].reduce((n, c) => n + (c.pending_invites || []).length, 0);
  setText($('squad-sub'), [
    squads.length ? `${squads.length} group${squads.length === 1 ? '' : 's'} · ${ours} of our clients` : '',
    pending ? `${pending} pending invite${pending === 1 ? '' : 's'}` : ''
  ].filter(Boolean).join(' · '));
}

function squadCard(squad) {
  const card = el('article', 'squad');
  const head = el('header', 'squad-head');
  const title = el('div', 'squad-title');
  title.append(
    el('span', `squad-kind kind-${squad.type}`, squad.type === 'party' ? 'Party' : 'Squad'),
    el('strong', null, squad.commander || 'No commander')
  );
  const ours = squad.members.filter(m => m.client != null).length;
  const meta = el('span', 'squad-meta', `${squad.count} member${squad.count === 1 ? '' : 's'} · ${ours} ours`);
  title.appendChild(meta);
  if (!squad.complete) {
    const partial = el('span', 'badge badge-warn', `${squad.members.length} of ${squad.count} known`);
    partial.title = 'Read through RTAPI, which reports members only as they join, leave or change. Clients reading the group from game memory always report it whole.';
    title.appendChild(partial);
  }
  head.appendChild(title);
  if (squad.type === 'squad' && squad.commander_account) {
    const join = el('button', 'btn btn-xs', 'Target joins');
    join.type = 'button';
    join.dataset.cmd = 'sqjoin';
    join.dataset.name = squad.commander_account;
    join.title = `The clients in "Send to" join ${squad.commander}'s squad`;
    head.appendChild(join);
  }
  card.appendChild(head);

  const buckets = el('div', 'squad-buckets');
  for (const b of squadBuckets(squad)) {
    const bucket = el('div', `squad-bucket${b.ip ? '' : ' unplaced'}`);
    const bh = el('div', 'bucket-head');
    if (b.ip) {
      bh.appendChild(el('span', 'bucket-ip', b.ip));
      const age = el('span', 'badge');
      age.dataset.ageIp = b.ip;
      bh.appendChild(age);
    }
    else {
      bh.appendChild(el('span', 'bucket-label', SOURCE_LABEL[b.source] || b.source));
    }
    bh.appendChild(el('span', 'bucket-count', String(b.members.length)));
    // "Join in map" goes through a member on that instance; any one will do,
    // but one of theirs keeps working after our own client there leaves.
    const via = b.ip && (b.members.find(m => m.client == null) || b.members[0]);
    if (via) {
      const join = el('button', 'btn btn-flat btn-xs bucket-join', 'Join here');
      join.type = 'button';
      join.dataset.cmd = 'join_in_map';
      join.dataset.name = via.account;
      join.title = `The clients in "Send to" join ${via.character || via.account}'s instance (${b.ip}). They must be in this ${squad.type}.`;
      bh.appendChild(join);
    }
    const members = el('div', 'bucket-members');
    b.members.forEach(m => members.appendChild(memberChip(m)));
    bucket.append(bh, members);
    buckets.appendChild(bucket);
  }
  card.appendChild(buckets);
  return card;
}

function updateSquadAges() {
  document.querySelectorAll('[data-age-ip]').forEach(chip => {
    const age = instanceAgeSeconds(chip.dataset.ageIp);
    setText(chip, age == null ? 'age unknown' : `${fmtMinutes(age)} · ${isFresh(age) ? 'fresh' : 'old'}`);
    setClass(chip, age == null ? 'badge' : isFresh(age) ? 'badge badge-good' : 'badge badge-warn');
  });
}

// Ages and "last seen" tick between snapshots.
setInterval(() => {
  for (const [key, tr] of rowEls) {
    const c = key.startsWith('c:') ? state.clients.get(Number(key.slice(2))) : null;
    if (c) updateClientRow(tr, c);
  }
  if (state.groupBy === 'instance') renderRows();
  renderInstances();
  renderTiles();
  updateSquadAges();
}, 1000);

// ------------------------------------------------------------------ targets

let targetSignature = '';

function targetOptions() {
  const all = [...state.clients.values()];
  const count = (list) => list.length;
  const machines = new Map();
  const ips = new Map();
  for (const c of all) {
    if (c.machine) machines.set(c.machine, (machines.get(c.machine) || 0) + 1);
    if (c.server_ip) ips.set(c.server_ip, (ips.get(c.server_ip) || 0) + 1);
  }
  const opts = [
    { value: 'sel', label: `Selected (${state.selected.size})`, disabled: state.selected.size === 0 },
    { value: 'all', label: `All clients (${count(all)})` }
  ];
  const sorted = (m) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  const machineOpts = sorted(machines).map(([name, n]) => ({ value: `m:${name}`, label: `${name} (${n})` }));
  const ipOpts = sorted(ips).map(([ip, n]) => ({ value: `i:${ip}`, label: `${ip} (${n})` }));
  return { opts, machineOpts, ipOpts };
}

function renderTargets() {
  const select = $('target');
  const { opts, machineOpts, ipOpts } = targetOptions();
  const signature = JSON.stringify([opts, machineOpts, ipOpts]);
  // Rebuilding while the list is open would close it - only when it changed.
  if (signature !== targetSignature) {
    targetSignature = signature;
    const previous = select.value || 'all';
    select.replaceChildren();
    const add = (parent, o) => {
      const option = el('option', null, o.label);
      option.value = o.value;
      option.disabled = !!o.disabled;
      parent.appendChild(option);
    };
    opts.forEach(o => add(select, o));
    for (const [label, list] of [['Machines', machineOpts], ['Instances', ipOpts]]) {
      if (!list.length) continue;
      const group = el('optgroup');
      group.label = label;
      list.forEach(o => add(group, o));
      select.appendChild(group);
    }
    const stillThere = [...select.options].some(o => o.value === previous && !o.disabled);
    select.value = stillThere ? previous : 'all';
  }
  setText($('target-count'), describeTarget().countText);
}

function currentTarget() {
  const value = $('target').value || 'all';
  if (value === 'sel') return { kind: 'clients', value: [...state.selected] };
  if (value.startsWith('m:')) return { kind: 'machine', value: value.slice(2) };
  if (value.startsWith('i:')) return { kind: 'instance', value: value.slice(2) };
  return { kind: 'all' };
}

function targetClients(target) {
  const all = [...state.clients.values()];
  switch (target.kind) {
    case 'clients': return all.filter(c => target.value.includes(c.id));
    case 'machine': return all.filter(c => c.machine === target.value);
    case 'instance': return all.filter(c => c.server_ip === target.value);
    default: return all;
  }
}

function describeTarget(target = currentTarget()) {
  const n = targetClients(target).length;
  return { n, countText: `${n} client${n === 1 ? '' : 's'}` };
}

$('target').addEventListener('change', () => {
  setText($('target-count'), describeTarget().countText);
  renderInstances();
  updateActionState();
});

function updateActionState() {
  const targets = targetClients(currentTarget());
  const usable = state.connected && targets.length > 0;
  document.querySelectorAll('[data-cmd]').forEach(b => { b.disabled = !usable; });
  $('keep-instance').disabled = !state.connected;
  $('keep-machine').disabled = !state.connected;

  // Show the current setting when every targeted client agrees on it.
  const common = (values) => values.length && values.every(v => v === values[0]) ? values[0] : null;
  const pacer = common(targets.map(c => String(!!c.pacer_patch)));
  document.querySelectorAll('[data-enabled]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.enabled === pacer));
  });
  const auto = common(targets.map(c => {
    const a = c.auto_accept || {};
    return a.party && a.squad ? 'both' : a.squad ? 'squad' : 'off';
  }));
  document.querySelectorAll('[data-auto]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.auto === auto));
  });
}

// ------------------------------------------------------------------ close menu

const closeMenuEl = $('close-menu');

function closeMenu() {
  closeMenuEl.open = false;
}

document.addEventListener('click', (event) => {
  if (closeMenuEl.open && !closeMenuEl.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && closeMenuEl.open) {
    closeMenu();
    closeMenuEl.querySelector('summary').focus();
  }
});

// ------------------------------------------------------------------ selection

function setSelected(ids, on) {
  for (const id of ids) {
    if (on) state.selected.add(id);
    else state.selected.delete(id);
  }
  // Selecting rows makes them the target; clearing goes back to everyone.
  const select = $('target');
  if (state.selected.size > 0 && select.value === 'all') {
    targetSignature = '';
    renderTargets();
    select.value = 'sel';
  }
  else if (state.selected.size === 0 && select.value === 'sel') {
    targetSignature = '';
    renderTargets();
    select.value = 'all';
  }
  render();
}

rowsEl.addEventListener('change', (event) => {
  const box = event.target;
  if (box.type !== 'checkbox') return;
  const tr = box.closest('tr');
  if (tr.classList.contains('group-row')) setSelected(tr._members || [], box.checked);
  else setSelected([Number(tr.dataset.id)], box.checked);
});

$('select-all').addEventListener('change', (event) => {
  const shown = layoutRows().filter(r => r.client).map(r => r.client.id);
  setSelected(shown, event.target.checked);
});

// ------------------------------------------------------------------ commands

function confirmAction(text) {
  return new Promise((resolve) => {
    const dialog = $('confirm');
    setText($('confirm-text'), text);
    dialog.returnValue = '';
    // The submit event carries the button and fires at once; 'close' covers
    // Escape. Whichever comes first answers (the second resolve is a no-op).
    const form = dialog.querySelector('form');
    const onSubmit = (event) => resolve(!!event.submitter && event.submitter.value === 'ok');
    form.addEventListener('submit', onSubmit, { once: true });
    dialog.addEventListener('close', () => {
      form.removeEventListener('submit', onSubmit);
      resolve(dialog.returnValue === 'ok');
    }, { once: true });
    dialog.showModal();
    $('confirm-ok').focus();
  });
}

function buildCommand(button) {
  const type = button.dataset.cmd;
  const command = { type };
  if (type === 'set_pacer_patch') command.enabled = button.dataset.enabled === 'true';
  if (type === 'set_auto_accept') {
    const auto = button.dataset.auto;
    command.squad = auto !== 'off';
    command.party = auto === 'both';
  }
  if (type === 'invite' || type === 'sqinvite' || type === 'sqjoin' || type === 'join_in_map') {
    const name = (button.dataset.name || $('group-name').value).trim();
    if (!name || name.length > 64 || /[\r\n\/]/.test(name)) {
      $('group-name').focus();
      return null;
    }
    command.name = name;
  }
  if (type === 'set_view_distance') {
    const percent = parseInt($('view').value, 10);
    if (!(percent >= 0 && percent <= 100)) {
      $('view').focus();
      return null;
    }
    command.percent = percent;
  }
  if (type === 'set_memory_limit') {
    const mb = parseInt($('mem').value, 10);
    if (!(mb >= 256 && mb <= 32768)) {
      $('mem').focus();
      return null;
    }
    command.mb = mb;
  }
  if (type === 'set_fps') {
    const fps = parseInt($('fps').value, 10);
    if (!(fps >= 1 && fps <= 200)) {
      $('fps').focus();
      return null;
    }
    command.fps = fps;
  }
  return command;
}

async function runCommand(command, target) {
  const { n } = describeTarget(target);
  if (n === 0) return;
  if (command.type === 'go_to_character_select' && n > 1 &&
    !(await confirmAction(`Send ${n} clients to character select?`))) return;
  if (command.type === 'close' && !(await confirmAction(`Close the game on ${n} client${n === 1 ? '' : 's'}?`))) return;
  send({ type: 'command', target, command });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-cmd]');
  if (!button || button.disabled) return;
  closeMenu();
  const command = buildCommand(button);
  if (command) runCommand(command, currentTarget());
});

rowsEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-row-action]');
  if (!button) return;
  const id = Number(button.closest('tr').dataset.id);
  const type = { focus: 'bring_to_front', enter: 'enter_map', charselect: 'go_to_character_select', close: 'close' }[button.dataset.rowAction];
  runCommand({ type }, { kind: 'clients', value: [id] });
});

function excessCount(keyOf, keep) {
  const groups = new Map();
  for (const c of state.clients.values()) {
    const key = keyOf(c);
    if (key) groups.set(key, (groups.get(key) || 0) + 1);
  }
  let n = 0;
  for (const size of groups.values()) n += Math.max(0, size - keep);
  return n;
}

$('keep-instance').addEventListener('click', async () => {
  closeMenu();
  const n = excessCount(c => c.server_ip, 2);
  if (n === 0) return;
  if (await confirmAction(`Close ${n} client${n === 1 ? '' : 's'} so that at most 2 stay on each instance?`)) {
    send({ type: 'close_excess', keep_count: 2 });
  }
});

$('keep-machine').addEventListener('click', async () => {
  closeMenu();
  const n = excessCount(c => c.machine, 5);
  if (n === 0) return;
  if (await confirmAction(`Close ${n} client${n === 1 ? '' : 's'} so that at most 5 stay on each machine?`)) {
    send({ type: 'keep_per_machine', keep_count: 5 });
  }
});

// ------------------------------------------------------------------ search & grouping

$('search').addEventListener('input', (event) => {
  state.filter = event.target.value.trim().toLowerCase();
  renderRows();
});

function renderGroupButtons() {
  document.querySelectorAll('[data-group]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.group === state.groupBy));
  });
}

document.querySelector('.seg-quiet').addEventListener('click', (event) => {
  const button = event.target.closest('[data-group]');
  if (!button) return;
  state.groupBy = button.dataset.group;
  savePref('groupBy', state.groupBy);
  renderGroupButtons();
  renderRows();
});

// ------------------------------------------------------------------ activity feed

function eventItem(e) {
  const li = el('li');
  const time = el('time', null, new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  time.dateTime = new Date(e.t).toISOString();
  li.append(time, el('span', `lvl lvl-${e.level}`), el('span', 'text', e.text));
  return li;
}

function addEvent(e, newestFirst) {
  const list = $('events');
  if (newestFirst) list.prepend(eventItem(e));
  else list.appendChild(eventItem(e));
  while (list.children.length > EVENT_LIMIT) list.lastChild.remove();
}

function resetEvents(history) {
  $('events').replaceChildren();
  for (let i = history.length - 1; i >= 0; i--) addEvent(history[i], false);
}

// ------------------------------------------------------------------ start

renderGroupButtons();
render();
connect();
