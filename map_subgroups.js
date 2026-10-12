// Pure planning: no sends, no squad creation, and only settled EotM clients.
// Public subgroup numbers are 1..15. Unknown roster data never claims a slot.
function planMapSubgroups(squads, clients, previous = new Map(), selected = null) {
  const moves = [], assignments = [], warnings = [];
  const next = new Map();
  for (const squad of squads) {
    if (squad.type !== 'squad' || !squad.id || !squad.complete) continue;
    const currentMember = m => {
      const c = clients.get(m.client);
      return c && c.group_source === 'game' && c.group &&
        c.group.type === 'squad' && c.group.id === squad.id;
    };
    const eligible = m => {
      const c = clients.get(m.client);
      return currentMember(m) && (!selected || selected.has(c.id)) && c.map === 'eotm' &&
        c.game_state === 'gameplay' && c.group_source === 'game' && c.server_ip && c.portal_available && c.squad_actions_available;
    };
    const participants = squad.members.filter(eligible);
    if (!participants.length) continue;
    if (squad.members.some(m => !Number.isInteger(m.subgroup) || m.subgroup < 1 || m.subgroup > 15)) {
      warnings.push({ squad: squad.id, reason: 'subgroup_membership_unknown' });
      continue;
    }
    const cohorts = new Map();
    const occupied = new Map();
    for (const m of squad.members) {
      const occupants = occupied.get(m.subgroup) || [];
      occupants.push(m); occupied.set(m.subgroup, occupants);
    }
    for (const m of participants) {
      const ip = clients.get(m.client).server_ip;
      const cohort = cohorts.get(ip) || [];
      cohort.push(m); cohorts.set(ip, cohort);
    }
    const allocated = new Map(), used = new Set();
    const moveStart = moves.length, assignmentStart = assignments.length;
    let failed = false;
    const old = previous.get(squad.id) || new Map();
    // Stable order keeps first-time assignments deterministic across reporters.
    for (const [ip, members] of [...cohorts].sort(([a], [b]) => a.localeCompare(b))) {
      const safe = subgroup => subgroup >= 1 && subgroup <= 15 && !used.has(subgroup) &&
        (occupied.get(subgroup) || []).every(m => {
          const c = clients.get(m.client);
          return eligible(m) || currentMember(m) && c.map === 'eotm' && c.game_state === 'gameplay' && c.server_ip === ip;
        });
      const candidates = [old.get(ip), ...members.map(m => m.subgroup),
        ...Array.from({ length: 15 }, (_, i) => i + 1)];
      const subgroup = candidates.find(safe);
      if (!subgroup) {
        warnings.push({ squad: squad.id, instance: ip, reason: 'no_free_subgroup' });
        failed = true;
        break;
      }
      used.add(subgroup); allocated.set(ip, subgroup);
      assignments.push({ squad: squad.id, instance: ip, subgroup });
      for (const m of members) {
        if (m.subgroup !== subgroup) moves.push({ client: m.client, subgroup, expected_server_ip: ip, expected_squad_id: squad.id });
      }
    }
    if (failed) {
      moves.length = moveStart; assignments.length = assignmentStart;
      continue;
    }
    next.set(squad.id, allocated);
  }
  return { moves, assignments, warnings, next };
}
module.exports = { planMapSubgroups };
