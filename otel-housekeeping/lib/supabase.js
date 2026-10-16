const housekeepingCollections = new Set(['users', 'settings', 'reservations', 'manual_notification_logs']);
const hotelRecordCollections = new Set(['issues', 'guest_requests', 'cafe_products', 'push_subscriptions', 'room_status_logs']);

function getConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Supabase sunucu ortam değişkenleri tanımlı değil.');
  return { supabaseUrl, serviceRoleKey };
}

async function restRequest(table, query, options = {}) {
  const { supabaseUrl, serviceRoleKey } = getConfig();
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Supabase ${table} yanıtı geçerli JSON değil.`, { cause: error });
    }
  }
  if (!response.ok) {
    const error = new Error(data?.message || `Supabase ${table} isteği başarısız (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function tableFor(collection) {
  if (collection === 'rooms') return 'hotel_rooms';
  if (housekeepingCollections.has(collection)) return 'housekeeping_records';
  if (hotelRecordCollections.has(collection)) return 'hotel_records';
  throw new Error('Geçersiz veri koleksiyonu.');
}

async function listRecords(collection) {
  const table = tableFor(collection);
  const isRoom = collection === 'rooms';
  const rows = await restRequest(table, {
    select: isRoom ? 'room_id,data' : 'record_id,data',
    ...(isRoom ? {} : { collection: `eq.${collection}` }),
    order: isRoom ? 'room_id.asc' : 'record_id.asc'
  });
  return Object.fromEntries(rows.map(row => [isRoom ? row.room_id : row.record_id, row.data]));
}

async function getRecord(collection, id) {
  const table = tableFor(collection);
  const isRoom = collection === 'rooms';
  const rows = await restRequest(table, {
    select: 'data',
    ...(isRoom ? { room_id: `eq.${id}` } : { collection: `eq.${collection}`, record_id: `eq.${id}` }),
    limit: '1'
  });
  return rows[0]?.data || null;
}

async function saveRecord(collection, id, data) {
  const table = tableFor(collection);
  const isRoom = collection === 'rooms';
  const query = { on_conflict: isRoom ? 'room_id' : collection === 'users' || collection === 'settings' || collection === 'reservations' ? 'collection,record_id' : 'collection,parent_id,record_id' };
  const record = isRoom
    ? { room_id: id, data, updated_at: new Date().toISOString() }
    : collection === 'users' || collection === 'settings' || collection === 'reservations'
      ? { collection, record_id: id, data, updated_at: new Date().toISOString() }
      : { collection, record_id: id, parent_id: '', data, updated_at: new Date().toISOString() };
  const rows = await restRequest(table, query, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(record)
  });
  return rows?.[0]?.data || data;
}

async function patchRecord(collection, id, patch) {
  const existing = await getRecord(collection, id);
  if (!existing) {
    const error = new Error('Kayıt bulunamadı.');
    error.status = 404;
    throw error;
  }
  return saveRecord(collection, id, { ...existing, ...patch });
}

async function deleteRecord(collection, id) {
  const table = tableFor(collection);
  const isRoom = collection === 'rooms';
  return restRequest(table, isRoom
    ? { room_id: `eq.${id}` }
    : { collection: `eq.${collection}`, record_id: `eq.${id}`, ...(hotelRecordCollections.has(collection) ? { parent_id: 'eq.' } : {}) }, {
    method: 'DELETE'
  });
}

module.exports = { getRecord, listRecords, saveRecord, patchRecord, deleteRecord };
