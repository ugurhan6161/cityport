const API_KEY = 'AIzaSyAVSkmo77MV4nQWsvXUHJ2gNqU5IsgmL4w';
const statusNode = document.querySelector('#status');
const errorNode = document.querySelector('#error');
const enabledNode = document.querySelector('#enabled');
const loginSection = document.querySelector('#loginSection');
const sessionSection = document.querySelector('#sessionSection');

init();

enabledNode.addEventListener('change', () => chrome.storage.local.set({ enabled: enabledNode.checked }));
document.querySelector('#login').addEventListener('click', login);
document.querySelector('#logout').addEventListener('click', async () => {
  await chrome.storage.local.remove('session');
  render({ signedIn: false, enabled: enabledNode.checked });
});

async function init() {
  const state = await chrome.storage.local.get(['session', 'enabled', 'lastSync', 'lastError', 'scan']);
  enabledNode.checked = state.enabled !== false;
  render({ signedIn: Boolean(state.session?.idToken), enabled: enabledNode.checked, lastSync: state.lastSync, lastError: state.lastError, scan: state.scan });
  chrome.runtime.sendMessage({ type: 'get-sync-state' }, response => { if (response?.ok) render(response); });
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
    render({ signedIn: true, enabled: enabledNode.checked });
  } catch (error) { errorNode.textContent = error.message; }
  finally { setBusy(false); }
}

function render(state) {
  statusNode.textContent = state.signedIn ? (state.enabled ? 'Bağlı ve izliyor' : 'Bağlı, senkronizasyon kapalı') : 'Firebase hesabı ile giriş bekleniyor';
  statusNode.dataset.connected = state.signedIn && state.enabled;
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
