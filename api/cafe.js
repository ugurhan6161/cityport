const crypto = require('node:crypto');
const { listRecords, saveRecord } = require('../lib/supabase');

function productsFrom(value) {
  return Object.entries(value || {})
    .map(([id, product]) => ({ id, ...product }))
    .filter(product => product.active === true)
    .sort((first, second) => (Number(first.sortOrder) || 0) - (Number(second.sortOrder) || 0) || (Number(first.createdAt) || 0) - (Number(second.createdAt) || 0));
}

function validOrder(body) {
  return body && String(body.roomNumber || '').trim() && String(body.guestName || '').trim()
    && Array.isArray(body.items) && body.items.length
    && Number.isFinite(Number(body.total)) && Number(body.total) >= 0;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    try {
      const products = await listRecords('cafe_products');
      return res.status(200).json({ products: productsFrom(products) });
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
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const id = crypto.randomUUID();
    await saveRecord('guest_requests', id, order);
    return res.status(201).json({ ok: true, id });
  } catch (error) {
    console.error('Cafe siparişi kaydedilemedi:', error);
    return res.status(500).json({ error: 'Cafe siparişi kaydedilemedi.' });
  }
};
