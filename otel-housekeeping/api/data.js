const { verifySupabaseAccessToken } = require('../lib/supabase-auth');
const { getRecord, listRecords, saveRecord, patchRecord, deleteRecord } = require('../lib/supabase');

const roles = new Set(['admin', 'supervisor', 'housekeeper', 'front_desk', 'maintenance']);
const roomStatusPermissions = {
  admin: new Set(['clean', 'dirty', 'progress', 'inspect', 'broken']),
  supervisor: new Set(['clean', 'dirty', 'progress', 'inspect']),
  housekeeper: new Set(['progress']),
  front_desk: new Set(['clean', 'dirty'])
};
const collectionNames = new Set([
  'rooms', 'issues', 'guest_requests', 'users', 'settings', 'cafe_products',
  'reservations', 'room_status_logs', 'manual_notification_logs'
]);

function parseRequest(req) {
  const url = new URL(req.url, 'https://localhost');
  return {
    collection: url.searchParams.get('collection') || '',
    id: url.searchParams.get('id') || '',
    collections: (url.searchParams.get('collections') || '').split(',').filter(Boolean)
  };
}

async function authenticate(req, method, params, body) {
  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) {
    const error = new Error('Oturum doğrulanamadı.');
    error.status = 401;
    throw error;
  }
  const user = await verifySupabaseAccessToken(authorization.slice(7));
  let profile = await getRecord('users', user.id);
  if (!profile && user.email && user.email_confirmed_at) {
    const users = await listRecords('users');
    const legacyProfile = Object.entries(users).find(([id, item]) =>
      id !== user.id && String(item.email || '').trim().toLowerCase() === user.email.toLowerCase()
    );
    if (legacyProfile) {
      profile = await saveRecord('users', user.id, legacyProfile[1]);
      await deleteRecord('users', legacyProfile[0]);
    }
  }
  const collection = body?.collection || params.collection;
  const id = body?.id || params.id;
  const selfProfileRead = method === 'GET' && collection === 'users' && id === user.id;
  const firstProfileWrite = method === 'PUT' && collection === 'users' && id === user.id
    && !profile && body && typeof body === 'object';
  if (!profile && !selfProfileRead && !firstProfileWrite) {
    const error = new Error('Personel profili bulunamadı.');
    error.status = 403;
    throw error;
  }
  if (profile && (!roles.has(profile.role) || profile.is_active === false)
    && !selfProfileRead && !firstProfileWrite) {
    const error = new Error('Hesabınıza geçerli bir rol atanmamış.');
    error.status = 403;
    throw error;
  }
  return { uid: user.id, profile, email: user.email || '' };
}

function requireAdmin(actor) {
  if (actor.profile?.role !== 'admin' || actor.profile.is_active === false) {
    const error = new Error('Bu işlem yalnızca admin içindir.');
    error.status = 403;
    throw error;
  }
}

