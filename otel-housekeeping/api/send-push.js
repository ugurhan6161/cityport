const admin = require('firebase-admin');
const crypto = require('node:crypto');
const { getFirebaseAdmin } = require('../lib/firebase-admin');
const { getRecord, listRecords, saveRecord } = require('../lib/supabase');

const TIME_ZONE = 'Europe/Istanbul';

function getDatabase() {
  return getFirebaseAdmin().database();
}

async function authorizeRequest(req, database) {
  const expected = process.env.PUSH_API_SECRET;
  const authorization = req.headers.authorization || '';
  if (expected && authorization === `Bearer ${expected}`) return { type: 'scheduler' };
  if (!authorization.startsWith('Bearer ')) throw new Error('Unauthorized');
  const decoded = await getFirebaseAdmin().auth().verifyIdToken(authorization.slice(7));
  const profile = await getRecord('users', decoded.uid);
  if (profile?.role !== 'admin' || profile?.is_active === false) throw new Error('Admin yetkisi gerekli.');
  return { type: 'admin', uid: decoded.uid };
}

function todayInIstanbul() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function istanbulDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function records(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
}

function isActiveReservation(reservation) {
  if (!reservation || reservation.active === false || reservation.isActive === false) return false;
  return !['cancelled', 'canceled', 'completed', 'checked_out', 'closed'].includes(String(reservation.status || '').toLowerCase());
}

function roomOf(reservation) {
  return String(reservation.room ?? reservation.roomNumber ?? reservation.roomId ?? '').trim();
}

function tokenOf(value, id) {
  if (typeof value === 'string') return { id, token: value };
  if (!value || value.active === false) return null;
  const token = value.token || value.fcmToken || value.registrationToken;
  return token ? { id, token } : null;
}

function tokensForRoom(root, room) {
  const candidates = [root.fcmTokens?.[room], root.fcm_tokens?.[room], root.pushTokens?.[room]];
  const subscriptions = Object.entries(root.push_subscriptions || {})
    .filter(([, value]) => String(value?.roomNumber || '').trim() === String(room).trim())
    .map(([id, value]) => [id, value]);
  return [...candidates.flatMap(records), ...subscriptions]
    .map(([id, value]) => tokenOf(value, id)).filter(Boolean)
    .filter((entry, index, list) => list.findIndex(item => item.token === entry.token) === index);
}

function messageFor(room, hotelName = 'Cityport Hotel') {
  return {
    room,
    title: hotelName,
    body: 'TR: Bugün çıkış gününüz. Lütfen odanızı saat 12:00\'ye kadar boşaltmanız ricadır.\n\nEN: Today is your checkout day. Please vacate your room by 12:00.',
    url: '/'
  };
}

async function sendForRoom(db, root, room, checkoutDate, request) {
  const logRef = db.ref(`push_send_logs/${checkoutDate}/${encodeURIComponent(room)}`);
  const claimId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const claim = await logRef.transaction(current => current || {
    room,
    checkoutDate,
    sentAt: Date.now(),
    result: 'processing',
    claimId
  });
  if (!claim.committed || claim.snapshot.val()?.claimId !== claimId) return { room, result: 'already_sent' };

  const tokens = tokensForRoom(root, room);
  if (!tokens.length) {
    await logRef.update({ room, checkoutDate, sentAt: admin.database.ServerValue.TIMESTAMP, result: 'no_subscription' });
    return { room, result: 'no_subscription' };
  }

  const message = { ...messageFor(room, root.settings?.hotelName), ...request, room };
  const outcomes = [];
  const inactiveTokenUpdates = [];
  for (let index = 0; index < tokens.length; index += 500) {
    const batch = tokens.slice(index, index + 500);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: batch.map(entry => entry.token),
      data: { title: String(message.title || root.settings?.hotelName || 'Cityport Hotel'), body: String(message.body), room: String(room), checkoutDate, url: message.url || '/' },
      webpush: { fcmOptions: { link: message.url || '/' } }
    });
    response.responses.forEach((delivery, deliveryIndex) => {
      const entry = batch[deliveryIndex];
      const errorCode = delivery.error?.code;
      const invalid = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(errorCode);
      outcomes.push({ id: entry.id, result: delivery.success ? 'sent' : `error_${errorCode || 'unknown'}` });
      if (invalid) inactiveTokenUpdates.push(markTokenInactive(db, room, entry.id));
    });
  }
  await Promise.all(inactiveTokenUpdates);
  const result = outcomes.some(outcome => outcome.result === 'sent') ? 'sent' : 'failed';
  await logRef.update({ room, checkoutDate, sentAt: admin.database.ServerValue.TIMESTAMP, result, deliveries: outcomes });
  return { room, result, deliveries: outcomes.length };
}

