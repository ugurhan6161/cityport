const admin = require('firebase-admin');

const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://hotelss-5d21e-default-rtdb.firebaseio.com';

function getServiceAccount() {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = encoded || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const fields = {
    project_id: process.env.FIREBASE_PROJECT_ID,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY
  };
  if (Object.values(fields).every(Boolean)) return { type: 'service_account', ...fields, private_key: fields.private_key.replace(/\\n/g, '\n') };
  if (!raw) throw new Error('Firebase servis hesabı tanımlı değil.');
  const value = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : raw.trim().replace(/^\uFEFF/, '');
  const serviceAccount = typeof value === 'string' ? JSON.parse(value) : value;
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) throw new Error('Firebase servis hesabı alanları eksik.');
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  return serviceAccount;
}

function getDatabase() {
  if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()), databaseURL: DATABASE_URL });
  return admin.database();
}

function productsFrom(value) {
  return Object.entries(value || {})
    .map(([id, product]) => ({ id, ...product }))
    .filter(product => product.active === true)
    .sort((first, second) => (Number(first.sortOrder) || 0) - (Number(second.sortOrder) || 0) || (Number(first.createdAt) || 0) - (Number(second.createdAt) || 0));
}

function validOrder(body) {
  return body && String(body.roomNumber || '').trim() && String(body.guestName || '').trim() && Array.isArray(body.items) && body.items.length && Number.isFinite(Number(body.total)) && Number(body.total) >= 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    try {
      const snapshot = await getDatabase().ref('cafe_products').once('value');
      return res.status(200).json({ products: productsFrom(snapshot.val()) });
    } catch (error) {
      console.error('Cafe ürünleri okunamadı:', error);
      return res.status(500).json({ error: 'Cafe ürünleri alınamadı.' });
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!validOrder(req.body)) return res.status(400).json({ error: 'Geçerli bir cafe siparişi gereklidir.' });
  try {
    const body = req.body;
    const order = {
      requestType: 'cafe',
      roomNumber: String(body.roomNumber).trim(),
      guestName: String(body.guestName).trim(),
      items: body.items,
      total: Number(body.total),
      currency: String(body.currency || 'TRY').trim().toUpperCase(),
      status: 'waiting',
      description: String(body.description || '').trim(),
      createdAt: admin.database.ServerValue.TIMESTAMP,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    };
    const reference = await getDatabase().ref('guest_requests').push(order);
    return res.status(201).json({ ok: true, id: reference.key });
  } catch (error) {
    console.error('Cafe siparişi kaydedilemedi:', error);
    return res.status(500).json({ error: 'Cafe siparişi kaydedilemedi.' });
  }
};