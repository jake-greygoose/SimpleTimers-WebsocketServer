const MAX_MAP_AGE_SECONDS = 30 * 24 * 60 * 60;
function validIp(ip) {
  if (typeof ip !== 'string') return false;
  const octets = ip.split('.');
  return octets.length === 4 && octets.every(o => /^(0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255) &&
    Number(octets[0]) > 0 && Number(octets[0]) < 224 && Number(octets[0]) !== 127;
}
function statusLocation(data) {
  const activeIp = data.game_state === 'gameplay' && data.map === 'eotm' &&
    data.in_eotm === true && validIp(data.server_ip) ? data.server_ip : null;
  const loading = data.game_state === 'loading' && validIp(data.loading_server_ip) &&
    Number.isInteger(data.loading_map_id) && data.loading_map_id > 0 && data.loading_map_id <= 65535;
  return { activeIp, loadingIp: loading ? data.loading_server_ip : null,
    loadingMapId: loading ? data.loading_map_id : null };
}
function validMapAge(age) {
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 && age <= MAX_MAP_AGE_SECONDS;
}
function acceptMapAge(client, data) {
  return client.game_state === 'gameplay' && client.map === 'eotm' && validIp(client.server_ip) &&
    validMapAge(data.map_age_s) &&
    (data.server_ip === undefined || data.server_ip === client.server_ip);
}
module.exports = { validIp, statusLocation, validMapAge, acceptMapAge };
