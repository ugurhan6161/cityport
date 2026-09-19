const DEFAULT_CONFIG = {
  apiKey: 'AIzaSyAVSkmo77MV4nQWsvXUHJ2gNqU5IsgmL4w',
  databaseUrl: 'https://hotelss-5d21e-default-rtdb.firebaseio.com'
};

const STATUS_KEYS = {
  temiz: 'clean',
  kirli: 'dirty',
  temizleniyor: 'progress',
  'kontrol edildi': 'inspect',
  arızalı: 'broken',
  'kullanım dışı': 'broken'
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'sync-room-status') {
    syncRoomStatus(message.roomNumber, message.status, message.occupied, sender.tab?.url)
      .then(() => sendResponse({ ok: true }))
      .catch(async error => {
        console.error('[Oda senkronizasyonu] sync hatası:', error);
        await chrome.storage.local.set({
          lastError: { message: error.message, roomNumber: message.roomNumber, status: message.status, at: Date.now() }
        });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  // DÜZELTME: content.js artık 'scan-report' gönderiyor (eskiden 'content-report'
  // gönderiyordu ve burada hiç işlenmiyordu, bu yüzden tarama bilgisi popup'a
  // hiç ulaşmıyordu).
  if (message?.type === 'scan-report') {
    chrome.storage.local.set({
      scan: {
        matched: message.matched || 0,
        skipped: message.skipped || 0,
        cards: message.cards || 0,
        statusNodes: message.statusNodes || 0,
        roomRack: Boolean(message.roomRack),
        at: Date.now(),
        url: sender.tab?.url || null
      }
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === 'get-sync-state') {
    chrome.storage.local.get(['session', 'enabled', 'lastSync', 'lastError', 'scan']).then(state => sendResponse({
      ok: true,
      signedIn: Boolean(state.session?.idToken),
      enabled: state.enabled !== false,
      lastSync: state.lastSync || null,
      lastError: state.lastError || null,
      scan: state.scan || null
    }));
    return true;
  }
});

// DÜZELTME: idToken süresi (~1 saat) dolunca refreshToken ile otomatik yeniler.
// Eskiden hiç yenileme yapılmıyordu, süre dolunca tüm yazmalar sessizce
// başarısız oluyordu.
async function getFreshIdToken(state, config) {
  const session = state.session;
  if (!session?.idToken) throw new Error('Eklenti Firebase hesabı ile giriş yapmamış.');
  const expiresAt = session.expiresAt || 0;
  if (Date.now() < expiresAt - 60000) return session.idToken;
  if (!session.refreshToken) throw new Error('Oturum süresi doldu, lütfen tekrar giriş yapın.');

  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${config.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Oturum yenilenemedi (${response.status}): ${data.error?.message || ''}`);

  const newSession = {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    localId: data.user_id,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  await chrome.storage.local.set({ session: newSession });
  return newSession.idToken;
}

async function syncRoomStatus(roomNumber, status, occupied, sourceUrl) {
  const state = await chrome.storage.local.get(['session', 'enabled', 'config']);
  if (state.enabled === false) return;

  const config = { ...DEFAULT_CONFIG, ...(state.config || {}) };
  const idToken = await getFreshIdToken(state, config);

  const roomId = String(roomNumber).trim();
  const statusKey = STATUS_KEYS[normalize(status)];
  if (!roomId || !statusKey) throw new Error(`Bilinmeyen oda durumu: ${status}`);
  const isOccupied = Boolean(occupied);

  const roomUrl = `${config.databaseUrl}/rooms/${encodeURIComponent(roomId)}.json?auth=${encodeURIComponent(idToken)}`;
  const existingResponse = await fetch(roomUrl);
  if (!existingResponse.ok) throw new Error(`Oda okunamadı (${existingResponse.status}).`);
  const existing = await existingResponse.json() || {};

  const room = {
    ...existing,
    roomNumber: roomId,
    status: displayStatus(statusKey),
    statusKey,
    // Dolu/boş bilgisi: misafir adı gönderilmez, sadece boolean + Türkçe etiket.
    occupied: isOccupied,
    occupancy: isOccupied ? 'Dolu' : 'Boş',
    floor: existing.floor || 'ElektraWEB',
    updatedAt: { '.sv': 'timestamp' },
    updatedBy: state.session.localId || null,
    source: 'elektraweb-extension'
  };
  const writeResponse = await fetch(roomUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(room)
  });
  if (!writeResponse.ok) {
    const detail = await writeResponse.text();
    throw new Error(`Firebase oda yazımı başarısız (${writeResponse.status}): ${detail.slice(0, 180)}`);
  }

  const logUrl = `${config.databaseUrl}/room_status_logs.json?auth=${encodeURIComponent(idToken)}`;
  const logResponse = await fetch(logUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId,
      oldStatus: existing.statusKey || null,
      newStatus: statusKey,
      oldOccupied: existing.occupied ?? null,
      newOccupied: isOccupied,
      changedAt: { '.sv': 'timestamp' },
      changedBy: state.session.localId || null,
      source: 'elektraweb-extension',
      sourceUrl: sourceUrl || null
    })
  });
  if (!logResponse.ok) throw new Error(`Firebase durum günlüğü yazılamadı (${logResponse.status}).`);

  await chrome.storage.local.set({
    lastSync: { roomNumber: roomId, status: displayStatus(statusKey), at: Date.now() },
    lastError: null
  });
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
}

function displayStatus(key) {
  return { clean: 'Temiz', dirty: 'Kirli', progress: 'Temizleniyor', inspect: 'Kontrol edildi', broken: 'Kullanım dışı' }[key];
}