async function sendManualForRoom(db, root, room, request, senderUid) {
  const logId = crypto.randomUUID();
  const sentAt = Date.now();
  const tokens = tokensForRoom(root, room);
  if (!tokens.length) {
    await saveRecord('manual_notification_logs', logId, {
      room, sentAt, result: 'no_subscription', title: request.title, body: request.body, sentBy: senderUid
    });
    return { room, result: 'no_subscription' };
  }
  const message = { ...messageFor(room, root.settings?.hotelName), ...request, room };
  const outcomes = [];
  const inactiveTokenUpdates = [];
  for (let index = 0; index < tokens.length; index += 500) {
    const batch = tokens.slice(index, index + 500);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: batch.map(entry => entry.token),
      data: { title: 'Cityport Hotel', body: String(message.body), room: String(room), type: 'manual', url: message.url || '/' },
      webpush: { fcmOptions: { link: message.url || '/' } }
    });
    response.responses.forEach((delivery, deliveryIndex) => {
      const entry = batch[deliveryIndex];
      const errorCode = delivery.error?.code;
      const invalid = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(errorCode);
      outcomes.push({ id: entry.id, result: delivery.success ? 'sent' : `error_${errorCode || 'unknown'}` });
      if (invalid) inactiveTokenUpdates.push(markTokenInactive(db, room, entry.id));
    });
  }
  await Promise.all(inactiveTokenUpdates);
  const result = outcomes.some(outcome => outcome.result === 'sent') ? 'sent' : 'failed';
  await saveRecord('manual_notification_logs', logId, {
    room, sentAt, result, title: message.title, body: message.body, url: message.url, sentBy: senderUid, deliveries: outcomes
  });
  return { room, result, deliveries: outcomes.length };
}

async function markTokenInactive(db, room, id) {
  await Promise.all([
    db.ref(`fcmTokens/${room}/${id}/active`).set(false),
    db.ref(`fcm_tokens/${room}/${id}/active`).set(false),
    db.ref(`pushTokens/${room}/${id}/active`).set(false),
    db.ref(`push_subscriptions/${id}/active`).set(false)
  ]);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const database = getDatabase();
    const actor = await authorizeRequest(req, database);
    const dateParts = todayInIstanbul();
    const checkoutDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const [fcmTokens, fcmTokensLegacy, pushTokens, pushSubscriptions, hotelSettings, reservations] = await Promise.all([
      database.ref('fcmTokens').once('value'),
      database.ref('fcm_tokens').once('value'),
      database.ref('pushTokens').once('value'),
      database.ref('push_subscriptions').once('value'),
      getRecord('settings', 'main'),
      listRecords('reservations')
    ]);
    const root = {
      fcmTokens: fcmTokens.val() || {},
      fcm_tokens: fcmTokensLegacy.val() || {},
      pushTokens: pushTokens.val() || {},
      push_subscriptions: pushSubscriptions.val() || {},
      settings: hotelSettings || {},
      reservations
    };
    const requestedRoom = String(req.body?.room || '').trim();
    const requestedRooms = [...new Set((Array.isArray(req.body?.rooms) ? req.body.rooms : requestedRoom ? [requestedRoom] : []).map(room => String(room).trim()).filter(Boolean))];
    const request = req.body?.body ? { title: req.body.title || root.settings?.hotelName || 'Cityport Hotel', body: req.body.body, url: req.body.url || '/' } : {};
    const rooms = new Set();
    if (actor.type === 'admin' && req.body?.manual === true) {
      if (!requestedRooms.length || !request.body) return res.status(400).json({ error: 'Manuel bildirim için en az bir oda ve mesaj gereklidir.' });
      const results = await Promise.all(requestedRooms.map(room => sendManualForRoom(database, root, room, request, actor.uid)));
      return res.status(200).json({ ok: true, manual: true, results });
    }
    records(root.reservations).forEach(([, reservation]) => {
      if (isActiveReservation(reservation) && istanbulDate(reservation.checkoutDate) === checkoutDate && roomOf(reservation)) rooms.add(roomOf(reservation));
    });
    if (requestedRoom && !rooms.has(requestedRoom)) return res.status(200).json({ ok: true, timezone: TIME_ZONE, checkoutDate, results: [], skipped: 'room_is_not_due_today' });
    const results = await Promise.all([...rooms].map(room => sendForRoom(database, root, room, checkoutDate, request)));
    return res.status(200).json({ ok: true, timezone: TIME_ZONE, checkoutDate, results });
  } catch (error) {
    console.error('Push gönderimi başarısız:', error);
    const code = String(error.code || '');
    const status = code.startsWith('auth/') || error.message === 'Unauthorized'
      ? 401
      : error.message === 'Admin yetkisi gerekli.'
        ? 403
        : 500;
    const errorMessage = code.startsWith('config/')
      ? 'Firebase servis hesabı eksik. Vercel\'de FIREBASE_SERVICE_ACCOUNT_JSON veya FIREBASE_SERVICE_ACCOUNT_BASE64 tanımlayın.'
      : status === 401
        ? 'Oturum doğrulanamadı. Sayfayı yenileyip tekrar deneyin.'
        : status === 403
          ? 'Admin yetkisi gerekli.'
          : 'Push gönderimi başarısız.';
    const errorType = code.startsWith('config/') ? code : code || 'internal-error';
    return res.status(status).json({ error: errorMessage, errorType });
  }
};