function authorizeWrite(collection, id, actor, method, data, existing) {
  const role = actor.profile?.role;
  if (collection === 'users' || collection === 'settings' || collection === 'reservations'
    || collection === 'manual_notification_logs') return requireAdmin(actor);
  if (collection === 'cafe_products' && !['admin', 'front_desk'].includes(role)) {
    const error = new Error('Cafe ürünlerini yönetme yetkiniz yok.');
    error.status = 403;
    throw error;
  }
  if (collection === 'rooms' && role !== 'admin') {
    const allowedStatuses = roomStatusPermissions[role];
    if (method === 'DELETE' || !existing || !allowedStatuses?.has(data?.statusKey)
      || (existing && data?.roomNumber !== existing.roomNumber)) {
      const error = new Error('Bu oda işlemi için yetkiniz yok.');
      error.status = 403;
      throw error;
    }
  }
  if (collection === 'guest_requests' && !['admin', 'supervisor', 'housekeeper', 'front_desk'].includes(role)) {
    const error = new Error('Misafir taleplerini yönetme yetkiniz yok.');
    error.status = 403;
    throw error;
  }
  if (collection === 'room_status_logs' && !roles.has(role)) {
    const error = new Error('Oda durumu güncelleme yetkiniz yok.');
    error.status = 403;
    throw error;
  }
  if (!['rooms', 'issues', 'guest_requests', 'cafe_products', 'room_status_logs'].includes(collection)) {
    const error = new Error('Bu koleksiyona yazılamaz.');
    error.status = 403;
    throw error;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const method = String(req.method || 'GET').toUpperCase();
  const params = parseRequest(req);
  const body = req.body;
  try {
    const actor = await authenticate(req, method, params, body);
    if (method === 'GET') {
      if (params.collections.length) {
        if (params.collections.some(collection => !collectionNames.has(collection))) {
          return res.status(400).json({ error: 'Geçersiz veri koleksiyonu.' });
        }
        const data = {};
        await Promise.all(params.collections.map(async collection => {
          if (collection === 'reservations') requireAdmin(actor);
          data[collection] = ['users', 'manual_notification_logs'].includes(collection) && actor.profile?.role !== 'admin'
            ? {}
            : await listRecords(collection);
        }));
        return res.status(200).json({ data });
      }
      if (!collectionNames.has(params.collection) || !params.id) {
        return res.status(400).json({ error: 'Koleksiyon ve kayıt kimliği gereklidir.' });
      }
      if (params.collection === 'reservations') requireAdmin(actor);
      if (params.collection === 'manual_notification_logs') requireAdmin(actor);
      if (params.collection === 'users' && params.id !== actor.uid) requireAdmin(actor);
      const data = await getRecord(params.collection, params.id);
      return data
        ? res.status(200).json({ data })
        : res.status(404).json({ error: 'Kayıt bulunamadı.' });
    }

    if (!['PUT', 'PATCH', 'DELETE'].includes(method)) return res.status(405).json({ error: 'Method Not Allowed' });
    const collection = String(body?.collection || params.collection);
    const id = String(body?.id || params.id);
    if (!collectionNames.has(collection) || !id || id.length > 180) {
      return res.status(400).json({ error: 'Geçerli koleksiyon ve kayıt kimliği gereklidir.' });
    }
    if (collection === 'users' && id === actor.uid && method === 'PUT' && !actor.profile) {
      const profile = {
        full_name: String(body.data?.full_name || '').trim().slice(0, 200),
        email: actor.email,
        role: 'pending',
        is_active: false,
        created_at: Date.now()
      };
      if (!profile.full_name) return res.status(400).json({ error: 'Ad soyad gereklidir.' });
      const data = await saveRecord('users', id, profile);
      return res.status(200).json({ data });
    }
    const existing = await getRecord(collection, id);
    const data = method === 'DELETE' ? undefined : body?.data;
    if (method !== 'DELETE' && (!data || typeof data !== 'object' || Array.isArray(data))) {
      return res.status(400).json({ error: 'Kayıt verisi geçersiz.' });
    }
    authorizeWrite(collection, id, actor, method, data, existing);
    if (method === 'DELETE') {
      await deleteRecord(collection, id);
      return res.status(200).json({ ok: true });
    }
    if (method === 'PATCH' && !existing && collection !== 'settings') {
      return res.status(404).json({ error: 'Kayıt bulunamadı.' });
    }
    const stampedData = {
      ...(method === 'PATCH' || collection === 'rooms' ? existing || {} : {}),
      ...data,
      updatedAt: Date.now(),
      updatedBy: actor.uid
    };
    const saved = method === 'PATCH' && existing
      ? await patchRecord(collection, id, stampedData)
      : await saveRecord(collection, id, stampedData);
    return res.status(200).json({ data: saved });
  } catch (error) {
    console.error('Supabase housekeeping API isteği başarısız:', error);
    const status = Number(error.status) || (error.code?.startsWith('auth/') ? 401 : 500);
    return res.status(status).json({
      error: status >= 500 ? 'Veri işlemi tamamlanamadı.' : error.message,
      code: error.code || undefined
    });
  }
};
