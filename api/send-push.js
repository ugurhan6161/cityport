const admin = require('firebase-admin');

const TIME_ZONE = 'Europe/Istanbul';
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://hotelss-5d21e-default-rtdb.firebaseio.com';

function getServiceAccount() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON tanımlı değil.');
  return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
}

function getDatabase() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()), databaseURL: DATABASE_URL });
  return admin.database();
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
  return candidates.flatMap(records).map(([id, value]) => tokenOf(value, id)).filter(Boolean)
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
      notification: { title: message.title, body: message.body },
      data: { room: String(room), checkoutDate, url: message.url || '/' },
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

async function markTokenInactive(db, room, id) {
  await Promise.all([
    db.ref(`fcmTokens/${room}/${id}/active`).set(false),
    db.ref(`fcm_tokens/${room}/${id}/active`).set(false),
    db.ref(`pushTokens/${room}/${id}/active`).set(false)
  ]);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const expected = process.env.PUSH_API_SECRET;
  const authorization = req.headers.authorization || '';
  if (!expected || authorization !== `Bearer ${expected}`) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const database = getDatabase();
    const dateParts = todayInIstanbul();
    const checkoutDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const rootSnapshot = await database.ref('/').once('value');
    const root = rootSnapshot.val() || {};
    const requestedRoom = String(req.body?.room || '').trim();
    const request = req.body?.body ? { title: req.body.title, body: req.body.body, url: req.body.url || '/' } : {};
    const rooms = new Set();
    records(root.reservations).forEach(([, reservation]) => {
      if (isActiveReservation(reservation) && istanbulDate(reservation.checkoutDate) === checkoutDate && roomOf(reservation)) rooms.add(roomOf(reservation));
    });
    if (requestedRoom && !rooms.has(requestedRoom)) return res.status(200).json({ ok: true, timezone: TIME_ZONE, checkoutDate, results: [], skipped: 'room_is_not_due_today' });
    const results = await Promise.all([...rooms].map(room => sendForRoom(database, root, room, checkoutDate, request)));
    return res.status(200).json({ ok: true, timezone: TIME_ZONE, checkoutDate, results });
  } catch (error) {
    console.error('Push gönderimi başarısız:', error);
    return res.status(500).json({ error: 'Push gönderimi başarısız.' });
  }
};