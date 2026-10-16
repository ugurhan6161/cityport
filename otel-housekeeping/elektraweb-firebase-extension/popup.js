const API_KEY = 'AIzaSyAVSkmo77MV4nQWsvXUHJ2gNqU5IsgmL4w';
const statusNode = document.querySelector('#status');
const errorNode = document.querySelector('#error');
const enabledNode = document.querySelector('#enabled');
const loginSection = document.querySelector('#loginSection');
const sessionSection = document.querySelector('#sessionSection');
const apiUrlNode = document.querySelector('#apiUrl');

init();

enabledNode.addEventListener('change', () => chrome.storage.local.set({ enabled: enabledNode.checked }));
document.querySelector('#login').addEventListener('click', login);
document.querySelector('#saveApiUrl').addEventListener('click', saveApiUrl);
document.querySelector('#logout').addEventListener('click', async () => {
  await chrome.storage.local.remove('session');
  render({ signedIn: false, enabled: enabledNode.checked });
});

async function init() {
  const state = await chrome.storage.local.get(['session', 'enabled', 'lastSync', 'lastError', 'scan', 'config']);
  enabledNode.checked = state.enabled !== false;
  apiUrlNode.value = state.config?.apiBaseUrl || '';
  render({ signedIn: Boolean(state.session?.idToken), enabled: enabledNode.checked, lastSync: state.lastSync, lastError: state.lastError, scan: state.scan, apiBaseUrl: state.config?.apiBaseUrl });
  chrome.runtime.sendMessage({ type: 'get-sync-state' }, response => { if (response?.ok) render(response); });
}

async function saveApiUrl() {
  errorNode.textContent = '';
  let apiUrl;
  try {
    apiUrl = new URL(apiUrlNode.value.trim());
    if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password) {
      throw new Error('HTTPS adresi girin.');
    }
  } catch (error) {
    errorNode.textContent = error.message || 'Geçerli bir HTTPS adresi girin.';
    return;
  }

  try {
    const granted = await chrome.permissions.request({ origins: [`${apiUrl.origin}/*`] });
    if (!granted) throw new Error('Housekeeping API adresine erişim izni verilmedi.');
    const state = await chrome.storage.local.get('config');
    await chrome.storage.local.set({
      config: { ...(state.config || {}), apiBaseUrl: apiUrl.origin }
    });
    errorNode.textContent = '';
    statusNode.textContent = 'Supabase API adresi kaydedildi.';
  } catch (error) {
    errorNode.textContent = error.message || 'API adresi kaydedilemedi.';
  }
}

async function login() {
  errorNode.textContent = '';
  const email = document.querySelector('#email').value.trim();
  const password = document.querySelector('#password').value;
  if (!email || !password) { errorNode.textContent = 'E-posta ve şifre gerekli.'; return; }
  setBusy(true);
  try {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(authError(data.error?.message));
    await chrome.storage.local.set({ session: { idToken: data.idToken, refreshToken: data.refreshToken, localId: data.localId, expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000 } });
    const state = await chrome.storage.local.get('config');
    render({ signedIn: true, enabled: enabledNode.checked, apiBaseUrl: state.config?.apiBaseUrl });
  } catch (error) { errorNode.textContent = error.message; }
  finally { setBusy(false); }
}

function render(state) {
  if (state.apiBaseUrl && document.activeElement !== apiUrlNode) apiUrlNode.value = state.apiBaseUrl;
  statusNode.textContent = !state.signedIn
    ? 'Firebase hesabı ile giriş bekleniyor'
    : !state.apiBaseUrl
      ? 'Housekeeping API adresi gerekli'
      : state.enabled ? 'Bağlı ve izliyor' : 'Bağlı, senkronizasyon kapalı';
  statusNode.dataset.connected = state.signedIn && state.enabled && Boolean(state.apiBaseUrl);
  loginSection.hidden = state.signedIn;
  sessionSection.hidden = !state.signedIn;
  if (state.lastSync) document.querySelector('#lastSync').textContent = `Son kayıt: ${state.lastSync.roomNumber} · ${state.lastSync.status}`;

  const diagnostics = document.querySelector('#diagnostics');
  let scanText;
  if (!state.scan) {
    scanText = 'Tarama sonucu bekleniyor';
  } else if (!state.scan.roomRack) {
    // DÜZELTME: artık Room Rack sayfasının hiç bulunamadığı ayrıca belirtiliyor,
    // eskiden bu bilgi background.js'e hiç ulaşmıyordu.
    scanText = 'Room Rack sayfası bulunamadı (ElektraWEB Room Rack ekranını açıp yenileyin)';
  } else {
    scanText = `Tarama: ${state.scan.cards} oda kartı, ${state.scan.matched} eşleşti, ${state.scan.skipped} atlandı`;
  }
  diagnostics.textContent = state.lastError ? `${scanText} · Hata: ${state.lastError.message}` : scanText;
  diagnostics.dataset.error = Boolean(state.lastError);
}

function setBusy(busy) { document.querySelector('#login').disabled = busy; document.querySelector('#login').textContent = busy ? 'Bağlanıyor...' : 'Giriş yap'; }
function authError(code) { return ({ INVALID_LOGIN_CREDENTIALS: 'E-posta veya şifre hatalı.', EMAIL_NOT_FOUND: 'E-posta veya şifre hatalı.', INVALID_PASSWORD: 'E-posta veya şifre hatalı.', USER_DISABLED: 'Bu kullanıcı pasif durumda.' })[code] || 'Firebase giriş işlemi başarısız.'; }
