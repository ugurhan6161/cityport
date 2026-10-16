const DEFAULT_CONFIG = {
  apiKey: 'AIzaSyAVSkmo77MV4nQWsvXUHJ2gNqU5IsgmL4w',
  apiBaseUrl: ''
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
    syncRoomStatus(message.roomNumber, message.status, message.occupied, message.guestName, sender.tab?.url)
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

  if (message?.type === 'pull-room-statuses') {
    getRoomStatuses()
      .then(rooms => sendResponse({ ok: true, rooms }))
      .catch(async error => {
        console.error('[Oda senkronizasyonu] Supabase durumları okunamadı:', error);
        await chrome.storage.local.set({
          lastError: { message: error.message, at: Date.now() }
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
    chrome.storage.local.get(['session', 'enabled', 'lastSync', 'lastError', 'scan', 'config']).then(state => sendResponse({
      ok: true,
      signedIn: Boolean(state.session?.idToken),
      enabled: state.enabled !== false,
      lastSync: state.lastSync || null,
      lastError: state.lastError || null,
      apiBaseUrl: state.config?.apiBaseUrl || '',
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

async function syncRoomStatus(roomNumber, status, occupied, guestName, sourceUrl) {
  const state = await chrome.storage.local.get(['session', 'enabled', 'config']);
  if (state.enabled === false) return;

  const config = { ...DEFAULT_CONFIG, ...(state.config || {}) };
  const idToken = await getFreshIdToken(state, config);

  const roomId = String(roomNumber).trim();
  const statusKey = STATUS_KEYS[normalize(status)];
  if (!roomId || !statusKey) throw new Error(`Bilinmeyen oda durumu: ${status}`);
  if (!config.apiBaseUrl) throw new Error('Housekeeping Supabase API adresini eklenti ayarlarından kaydedin.');
  const isOccupied = Boolean(occupied);

  const existing = await requestData(config, idToken, 'GET', { collection: 'rooms', id: roomId });

  const room = {
    ...existing,
    roomNumber: roomId,
    status: displayStatus(statusKey),
    statusKey,
    occupied: isOccupied,
    occupancy: isOccupied ? 'Dolu' : 'Boş',
    guestName: isOccupied ? String(guestName || '').trim() || null : null,
    floor: existing.floor || 'ElektraWEB',
    source: 'elektraweb-extension'
  };
  await requestData(config, idToken, 'PUT', {}, { collection: 'rooms', id: roomId, data: room });
  await requestData(config, idToken, 'PUT', {}, {
    collection: 'room_status_logs',
    id: crypto.randomUUID(),
    data: {
      roomId,
      oldStatus: existing.statusKey || null,
      newStatus: statusKey,
      oldOccupied: existing.occupied ?? null,
      newOccupied: isOccupied,
      changedAt: Date.now(),
      source: 'elektraweb-extension',
      sourceUrl: sourceUrl || null
    }
  });

  await chrome.storage.local.set({
    lastSync: { roomNumber: roomId, status: displayStatus(statusKey), at: Date.now() },
    lastError: null
  });
}

async function getRoomStatuses() {
  const state = await chrome.storage.local.get(['session', 'enabled', 'config']);
  if (state.enabled === false) return [];

  const config = { ...DEFAULT_CONFIG, ...(state.config || {}) };
  const idToken = await getFreshIdToken(state, config);
  if (!config.apiBaseUrl) throw new Error('Housekeeping Supabase API adresini eklenti ayarlarından kaydedin.');
  const result = await requestData(config, idToken, 'GET', { collections: 'rooms' });
  return Object.values(result || {})
    .filter(room => room?.roomNumber && room.statusKey)
    .map(room => ({ roomNumber: String(room.roomNumber), statusKey: room.statusKey }));
}

async function requestData(config, idToken, method, params, body) {
  const url = new URL('/api/data', config.apiBaseUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Supabase isteği başarısız (${response.status}).`);
  return result.data;
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
}

function displayStatus(key) {
  return { clean: 'Temiz', dirty: 'Kirli', progress: 'Temizleniyor', inspect: 'Kontrol edildi', broken: 'Kullanım dışı' }[key];
}
