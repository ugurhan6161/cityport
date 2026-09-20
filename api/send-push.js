const admin = require('firebase-admin');

const TIME_ZONE = 'Europe/Istanbul';
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://hotelss-5d21e-default-rtdb.firebaseio.com';

function getServiceAccount() {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = encoded || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    const error = new Error('Firebase servis hesabı tanımlı değil.');
    error.code = 'config/missing-service-account';
    throw error;
  }

  try {
    const json = encoded
      ? Buffer.from(encoded, 'base64').toString('utf8')
      : raw.trim().replace(/^\uFEFF/, '');
    let serviceAccount = JSON.parse(json);
    if (typeof serviceAccount === 'string') serviceAccount = JSON.parse(serviceAccount);
    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
      const configError = new Error('Firebase servis hesabı alanları eksik.');
      configError.code = 'config/incomplete-service-account';
      throw configError;
    }
    if (typeof serviceAccount.private_key === 'string') {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    return serviceAccount;
  } catch (error) {
    if (error.code?.startsWith('config/')) throw error;
    const configError = new Error('Firebase servis hesabı JSON olarak okunamadı.');
    configError.code = 'config/invalid-service-account';
    configError.cause = error;
    throw configError;
  }
}

function getDatabase() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()), databaseURL: DATABASE_URL });
  return admin.database();
}

async function authorizeRequest(req, database) {
  const expected = process.env.PUSH_API_SECRET;
  const authorization = req.headers.authorization || '';
  if (expected && authorization === `Bearer ${expected}`) return { type: 'scheduler' };
  if (!authorization.startsWith('Bearer ')) throw new Error('Unauthorized');
  const decoded = await admin.auth().verifyIdToken(authorization.slice(7));
  const profile = await database.ref(`users/${decoded.uid}`).once('value');
  if (profile.val()?.role !== 'admin' || profile.val()?.is_active === false) throw new Error('Admin yetkisi gerekli.');
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

async function sendManualForRoom(db, root, room, request, senderUid) {
  const logRef = db.ref('manual_notification_logs').push();
  const sentAt = admin.database.ServerValue.TIMESTAMP;
  const tokens = tokensForRoom(root, room);
  if (!tokens.length) {
    await logRef.set({ room, sentAt, result: 'no_subscription', title: request.title, body: request.body, sentBy: senderUid });
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
      data: { room: String(room), type: 'manual', url: message.url || '/' },
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
  await logRef.set({ room, sentAt, result, title: message.title, body: message.body, url: message.url, sentBy: senderUid, deliveries: outcomes });
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

  try {
    const database = getDatabase();
    const actor = await authorizeRequest(req, database);
    const dateParts = todayInIstanbul();
    const checkoutDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const rootSnapshot = await database.ref('/').once('value');
    const root = rootSnapshot.val() || {};
    const requestedRoom = String(req.body?.room || '').trim();
    const request = req.body?.body ? { title: req.body.title || root.settings?.hotelName || 'Cityport Hotel', body: req.body.body, url: req.body.url || '/' } : {};
    const rooms = new Set();
    if (actor.type === 'admin' && req.body?.manual === true) {
      if (!requestedRoom || !request.body) return res.status(400).json({ error: 'Manuel bildirim için oda ve mesaj gereklidir.' });
      const result = await sendManualForRoom(database, root, requestedRoom, request, actor.uid);
      return res.status(200).json({ ok: true, manual: true, results: [result] });
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