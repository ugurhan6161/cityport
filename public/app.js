const rooms = [];
const labels = {clean:'Temiz',dirty:'Kirli',progress:'Temizleniyor',inspect:'Kontrol edildi',broken:'Kullanım dışı'};
const roomStatusPermissions = {
  admin: Object.keys(labels),
  supervisor: ['clean','dirty','progress','inspect'],
  housekeeper: ['progress'],
  front_desk: ['clean','dirty']
};
const app = document.querySelector('#app');
const title = document.querySelector('#pageTitle');
const toast = document.querySelector('#toast');
let currentView = 'dashboard';
let dataRefreshTimer = null;
let dataRefreshInProgress = false;
let currentUser = null;
let currentSession = null;
let currentProfile = null;
let currentRole = null;
let registrationInProgress = false;
let roomFloorFilter = 'all';
let roomStatusFilter = 'all';
let cafeSearch = '';
let cafeCategoryFilter = 'all';
let cafeActiveFilter = 'all';
let cafeSort = 'sortOrder';
let checkoutMonitorTimer = null;
let settingsLoaded = false;
const roleLabels = { admin:'Yönetici', supervisor:'Süpervizör', housekeeper:'Kat hizmetleri', front_desk:'Ön büro', maintenance:'Teknik servis' };
const roleViews = {
  admin: ['dashboard','rooms','issues','requests','reports','users','settings','cafe'],
  supervisor: ['dashboard','rooms','issues','requests','reports'],
  housekeeper: ['dashboard','rooms','issues','requests'],
  front_desk: ['dashboard','rooms','issues','requests','cafe'],
  maintenance: ['dashboard','rooms','issues']
};
const issueManageRoles = ['admin','supervisor','front_desk','maintenance'];

function showToast(message){ toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2600); }
function canAccess(view){ return Boolean(currentRole && roleViews[currentRole]?.includes(view)); }
function authMessage(error){
  return error.message || 'Supabase Auth işlemi başarısız.';
}
async function authRequest(action, values={}){
  const response=await fetch('/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...values})});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.error||authMessage({}));error.status=response.status;throw error;}
  return result;
}
function saveSession(session){
  currentSession={...currentSession,...session,expires_at:session.expires_at||Math.floor(Date.now()/1000)+Number(session.expires_in||3600),user:session.user||currentSession?.user};
  currentUser=currentSession.user?{...currentSession.user,uid:currentSession.user.id}:null;
  localStorage.setItem('housekeeping-supabase-session',JSON.stringify(currentSession));
}
function clearSession(){
  localStorage.removeItem('housekeeping-supabase-session');
  currentSession=null;currentUser=null;currentProfile=null;currentRole=null;
}
async function getAccessToken(session=currentSession){
  if(!session?.access_token||!session?.refresh_token)throw new Error('Oturum açmanız gerekiyor.');
  if(Number(session.expires_at||0)*1000>Date.now()+60000)return session.access_token;
  const refreshed=await authRequest('refresh',{refresh_token:session.refresh_token});
  saveSession(refreshed);
  return currentSession.access_token;
}
function showLogin(message = ''){
  document.body.classList.add('logged-out');
  document.querySelector('#authScreen').classList.add('visible');
  showLoginForm();
  document.querySelector('#authError').textContent = message;
}
function showRegisterForm(){ document.querySelector('#loginForm').hidden=true; document.querySelector('#showRegister').hidden=true; document.querySelector('#registerForm').hidden=false; document.querySelector('#authError').textContent=''; }
function showLoginForm(){ document.querySelector('#loginForm').hidden=false; document.querySelector('#showRegister').hidden=false; document.querySelector('#registerForm').hidden=true; document.querySelector('#authError').textContent=''; }
function showApp(){
  document.body.classList.remove('logged-out');
  document.querySelector('#authScreen').classList.remove('visible');
  const name = currentProfile?.full_name || currentUser?.email?.split('@')[0] || 'Kullanıcı';
  document.querySelector('#userName').textContent = name;
  document.querySelector('#userRole').textContent = roleLabels[currentRole] || currentRole;
  document.querySelector('#userAvatar').textContent = name.slice(0, 2).toUpperCase();
  render('dashboard');
  attachDataListeners();
}
async function dataRequest(method, params = {}, data, session = currentSession){
  if (!session) throw new Error('Oturum açmanız gerekiyor.');
  const url = new URL('/api/data', window.location.origin);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const accessToken = await getAccessToken(session);
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) {const error=new Error(result.error||'Supabase veri işlemi başarısız.');error.status=response.status;throw error;}
  return result.data;
}
async function loadUserProfile(user){
  let profile;
  try { profile=await dataRequest('GET',{collection:'users',id:user.uid}); }
  catch(error){
    if(error.status!==404)throw error;
    await dataRequest('PUT',{}, {collection:'users',id:user.uid,data:{full_name:user.user_metadata?.full_name||user.email?.split('@')[0]||'Personel',email:user.email||''}});
    profile=await dataRequest('GET',{collection:'users',id:user.uid});
  }
  if (!profile?.role || !roleViews[profile.role] || profile.is_active === false) throw new Error('Hesabınıza geçerli bir rol atanmamış.');
  currentProfile = profile;
  currentRole = profile.role;
}
function startAuthentication(){
  let session;
  try { session=JSON.parse(localStorage.getItem('housekeeping-supabase-session')||'null'); }
  catch(error){ clearSession(); }
  if(!session?.access_token){showLogin();return;}
  saveSession(session);
  loadUserProfile(currentUser).then(showApp).catch(error=>{clearSession();showLogin(error.message);});
}
function setSyncState(message, online = true){
  document.querySelector('.online-dot').style.background = online ? '#2eb486' : '#e17a65';
  document.querySelector('.sync-pill span:nth-child(2)').textContent = online ? 'Çevrimiçi' : 'Bağlantı yok';
  document.querySelector('#syncText').textContent = `· ${message}`;
}
function roomRecord([number, status, key, floor, roomType='Standart', guestName='']){
  return { roomNumber: number, status, statusKey: key, floor, roomType, guestName: guestName || null, updatedAt: Date.now() };
}
async function saveRoomToSupabase(room, previousStatus){
  try {
    await writeRecord('rooms', room[0], {
    ...roomRecord(room),
    pendingSync: true,
    requestedStatusKey: room[2],
    requestedLabel: room[1],
    requestedAt: Date.now(),
    source: 'housekeeping-app'
    });
    await writeRecord('room_status_logs', dbKey(), {
      roomId: room[0],
      oldStatus: previousStatus,
      newStatus: room[2],
      changedAt: Date.now()
    });
    if(room[2]==='dirty') await removeCompletedRequestsForRoom(room[0]);
    setSyncState('Kaydedildi');
  } catch (error) {
    setSyncState('Yetki gerekli', false);
    console.error('Oda Supabase kaydı başarısız:', error);
    showToast(error.message || 'Oda Supabase kaydı başarısız.');
  }
}
function applyRooms(remoteRooms){
    const syncedRooms = Object.values(remoteRooms || {}).filter(remoteRoom => remoteRoom?.roomNumber).map(remoteRoom => [
      String(remoteRoom.roomNumber),
      remoteRoom.status || labels[remoteRoom.statusKey] || 'Temiz',
      remoteRoom.statusKey || 'clean',
      remoteRoom.floor || 'Belirtilmemiş',
      remoteRoom.roomType || 'Standart',
      remoteRoom.guestName || '',
      remoteRoom.occupied === true,
      remoteRoom.doNotDisturb || null
    ]).sort((first, second) => first[0].localeCompare(second[0], 'tr', { numeric: true }));
    rooms.splice(0, rooms.length, ...syncedRooms);
}
function shellHeading(eyebrow, heading, sub, button=''){ return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${heading}</h1><p class="subheading">${sub}</p></div>${button ? `<button class="primary-button" data-action="${button}">＋ ${button === 'room' ? 'Yeni oda ekle' : button === 'issue' ? 'Sorun bildir' : button === 'cafe-product' ? 'Yeni ürün ekle' : 'Yeni talep'}</button>` : ''}</div>`; }
function stat(titleText,value,note,icon){ return `<div class="stat-card"><div class="stat-top"><span>${titleText}</span><span class="stat-icon">${icon}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></div>`; }
function roomCards(){ return rooms.map(([number,status,key,floor]) => `<article class="room-card" data-status="${key}" data-room="${number}"><h3>${number}</h3><p>${floor}</p><span class="room-status">${status}</span></article>`).join(''); }
function dashboard(){ return `${shellHeading('Pazartesi, 7 Eylül 2026','Günaydın, Selin','Bugünün operasyon özeti ve ekip durumu burada.')}<section class="stats-grid">${stat('TOPLAM ODA','48','Otel kapasitesi · 3 kat','▦')}${stat('TEMİZ ODA','31','%64 doluluk öncesi hazır','✓')}${stat('AÇIK SORUN','3','2 yüksek öncelikli','△')}${stat('BEKLEYEN TALEP','8','3 acil talep var','♧')}</section><div class="content-grid"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Oda durumu</h2><p class="panel-meta">Bugün, 09:42 itibarıyla</p></div><button class="text-link" data-view="rooms">Tüm odaları gör →</button></div><div class="room-summary"><div class="room-head"><strong>48 oda</strong><div class="legend"><span><i class="clean"></i>Temiz</span><span><i class="dirty"></i>Kirli</span><span><i class="progress"></i>İşlemde</span></div></div><div class="room-bars"><span class="clean" style="width:64%"></span><span class="dirty" style="width:15%"></span><span class="progress" style="width:10%"></span><span class="inspect" style="width:7%"></span><span class="broken" style="width:4%"></span></div><div class="room-stats"><span><b>31</b> Temiz</span><span><b>7</b> Kirli</span><span><b>5</b> İşlemde</span><span><b>3</b> Kontrol</span><span><b>2</b> Arızalı</span></div></div><div class="panel-head" style="border-top:1px solid var(--line)"><div><h2 class="panel-title">Son aktiviteler</h2><p class="panel-meta">Ekibin son işlemleri</p></div></div><div class="activity-list"><div class="activity"><span class="activity-mark">✓</span><div class="activity-copy"><strong>Ayşe Kaya</strong> <span>203 numaralı odayı temiz olarak işaretledi.</span><span class="activity-time">2 dakika önce · 203</span></div></div><div class="activity"><span class="activity-mark">♧</span><div class="activity-copy"><strong>Ön Büro</strong> <span>305 numaralı oda için ekstra havlu talebi oluşturdu.</span><span class="activity-time">8 dakika önce · 305</span></div></div><div class="activity"><span class="activity-mark">△</span><div class="activity-copy"><strong>Mehmet Arslan</strong> <span>106 numaralı odada klima sorunu bildirdi.</span><span class="activity-time">21 dakika önce · 106</span></div></div></div></section><aside class="panel"><div class="panel-head"><div><h2 class="panel-title">Hızlı işlemler</h2><p class="panel-meta">Sık kullanılan aksiyonlar</p></div></div><div class="quick-actions"><button class="quick-action" data-action="issue"><span>△</span>Sorun bildir</button><button class="quick-action" data-action="request"><span>♧</span>Talep oluştur</button><button class="quick-action" data-view="rooms"><span>▦</span>Odaları görüntüle</button><button class="quick-action" data-action="sync"><span>↻</span>Verileri eşitle</button></div><div class="panel-head" style="border-top:1px solid var(--line)"><div><h2 class="panel-title">Öncelikli sorunlar</h2><p class="panel-meta">Çözüm bekleyen 3 kayıt</p></div><button class="text-link" data-view="issues">Tümü →</button></div><div class="issue-item"><span class="issue-tag"></span><div class="issue-copy"><strong>Klima çalışmıyor</strong><p>Oda 106 · Teknik servis</p></div><span class="priority high">Yüksek</span></div><div class="issue-item"><span class="issue-tag" style="background:var(--amber)"></span><div class="issue-copy"><strong>Banyo musluğu sızdırıyor</strong><p>Oda 205 · Atanmadı</p></div><span class="priority medium">Orta</span></div></aside></div>`; }
function roomsView(){ return `${shellHeading('Operasyon / Odalar','Odalar','Kat ve duruma göre odaları yönetin.','room')}<div class="filter-row"><button class="filter active">Tüm katlar</button><button class="filter">Zemin kat</button><button class="filter">1. kat</button><button class="filter">2. kat</button><button class="filter">Durum: Tümü</button></div><section class="panel" style="padding:20px"><div class="room-head"><strong>18 oda gösteriliyor</strong><span class="panel-meta">Son güncelleme: şimdi</span></div><div class="rooms-grid">${roomCards()}</div></section>`; }
function issuesView(){ return `${shellHeading('Operasyon / Takip','Sorunlar','Açık bakım ve arıza kayıtlarını takip edin.','issue')}<div class="filter-row"><button class="filter active">Açık sorunlar <b>3</b></button><button class="filter">İşlemde</button><button class="filter">Çözüldü</button><button class="filter">Öncelik: Tümü</button></div><section class="panel"><table class="table"><thead><tr><th>SORUN</th><th>ODA</th><th>ÖNCELİK</th><th>ATANAN</th><th>DURUM</th></tr></thead><tbody><tr><td><strong>Klima çalışmıyor</strong><br><span class="panel-meta">Elektrik / Klima · 21 dk önce</span></td><td>106</td><td><span class="priority high">Yüksek</span></td><td>Teknik servis</td><td><span class="status-badge open">Açık</span></td></tr><tr><td><strong>Banyo musluğu sızdırıyor</strong><br><span class="panel-meta">Su tesisatı · 1 saat önce</span></td><td>205</td><td><span class="priority medium">Orta</span></td><td>Atanmadı</td><td><span class="status-badge open">Açık</span></td></tr><tr><td><strong>Komodin lambası kırık</strong><br><span class="panel-meta">Mobilya · Bugün 07:20</span></td><td>314</td><td><span class="priority medium">Orta</span></td><td>Burak Yılmaz</td><td><span class="status-badge progress">İşlemde</span></td></tr></tbody></table></section>`; }
function requestsView(){ return `${shellHeading('Operasyon / Misafir deneyimi','Misafir talepleri','Bekleyen işleri ekibe atayın ve takip edin.','request')}<div class="filter-row"><button class="filter active">Tümü <b>8</b></button><button class="filter">Bekliyor</button><button class="filter">İşlemde</button><button class="filter">Tamamlandı</button></div><section class="panel"><table class="table"><thead><tr><th>TALEP</th><th>ODA</th><th>ÖNCELİK</th><th>ATANAN</th><th>DURUM</th></tr></thead><tbody><tr><td><strong>Ekstra havlu</strong><br><span class="panel-meta">Misafir talebi · 8 dk önce</span></td><td>305</td><td><span class="priority high">Acil</span></td><td>Ayşe Kaya</td><td><span class="status-badge waiting">Bekliyor</span></td></tr><tr><td><strong>Mini bar yenileme</strong><br><span class="panel-meta">Ön Büro · 16 dk önce</span></td><td>214</td><td><span class="priority medium">Normal</span></td><td>Mehmet Arslan</td><td><span class="status-badge progress">İşlemde</span></td></tr><tr><td><strong>Temizlik saati değişikliği</strong><br><span class="panel-meta">Misafir talebi · 34 dk önce</span></td><td>402</td><td><span class="priority medium">Normal</span></td><td>Selin Demir</td><td><span class="status-badge">Tamamlandı</span></td></tr></tbody></table></section>`; }
function genericView(name, sub){ return `${shellHeading('Yönetim',name,sub)}<section class="panel" style="padding:28px"><h2 class="panel-title">${name} çalışma alanı</h2><p class="subheading">Bu bölüm operasyon verileri hazır olduğunda burada görünecek.</p></section>`; }
function render(view=currentView){
  if (!canAccess(view)) view = 'dashboard';
  currentView=view;
  const views={dashboard,rooms:roomsView,issues:issuesView,requests:requestsView,reports:()=>genericView('Raporlar','Operasyon performansını ve geçmiş verileri inceleyin.'),users:()=>genericView('Kullanıcılar','Ekip üyelerini ve rollerini yönetin.')};
  app.innerHTML=(views[view]||dashboard)()
    .replaceAll('Gerçek zamanlı Firebase verisi','Supabase verisi')
    .replaceAll('Firebase bağlantısı','Personel giriş durumu')
    .replaceAll('Veriler gerçek zamanlı olarak Realtime Database ile eşitleniyor.','Uygulama kayıtları Supabase üzerinden yönetiliyor.')
    .replaceAll('Yeni kayıtlar otomatik Firebase UID ile burada görünür.','Yeni kayıtlar Firebase Authentication UID ile Supabase\'e kaydedilir.');
  const activeTitle={dashboard:'Genel Bakış',rooms:'Odalar',issues:'Sorunlar',requests:'Misafir Talepleri',reports:'Raporlar',users:'Kullanıcılar'}[view];
  title.textContent=activeTitle;
  document.querySelectorAll('.nav-item[data-view]').forEach(item=>{ item.classList.toggle('active',item.dataset.view===view); item.hidden=!item.dataset.roles.split(',').includes(currentRole); });
}

document.addEventListener('click',(event)=>{ const viewTarget=event.target.closest('[data-view]'); if(viewTarget){ if(!canAccess(viewTarget.dataset.view)){showToast('Bu bölüme erişim yetkiniz yok.');return;} render(viewTarget.dataset.view); document.querySelector('#sidebar').classList.remove('open'); return;} const action=event.target.closest('[data-action]')?.dataset.action; if(['room-details','change-room-status','set-room-status','report-room-issue','open-room-filters','complete-request','add-room-request','complete-issue','delete-issue'].includes(action))return; if(action){ if(action==='logout'){clearSession();showLogin();return;} if(action==='sync'){showToast('Veriler başarıyla eşitlendi.');setSyncState('Az önce güncellendi');} else {showToast(action==='room'?'Yeni oda formu açılıyor...':action==='issue'?'Sorun bildirim formu açılıyor...':'Misafir talebi formu açılıyor...');} } const card=event.target.closest('.room-card'); if(card && !card.hasAttribute('data-room-interaction')){ if(!['admin','supervisor','housekeeper'].includes(currentRole)){showToast('Oda durumunu güncelleme yetkiniz yok.');return;} const room=rooms.find(item=>item[0]===card.dataset.room); const previousStatus=room[2]; const next={clean:'dirty',dirty:'progress',progress:'inspect',inspect:'clean',broken:'clean'}[room[2]]; room[2]=next; room[1]=labels[next]; render('rooms'); saveRoomToSupabase(room, previousStatus); showToast(`${room[0]} numaralı oda: ${room[1]}`); } });
document.querySelector('#menuButton').addEventListener('click',()=>{
  const sidebar=document.querySelector('#sidebar');
  if(window.matchMedia('(max-width: 900px)').matches){
    sidebar.classList.toggle('open');
  }else{
    sidebar.classList.toggle('collapsed');
  }
  document.querySelector('#menuButton').setAttribute('aria-expanded',String(window.matchMedia('(max-width: 900px)').matches?sidebar.classList.contains('open'):!sidebar.classList.contains('collapsed')));
});
document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  document.querySelector('#authError').textContent = '';
  try { const session=await authRequest('login',{email:document.querySelector('#loginEmail').value.trim(),password:document.querySelector('#loginPassword').value});saveSession(session);await loadUserProfile(currentUser);showApp(); }
  catch (error) { clearSession();document.querySelector('#authError').textContent = authMessage(error); }
  finally { button.disabled = false; }
});
document.querySelector('#showRegister').addEventListener('click', showRegisterForm);
document.querySelector('#showLogin').addEventListener('click', showLoginForm);
document.querySelector('#registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form=event.currentTarget; const button=form.querySelector('button[type="submit"]'); button.disabled=true; document.querySelector('#authError').textContent='';
  try {
    const name=document.querySelector('#registerName').value.trim(); const email=document.querySelector('#registerEmail').value.trim(); const password=document.querySelector('#registerPassword').value;
    const result=await authRequest('register',{email,password,data:{full_name:name}});
    if(result.access_token){saveSession(result);try{try{await dataRequest('GET',{collection:'users',id:currentUser.uid});}catch(error){if(error.status!==404)throw error;await dataRequest('PUT',{}, {collection:'users',id:currentUser.uid,data:{full_name:name,email}});}}finally{clearSession();}}
    showLoginForm();document.querySelector('#authError').textContent=result.access_token?'Kaydınız oluşturuldu. Admin rolünüzü aktif ettiğinde giriş yapabilirsiniz.':'Kaydınız oluşturuldu. Giriş yapmadan önce e-posta adresinizi doğrulayın.';form.reset();
  } catch(error) { document.querySelector('#authError').textContent=authMessage(error); }
  finally { button.disabled=false; }
});
document.querySelector('#sidebarClose').addEventListener('click',()=>document.querySelector('#sidebar').classList.remove('open'));
showLogin();
startAuthentication();

/* Supabase-backed management data; Firebase remains for notification delivery. */
const records = { rooms: {}, issues: {}, guest_requests: {}, users: {}, settings: {}, manual_notification_logs: {}, cafe_products: {} };
let dataListenersAttached = false;
const statusText = { open:'Açık', in_progress:'İşlemde', resolved:'Çözüldü', closed:'Kapalı', waiting:'Bekliyor', completed:'Tamamlandı' };
const priorityText = { low:'Düşük', medium:'Orta', high:'Yüksek', urgent:'Acil', normal:'Normal' };

function currentName(){ return currentProfile?.full_name || currentUser?.email || 'Kullanıcı'; }
function dbKey(){ return crypto.randomUUID(); }
function attachDataListeners(){
  if (dataListenersAttached) return;
  dataListenersAttached = true;
  refreshManagementData();
  dataRefreshTimer = setInterval(refreshManagementData, 15000);
}
async function refreshManagementData(){
  if (!currentUser || dataRefreshInProgress) return;
  dataRefreshInProgress = true;
  try {
    const data = await dataRequest('GET', {
      collections: 'rooms,issues,guest_requests,users,cafe_products,settings,manual_notification_logs'
    });
    const nextRecords = {
      rooms: data.rooms || {},
      issues: data.issues || {},
      guest_requests: data.guest_requests || {},
      users: data.users || {},
      cafe_products: data.cafe_products || {},
      settings: data.settings?.main || {},
      manual_notification_logs: data.manual_notification_logs || {}
    };
    const changed = Object.entries(nextRecords)
      .some(([key, value]) => JSON.stringify(records[key]) !== JSON.stringify(value));
    Object.assign(records, nextRecords);
    settingsLoaded = true;
    applyRooms(records.rooms);
    if (changed) {
      applyHotelName();
      render(currentView);
    }
    startCheckoutMonitor();
    setSyncState('Güncel');
  } catch (error) {
    console.error('Housekeeping verileri Supabase üzerinden okunamadı:', error);
    setSyncState('Supabase bağlantısı yok', false);
    showToast(error.message || 'Supabase verileri okunamadı.');
  } finally {
    dataRefreshInProgress = false;
  }
}
function applyHotelName(){
  const hotelName = records.settings.hotelName || 'Cityport Hotel';
  document.querySelector('.hotel-switcher strong').textContent = hotelName;
  document.querySelector('#hotelNameBreadcrumb').textContent = hotelName.replace(/ Hotel$/,'');
  document.querySelector('.auth-screen .eyebrow').textContent = hotelName;
}
function writeRecord(path, id, value){
  return dataRequest('PUT', {}, { collection: path, id, data: value }).then(saved => {
    if (path === 'settings') records.settings = saved;
    else {
      records[path] ||= {};
      records[path][id] = saved;
    }
    return saved;
  });
}
function patchRecord(path, id, value){
  return dataRequest('PATCH', {}, { collection: path, id, data: value }).then(saved => {
    if (path === 'settings') records.settings = saved;
    else {
      records[path] ||= {};
      records[path][id] = saved;
    }
    return saved;
  });
}
function removeRecord(path, id){
  return dataRequest('DELETE', {}, { collection: path, id }).then(() => {
    if (records[path]) delete records[path][id];
  });
}
function recordRows(path){ return Object.entries(records[path] || {}).sort((a,b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)); }
function updateNavCounts(){
  const counts = { rooms: rooms.length, issues: recordRows('issues').length, guest_requests: recordRows('guest_requests').length };
  Object.entries(counts).forEach(([key, value]) => { const badge=document.querySelector(`[data-count="${key}"]`); if(badge) badge.textContent=value; });
}
function esc(value=''){ return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char])); }
function updateNotificationRoomSelection(form=document.querySelector('[data-form="manual-notification]')){
  if(!form) return;
  const roomsInForm=[...form.querySelectorAll('[name="rooms"]')];
  const selected=roomsInForm.filter(input=>input.checked).length;
  const count=form.querySelector('[data-selected-room-count]');
  if(count) count.textContent=selected;
  const selectAll=form.querySelector('[data-select-all-rooms]');
  if(selectAll){ selectAll.classList.toggle('is-selected',selected>0); selectAll.textContent=selected===roomsInForm.length?'Tümünü kaldır':'Tümünü seç'; }
}
function modal(titleText, body, id='managementModal'){ let node=document.querySelector(`#${id}`); if(!node){ node=document.createElement('div'); node.id=id; node.className='modal-backdrop'; document.body.appendChild(node); } body=body.replaceAll('Firebase Auth UID','Supabase Auth UID').replaceAll('Firebase Authentication bölümünden ayrıca oluşturulmalıdır.','Supabase Auth üzerinden ayrıca oluşturulmalıdır.'); node.innerHTML=`<div class="modal"><div class="modal-head"><h2>${titleText}</h2><button class="modal-close" data-close-modal aria-label="Kapat">×</button></div>${body}</div>`; node.classList.add('visible'); }
function closeModal(){ document.querySelectorAll('.modal-backdrop').forEach(node => node.classList.remove('visible')); }
function recordForm(type, id='', roomNumber=''){
  const item = records[type]?.[id] || {};
  if(type==='rooms') return `<form class="management-form" data-form="room" data-id="${esc(id)}"><div class="form-grid"><div class="form-field"><label>Oda numarası</label><input name="roomNumber" value="${esc(item.roomNumber || '')}" required ${id?'readonly':''}></div><div class="form-field"><label>Kat</label><input name="floor" value="${esc(item.floor || '')}" placeholder="1. kat" required></div><div class="form-field"><label>Durum</label><select name="statusKey"><option value="clean" ${item.statusKey==='clean'?'selected':''}>Temiz</option><option value="dirty" ${item.statusKey==='dirty'?'selected':''}>Kirli</option><option value="progress" ${item.statusKey==='progress'?'selected':''}>Temizleniyor</option><option value="inspect" ${item.statusKey==='inspect'?'selected':''}>Kontrol edildi</option><option value="broken" ${item.statusKey==='broken'?'selected':''}>Kullanım dışı</option></select></div><div class="form-field"><label>Oda tipi</label><input name="roomType" value="${esc(item.roomType || 'Standart')}" placeholder="Standart"></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`;
  if(type==='users') return `<form class="management-form" data-form="user" data-id="${esc(id)}"><div class="form-grid"><div class="form-field full"><label>Firebase Auth UID</label><input name="uid" value="${esc(id)}" placeholder="Authentication UID" required ${id?'readonly':''}></div><div class="form-field"><label>Ad soyad</label><input name="full_name" value="${esc(item.full_name || '')}" required></div><div class="form-field"><label>E-posta</label><input type="email" name="email" value="${esc(item.email || '')}" required></div><div class="form-field"><label>Rol</label><select name="role"><option value="admin" ${item.role==='admin'?'selected':''}>Yönetici</option><option value="supervisor" ${item.role==='supervisor'?'selected':''}>Süpervizör</option><option value="housekeeper" ${item.role==='housekeeper'?'selected':''}>Kat hizmetleri</option><option value="front_desk" ${item.role==='front_desk'?'selected':''}>Ön büro</option><option value="maintenance" ${item.role==='maintenance'?'selected':''}>Teknik servis</option></select></div><div class="form-field"><label>Durum</label><select name="is_active"><option value="true" ${item.is_active!==false?'selected':''}>Aktif</option><option value="false" ${item.is_active===false?'selected':''}>Pasif</option></select></div></div><p class="panel-meta">Bu işlem profil kaydı oluşturur. Kullanıcının giriş hesabı Firebase Authentication bölümünden ayrıca oluşturulmalıdır.</p><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`;
  if(type==='cafe_products') return cafeProductForm(id);
  const isIssue=type==='issues';
  return `<form class="management-form" data-form="${isIssue?'issue':'request'}" data-id="${esc(id)}"><div class="form-grid"><div class="form-field"><label>Oda numarası</label><input name="roomNumber" value="${esc(item.roomNumber || roomNumber)}" required ${roomNumber?'readonly':''}></div><div class="form-field"><label>Öncelik</label><select name="priority"><option value="normal" ${item.priority==='normal'?'selected':''}>Normal</option><option value="low" ${item.priority==='low'?'selected':''}>Düşük</option><option value="medium" ${item.priority==='medium'?'selected':''}>Orta</option><option value="high" ${item.priority==='high'?'selected':''}>Yüksek</option><option value="urgent" ${item.priority==='urgent'?'selected':''}>Acil</option></select></div><div class="form-field full"><label>${isIssue?'Sorun başlığı':'Talep türü'}</label><input name="title" value="${esc(item.title || item.requestType || '')}" placeholder="${isIssue?'Örn. Klima çalışmıyor':'Ekstra havlu'}" required></div><div class="form-field full"><label>Açıklama</label><textarea name="description">${esc(item.description || '')}</textarea></div><div class="form-field"><label>Durum</label><select name="status"><option value="${isIssue?'open':'waiting'}">${isIssue?'Açık':'Bekliyor'}</option><option value="in_progress" ${item.status==='in_progress'?'selected':''}>İşlemde</option><option value="${isIssue?'resolved':'completed'}" ${item.status==='resolved'||item.status==='completed'?'selected':''}>${isIssue?'Çözüldü':'Tamamlandı'}</option></select></div><div class="form-field"><label>Atanan kişi</label><input name="assignedTo" value="${esc(item.assignedTo || '')}" placeholder="Personel adı"></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`;
}
function bulkRoomForm(){ return `<form class="management-form" data-form="bulk-rooms"><p class="panel-meta">Her satıra şu sırayla yazın: oda numarası, kat, durum anahtarı, oda tipi. Durum anahtarı: clean, dirty, progress, inspect veya broken.</p><div class="form-field"><label>Odalar</label><textarea name="roomsText" rows="8" placeholder="101, Zemin kat, clean, Standart&#10;102, Zemin kat, dirty, Standart&#10;201, 1. kat, clean, Suite" required></textarea></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Odaları kaydet</button></div></form>`; }
function adminOnly(){ if(currentRole!=='admin'){showToast('Bu işlem yalnızca admin içindir.');return false;} return true; }
const cafeManageRoles = ['admin','front_desk'];
function canManageCafe(){ if(!cafeManageRoles.includes(currentRole)){showToast('Cafe ürünlerini yönetme yetkiniz yok.');return false;} return true; }
function cafeProductForm(id=''){
  const item = records.cafe_products?.[id] || {};
  return `<form class="management-form" data-form="cafe-product" data-id="${esc(id)}"><div class="form-grid"><div class="form-field full"><label>Ürün adı</label><input name="name" value="${esc(item.name || '')}" required maxlength="120"></div><div class="form-field full"><label>Açıklama</label><textarea name="description" rows="3">${esc(item.description || '')}</textarea></div><div class="form-field"><label>Fiyat (TRY)</label><input type="number" name="price" value="${esc(item.price ?? '')}" min="0" step="0.01" required></div><div class="form-field"><label>Kategori</label><input name="category" value="${esc(item.category || '')}" required></div><div class="form-field"><label>Görsel URL</label><input type="url" name="image" value="${esc(item.image || '')}" placeholder="https://..."></div><div class="form-field"><label>Sıra</label><input type="number" name="sortOrder" value="${esc(item.sortOrder ?? 0)}" step="1" required></div><div class="form-field"><label>Durum</label><select name="active"><option value="true" ${item.active!==false?'selected':''}>Aktif</option><option value="false" ${item.active===false?'selected':''}>Pasif</option></select></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">${id?'Ürünü güncelle':'Ürünü kaydet'}</button></div></form>`;
}
function cafeItemsText(items){ return Array.isArray(items) ? items.map(item => `${item.name || item.productName || 'Ürün'} x${item.quantity || 1}`).join(', ') : '-'; }
function cafeView(){
  const products = Object.entries(records.cafe_products || {}).map(([id, item]) => ({id, ...item}));
  const categories = [...new Set(products.map(item => item.category).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'tr'));
  const visible = products.filter(item => (!cafeSearch || `${item.name || ''} ${item.description || ''} ${item.category || ''}`.toLocaleLowerCase('tr-TR').includes(cafeSearch.toLocaleLowerCase('tr-TR'))) && (cafeCategoryFilter==='all' || item.category===cafeCategoryFilter) && (cafeActiveFilter==='all' || String(item.active !== false)===cafeActiveFilter)).sort((a,b) => cafeSort==='name' ? String(a.name||'').localeCompare(String(b.name||''), 'tr') : (Number(a.sortOrder)||0)-(Number(b.sortOrder)||0));
  const orders = recordRows('guest_requests').filter(([, item]) => item.requestType === 'cafe').sort((a,b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  return `${shellHeading('Yönetim / Misafir deneyimi','Cafe','Menü ürünlerini ve cafe sipariş geçmişini yönetin.', 'cafe-product')}<div class="cafe-toolbar"><input type="search" data-cafe-search value="${esc(cafeSearch)}" placeholder="Ürünlerde ara"><select data-cafe-category><option value="all">Tüm kategoriler</option>${categories.map(category=>`<option value="${esc(category)}" ${cafeCategoryFilter===category?'selected':''}>${esc(category)}</option>`).join('')}</select><select data-cafe-active><option value="all">Tüm durumlar</option><option value="true" ${cafeActiveFilter==='true'?'selected':''}>Aktif</option><option value="false" ${cafeActiveFilter==='false'?'selected':''}>Pasif</option></select><select data-cafe-sort><option value="sortOrder" ${cafeSort==='sortOrder'?'selected':''}>Sıra</option><option value="name" ${cafeSort==='name'?'selected':''}>Ada göre</option></select></div><section class="panel"><table class="table"><thead><tr><th>ÜRÜN</th><th>KATEGORİ</th><th>FİYAT</th><th>DURUM</th><th>SIRA</th><th></th></tr></thead><tbody>${visible.length ? visible.map(item=>`<tr class="${item.active===false?'cafe-inactive':''}"><td><div style="display:flex;align-items:center;gap:10px">${item.image?`<img class="cafe-product-image" src="${esc(item.image)}" alt="">`:'<span class="cafe-product-image empty">☕</span>'}<span><strong>${esc(item.name||'-')}</strong><br><span class="panel-meta">${esc(item.description||'')}</span></span></div></td><td>${esc(item.category||'-')}</td><td>${Number(item.price||0).toLocaleString('tr-TR',{minimumFractionDigits:2})} TRY</td><td><span class="status-badge ${item.active===false?'open':''}">${item.active===false?'Pasif':'Aktif'}</span></td><td>${Number(item.sortOrder)||0}</td><td><div class="table-actions"><button class="mini-button" data-action="edit-cafe-product" data-id="${esc(item.id)}">Düzenle</button><button class="mini-button" data-action="toggle-cafe-product" data-id="${esc(item.id)}">${item.active===false?'Aktifleştir':'Pasifleştir'}</button><button class="mini-button" data-action="delete-cafe-product" data-id="${esc(item.id)}">Sil</button></div></td></tr>`).join('') : '<tr><td colspan="6" class="empty-state">Henüz cafe ürünü bulunmuyor.</td></tr>'}</tbody></table></section><section class="panel" style="margin-top:18px"><div class="panel-head"><div><h2 class="panel-title">Cafe sipariş geçmişi</h2><p class="panel-meta">Misafir uygulamasından gelen requestType: cafe kayıtları</p></div></div><table class="table"><thead><tr><th>ODA / MİSAFİR</th><th>ÜRÜNLER</th><th>TOPLAM</th><th>DURUM</th><th>TARİH</th><th>AÇIKLAMA</th></tr></thead><tbody>${orders.length ? orders.map(([,item])=>`<tr><td><strong>${esc(item.roomNumber||'-')}</strong><br><span class="panel-meta">${esc(item.guestName||'-')}</span></td><td class="cafe-order-items">${esc(cafeItemsText(item.items))}</td><td class="cafe-order-total">${esc(item.total ?? 0)} ${esc(item.currency||'TRY')}</td><td><span class="status-badge ${item.status==='waiting'?'waiting':item.status==='in_progress'?'progress':''}">${esc(statusText[item.status]||item.status||'-')}</span></td><td>${esc(formatDateTime(item.createdAt))}</td><td>${esc(item.description||'-')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-state">Henüz cafe siparişi bulunmuyor.</td></tr>'}</tbody></table></section>`;
}
function notificationsView(){ const logs=recordRows('manual_notification_logs').slice(0,20); return `${shellHeading('Yönetim','Özel Bildirimler','Seçtiğiniz odadaki aktif cihazlara manuel Firebase bildirimi gönderin.')}<section class="settings-grid"><section class="setting-card"><h3>Yeni bildirim gönder</h3><p class="panel-meta">Bildirim yalnızca seçilen odanın aktif FCM cihazlarına gider.</p><form class="management-form" data-form="manual-notification"><div class="form-grid"><div class="form-field"><label>Oda</label><select name="room" required><option value="">Oda seçin</option>${rooms.map(([number])=>`<option value="${esc(number)}">${esc(number)}</option>`).join('')}</select></div><div class="form-field"><label>Bağlantı</label><input name="url" value="/" placeholder="/"></div><div class="form-field full"><label>Başlık</label><input name="title" value="${esc(records.settings.hotelName || 'Cityport Hotel')}" required></div><div class="form-field full"><label>Mesaj</label><textarea name="body" rows="5" placeholder="Misafire gönderilecek bildirim metni" required></textarea></div></div><div class="modal-actions"><button class="primary-button" type="submit">Bildirimi gönder</button></div></form></section><section class="setting-card"><h3>Son manuel gönderimler</h3><div class="notification-log-list">${logs.length?logs.map(([,item])=>`<div class="notification-log"><strong>Oda ${esc(item.room || '-')}</strong><span>${esc(item.title || '-')}</span><small>${esc(item.result || '-')} · ${formatDateTime(item.sentAt)}</small></div>`).join(''):'<p class="empty-state">Henüz manuel bildirim gönderilmedi.</p>'}</div></section></section>`; }
function settingsView(){ return `${shellHeading('Yönetim','Otel ayarları','Otel kimliğini, vardiya düzenini ve operasyon tercihlerini yönetin.')}<div class="settings-grid"><section class="setting-card"><h3>Otel bilgileri</h3><p class="panel-meta">Uygulamanın görünen tesis bilgileri.</p><form class="management-form" data-form="settings"><div class="form-grid"><div class="form-field full"><label>Otel adı</label><input name="hotelName" value="${esc(records.settings.hotelName || 'Cityport Hotel')}" required></div><div class="form-field"><label>Telefon</label><input name="hotelPhone" value="${esc(records.settings.hotelPhone || '')}" placeholder="+90"></div><div class="form-field"><label>E-posta</label><input type="email" name="hotelEmail" value="${esc(records.settings.hotelEmail || '')}" placeholder="info@otel.com"></div><div class="form-field full"><label>Adres</label><textarea name="hotelAddress">${esc(records.settings.hotelAddress || '')}</textarea></div></div><div class="modal-actions"><button class="primary-button">Otel bilgilerini kaydet</button></div></form></section><section class="setting-card"><h3>Operasyon tercihleri</h3><p class="panel-meta">Dashboard ve oda akışının davranışını belirleyin.</p><form class="management-form" data-form="settings"><div class="form-grid"><div class="form-field"><label>Vardiya başlangıcı</label><input type="time" name="shiftStart" value="${esc(records.settings.shiftStart || '08:00')}"></div><div class="form-field"><label>Vardiya bitişi</label><input type="time" name="shiftEnd" value="${esc(records.settings.shiftEnd || '17:00')}"></div><div class="form-field full"><label>Arıza açılınca odayı kullanım dışı yap</label><select name="autoOutOfOrder"><option value="true" ${records.settings.autoOutOfOrder!==false?'selected':''}>Evet</option><option value="false" ${records.settings.autoOutOfOrder===false?'selected':''}>Hayır</option></select></div></div><div class="modal-actions"><button class="primary-button">Tercihleri kaydet</button></div></form></section><section class="setting-card"><h3>Firebase bağlantısı</h3><p class="panel-meta">Veriler gerçek zamanlı olarak Realtime Database ile eşitleniyor.</p><span class="status-badge">${firebaseReady?'Bağlı':'Bağlantı yok'}</span></section><section class="setting-card"><h3>Güvenlik</h3><p class="panel-meta">Rol ataması ve kullanıcı aktifliği yalnızca admin tarafından yönetilebilir. Kayıt olan kullanıcılar varsayılan olarak beklemededir.</p><span class="status-badge">Rol kontrollü</span></section></div>`; }
function usersManagementView(){ const rows=recordRows('users'); return `${shellHeading('Yönetim','Kullanıcılar','Kayıt olan personelin rolünü ve aktiflik durumunu belirleyin.')}<div class="filter-row"><span class="panel-meta">Yeni kayıtlar otomatik Firebase UID ile burada görünür. Rol verilene kadar beklemede kalır.</span></div><section class="panel"><table class="table"><thead><tr><th>PERSONEL</th><th>E-POSTA</th><th>ROL</th><th>DURUM</th><th></th></tr></thead><tbody>${rows.length?rows.map(([id,item])=>`<tr><td><strong>${esc(item.full_name||'-')}</strong><br><span class="panel-meta">UID: ${esc(id)}</span></td><td>${esc(item.email||'-')}</td><td>${esc(roleLabels[item.role]||item.role||'Rol bekliyor')}</td><td><span class="status-badge ${item.is_active===false?'open':''}">${item.is_active===false?'Beklemede':'Aktif'}</span></td><td><div class="table-actions"><button class="mini-button" data-action="edit-user" data-id="${esc(id)}">Rolü düzenle</button><button class="mini-button" data-action="delete-user" data-id="${esc(id)}">Sil</button></div></td></tr>`).join(''):'<tr><td colspan="5" class="empty-state">Henüz kayıt olan personel bulunmuyor.</td></tr>'}</tbody></table></section>`; }
function operationalView(type){ const isIssue=type==='issues'; const rows=recordRows(type); return `${shellHeading(isIssue?'Operasyon / Takip':'Operasyon / Misafir deneyimi',isIssue?'Sorunlar':'Misafir talepleri',isIssue?'Bakım ve arıza kayıtlarını yönetin.':'Misafir taleplerini ekibe atayın ve takip edin.',isIssue?'issue':'request')}<section class="panel"><table class="table"><thead><tr><th>${isIssue?'SORUN':'TALEP'}</th><th>ODA</th><th>ÖNCELİK</th><th>ATANAN</th><th>DURUM</th><th></th></tr></thead><tbody>${rows.length?rows.map(([id,item])=>`<tr><td><strong>${esc(item.title||item.requestType||'-')}</strong><br><span class="panel-meta">${esc(item.description||'')}</span></td><td>${esc(item.roomNumber||'-')}</td><td><span class="priority ${item.priority==='high'||item.priority==='urgent'?'high':'medium'}">${priorityText[item.priority]||item.priority||'Normal'}</span></td><td>${esc(item.assignedTo||'Atanmadı')}</td><td><span class="status-badge ${item.status==='open'?'open':item.status==='in_progress'?'progress':''}">${statusText[item.status]||item.status||'-'}</span></td><td><div class="table-actions"><button class="mini-button" data-action="edit-${isIssue?'issue':'request'}" data-id="${esc(id)}">Düzenle</button><button class="mini-button" data-action="delete-${isIssue?'issue':'request'}" data-id="${esc(id)}">Sil</button></div></td></tr>`).join(''):'<tr><td colspan="6" class="empty-state">Henüz kayıt bulunmuyor.</td></tr>'}</tbody></table></section>`; }
function reportsView(){ const roomCounts=rooms.reduce((acc,room)=>{acc[room[2]]=(acc[room[2]]||0)+1;return acc;},{}); return `${shellHeading('Yönetim','Raporlar','Operasyonun güncel durumunu tek ekranda inceleyin.')}<section class="stats-grid">${stat('TOPLAM ODA',rooms.length,'Kayıtlı oda','▦')}${stat('TEMİZ ODA',roomCounts.clean||0,'Güncel durum','✓')}${stat('AÇIK SORUN',recordRows('issues').filter(([,item])=>item.status!=='resolved'&&item.status!=='closed').length,'Çözüm bekleyen','△')}${stat('BEKLEYEN TALEP',recordRows('guest_requests').filter(([,item])=>item.status!=='completed').length,'Misafir işleri','♧')}</section><section class="panel" style="padding:22px"><h2 class="panel-title">Durum dağılımı</h2><div class="room-stats" style="margin-top:18px">${Object.entries(labels).map(([key,label])=>`<span><b>${roomCounts[key]||0}</b> ${label}</span>`).join('')}</div></section>`; }
function cafeOrderRows(){ return recordRows('guest_requests').filter(([, item]) => item.requestType === 'cafe'); }
function cafeMoney(value){ return Number(value || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function cafeOrderForm(){
  const products=Object.entries(records.cafe_products || {}).filter(([, item])=>item.active!==false).sort((a,b)=>(Number(a[1].sortOrder)||0)-(Number(b[1].sortOrder)||0));
  return `<form class="management-form" data-form="cafe-order"><div class="form-grid"><div class="form-field"><label>Oda numarası</label><input name="roomNumber" required></div><div class="form-field"><label>Misafir adı</label><input name="guestName" required></div><div class="form-field full"><label>Ürünler</label><textarea name="itemsText" rows="7" placeholder="Ürün adı | adet&#10;Örn. Türk kahvesi | 2" required></textarea><p class="panel-meta">Menü: ${products.map(([, item])=>`${esc(item.name)} (${cafeMoney(item.price)} TRY)`).join(', ') || 'Ürün yok'}</p></div><div class="form-field full"><label>Not</label><textarea name="description" rows="2"></textarea></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Siparişi oluştur</button></div></form>`;
}
function cafeOrderPaymentForm(id){
  const item=records.guest_requests?.[id] || {};
  return `<form class="management-form" data-form="cafe-payment" data-id="${esc(id)}"><p class="panel-meta">${esc(item.guestName || 'Misafir')} · Oda ${esc(item.roomNumber || '-')} · Toplam ${cafeMoney(item.total)} TRY</p><div class="form-grid"><div class="form-field"><label>Ödeme yöntemi</label><select name="paymentMethod"><option value="cash">Nakit</option><option value="card">Kart / POS</option><option value="room_charge">Odaya aktar</option></select></div><div class="form-field"><label>Alınan tutar</label><input type="number" name="paidAmount" min="0" step="0.01" value="${esc(item.total || 0)}" required></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Ödemeyi al ve hesabı kapat</button></div></form>`;
}
function cafeView(){
  const products=Object.entries(records.cafe_products || {}).map(([id,item])=>({id,...item})).sort((a,b)=>(Number(a.sortOrder)||0)-(Number(b.sortOrder)||0));
  const orders=cafeOrderRows();
  const paid=orders.filter(([, item])=>item.paymentStatus==='paid');
  const open=orders.filter(([, item])=>item.paymentStatus!=='paid' && item.status!=='closed');
  const today=new Date().toLocaleDateString('en-CA');
  const todaySales=paid.filter(([, item])=>new Date(item.paidAt || item.createdAt || 0).toLocaleDateString('en-CA')===today).reduce((sum,[,item])=>sum+Number(item.total||0),0);
  const rows=orders.slice(0,80);
  return `${shellHeading('Yönetim / POS','Cafe','Sipariş alın, ödeme kaydedin, hesap kapatın ve günlük satışları izleyin.')}<div class="cafe-toolbar"><button class="primary-button" data-action="cafe-order">＋ Yeni sipariş</button>${stat('AÇIK HESAP',open.length,'Ödeme bekleyen','◷')}${stat('BUGÜNÜN SATIŞI',`${cafeMoney(todaySales)} TRY`,'Ödenen cafe siparişleri','₺')}${stat('TOPLAM SİPARİŞ',orders.length,'Kayıtlı sipariş','☕')}</div><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Siparişler</h2><p class="panel-meta">POS işlem geçmişi ve açık hesaplar</p></div></div><div class="table-scroll"><table class="table"><thead><tr><th>SİPARİŞ</th><th>ODA</th><th>ÜRÜNLER</th><th>TUTAR</th><th>DURUM</th><th></th></tr></thead><tbody>${rows.length?rows.map(([id,item])=>`<tr><td><strong>${esc(item.guestName||'Misafir')}</strong><br><span class="panel-meta">${formatDateTime(item.createdAt)}</span></td><td>${esc(item.roomNumber||'-')}</td><td class="cafe-order-items">${esc(cafeItemsText(item.items))}</td><td class="cafe-order-total">${cafeMoney(item.total)} ${esc(item.currency||'TRY')}</td><td><span class="status-badge ${item.paymentStatus==='paid'?'':'open'}">${item.paymentStatus==='paid'?'Ödendi':item.status==='closed'?'Kapandı':'Açık hesap'}</span>${item.paymentMethod?`<br><small class="panel-meta">${item.paymentMethod==='card'?'POS':item.paymentMethod==='room_charge'?'Odaya aktar':'Nakit'}</small>`:''}</td><td><div class="table-actions">${item.paymentStatus==='paid'?'<span class="panel-meta">Hesap kapalı</span>':`<button class="mini-button" data-action="pay-cafe-order" data-id="${esc(id)}">Ödeme al</button><button class="mini-button" data-action="close-cafe-order" data-id="${esc(id)}">Hesabı kapat</button>`}</div></td></tr>`).join(''):'<tr><td colspan="6" class="empty-state">Henüz cafe siparişi yok.</td></tr>'}</tbody></table></div></section><section class="panel" style="padding:20px"><div class="panel-head"><div><h2 class="panel-title">Menü ürünleri</h2><p class="panel-meta">${products.length} kayıtlı ürün · Ürün adı, fiyat, kategori ve görünürlük yönetimi</p></div><button class="outline-button" data-action="cafe-product">＋ Yeni ürün</button></div><div class="table-scroll"><table class="table"><thead><tr><th>ÜRÜN</th><th>KATEGORİ</th><th>FİYAT</th><th>DURUM</th><th></th></tr></thead><tbody>${products.length?products.map(item=>`<tr class="${item.active===false?'cafe-inactive':''}"><td><strong>${esc(item.name||'-')}</strong><br><span class="panel-meta">${esc(item.description||'')}</span></td><td>${esc(item.category||'-')}</td><td>${cafeMoney(item.price)} TRY</td><td><span class="status-badge ${item.active===false?'open':''}">${item.active===false?'Pasif':'Aktif'}</span></td><td><div class="table-actions"><button class="mini-button" data-action="edit-cafe-product" data-id="${esc(item.id)}">Düzenle</button><button class="mini-button" data-action="toggle-cafe-product" data-id="${esc(item.id)}">${item.active===false?'Aktifleştir':'Pasifleştir'}</button><button class="mini-button" data-action="delete-cafe-product" data-id="${esc(item.id)}">Sil</button></div></td></tr>`).join(''):'<tr><td colspan="5" class="empty-state">Kayıtlı ürün yok. Yeni ürün ekleyerek menüyü oluşturun.</td></tr>'}</tbody></table></div></section>`;
}
function notificationsView(){
  const logs=recordRows('manual_notification_logs').slice(0,20); const settings=records.settings || {};
  const floors=[...new Set(rooms.map(([, , ,floor])=>floor || 'Diğer'))];
  const roomGroups=floors.map(floor=>`<div class="notification-room-group"><strong>${esc(floor)}</strong><div class="notification-room-grid">${rooms.filter(([, , ,roomFloor])=>(roomFloor || 'Diğer')===floor).map(([number])=>`<label class="notification-room-option"><input type="checkbox" name="rooms" value="${esc(number)}"><span>Oda ${esc(number)}</span></label>`).join('')}</div></div>`).join('');
  return `${shellHeading('Yönetim','Özel Bildirimler','Toplu bildirim gönderin ve checkout bildirimlerini otomatikleştirin.')}<section class="settings-grid"><section class="setting-card"><h3>Toplu bildirim gönder</h3><form class="management-form" data-form="manual-notification"><div class="form-field full"><div class="notification-selection-head"><div><label>Gönderilecek odalar</label><p class="panel-meta"><span data-selected-room-count>0</span> oda seçildi</p></div><div class="notification-selection-actions"><button type="button" class="mini-button" data-select-all-rooms>Tümünü seç</button><button type="button" class="mini-button" data-clear-rooms>Temizle</button></div></div><input class="notification-room-search" type="search" data-room-search placeholder="Oda numarası veya kat ara" aria-label="Oda ara"><div class="notification-room-groups">${roomGroups}</div></div><div class="form-grid"><div class="form-field full"><label>Başlık</label><input name="title" value="${esc(settings.hotelName || 'Cityport Hotel')}" required></div><div class="form-field full"><label>Mesaj şablonu</label><textarea name="body" rows="5" required>${esc(settings.notificationTemplate || '')}</textarea></div><div class="form-field full"><label>Bağlantı</label><input name="url" value="/" placeholder="/"></div></div><div class="modal-actions"><button class="primary-button" type="submit">Bildirimi gönder</button></div></form></section><section class="setting-card"><h3>Checkout otomasyonu</h3><p class="panel-meta">Uygulama açıkken belirlenen saatte backend aktif checkout odalarını tarar. Backend aynı oda ve gün için ikinci gönderimi engeller.</p><form class="management-form" data-form="checkout-settings"><div class="form-grid"><div class="form-field"><label>Otomatik gönderim</label><select name="checkoutAutoEnabled"><option value="true" ${settings.checkoutAutoEnabled!==false?'selected':''}>Açık</option><option value="false" ${settings.checkoutAutoEnabled===false?'selected':''}>Kapalı</option></select></div><div class="form-field"><label>Gönderim saati (İstanbul)</label><input type="time" name="checkoutAutoTime" value="${esc(settings.checkoutAutoTime || '09:00')}" required></div><div class="form-field full"><label>Checkout mesaj şablonu</label><textarea name="checkoutTemplate" rows="5" required>${esc(settings.checkoutTemplate || 'TR: Bugün çıkış gününüz. Lütfen odanızı saat 12:00\'ye kadar boşaltmanız ricadır.\n\nEN: Today is your checkout day. Please vacate your room by 12:00.')}</textarea></div></div><div class="modal-actions"><button class="primary-button">Checkout ayarlarını kaydet</button></div></form></section></section><section class="setting-card" style="margin-top:16px"><h3>Son manuel gönderimler</h3><div class="notification-log-list">${logs.length?logs.map(([,item])=>`<div class="notification-log"><strong>${item.room?'Oda '+esc(item.room):'Toplu gönderim'}</strong><span>${esc(item.title||'-')}</span><small>${esc(item.result||'-')} · ${formatDateTime(item.sentAt)}</small></div>`).join(''):'<p class="empty-state">Henüz manuel bildirim gönderilmedi.</p>'}</div></section>`;
}
function startCheckoutMonitor(){
  if(checkoutMonitorTimer||currentRole!=='admin'||!settingsLoaded) return;
  const check=async()=>{
    const settings=records.settings || {}; if(settings.checkoutAutoEnabled===false) return;
    const now=new Date(); const time=now.toLocaleTimeString('en-GB',{timeZone:'Europe/Istanbul',hour:'2-digit',minute:'2-digit'}); if(time < (settings.checkoutAutoTime || '09:00')) return;
    const day=now.toLocaleDateString('en-CA',{timeZone:'Europe/Istanbul'}); if(sessionStorage.getItem(`checkout-push-${day}`)) return;
    try { const token=await getAccessToken(); const response=await fetch('/api/send-push',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({body:settings.checkoutTemplate||undefined,title:settings.hotelName||'Cityport Hotel',url:'/'})}); const result=await response.json(); if(!response.ok) throw new Error(result.error||'checkout push failed'); if(result.results?.length){ sessionStorage.setItem(`checkout-push-${day}`,'1'); showToast('Checkout bildirim kontrolü tamamlandı.'); } } catch(error){ console.warn('Checkout otomatik bildirimi başarısız:',error); }
  };
  check(); checkoutMonitorTimer=setInterval(check, 5*60*1000);
}
roleViews.admin.push('settings','notifications');
function roomActivity(roomNumber){
  const issues=recordRows('issues').filter(([,item])=>String(item.roomNumber)===String(roomNumber)&&!['resolved','closed'].includes(item.status));
  const requests=recordRows('guest_requests').filter(([,item])=>String(item.roomNumber)===String(roomNumber)&&item.status!=='completed');
  return {issues,requests};
}
function isCleaningRequest(item){
  const requestText = `${item.requestType || ''} ${item.title || ''} ${item.description || ''}`.toLocaleLowerCase('tr-TR');
  return /temiz|cleaning|housekeeping/.test(requestText);
}
function hasActiveCleaningRequest(requests){
  return requests.some(([, item]) => item.status !== 'completed' && isCleaningRequest(item));
}
function doNotDisturbText(doNotDisturb){
  if(!doNotDisturb) return 'Rahatsız Etmeyin bilgisi bulunmuyor';
  return `Rahatsız Etmeyin: ${doNotDisturb.enabled ? 'Açık' : 'Kapalı'}${doNotDisturb.updatedAt ? ` · ${formatDateTime(doNotDisturb.updatedAt)}` : ''}`;
}
function allowedRoomStatuses(role, roomKey){
  if(roomKey==='broken' && role!=='admin') return [];
  if(role==='housekeeper') return roomKey==='dirty' ? ['progress'] : [];
  return roomStatusPermissions[role] || [];
}
function addFrontDeskRoomStatusChoices(){
  if(currentRole!=='front_desk') return;
  document.querySelectorAll('.room-card[data-room]').forEach(card=>{
    const room=rooms.find(item=>item[0]===card.dataset.room);
    const choices=room&&allowedRoomStatuses(currentRole,room[2]).filter(key=>key!==room[2]);
    const actions=card.querySelector('.room-card-actions');
    if(!choices?.length||!actions||actions.querySelector('.front-desk-status-choices')) return;
    const container=document.createElement('div');
    container.className='room-status-choices front-desk-status-choices';
    container.setAttribute('aria-label','Yeni oda durumu');
    container.innerHTML=choices.map(key=>`<button class="room-status-choice status-choice-${esc(key)}" data-action="set-room-status" data-room="${esc(room[0])}" data-status-key="${esc(key)}">${labels[key]}</button>`).join('');
    actions.appendChild(container);
  });
}
function roomStatusForm(room){
  const options=allowedRoomStatuses(currentRole, room[2]);
  return `<form class="management-form" data-form="room-status" data-room="${esc(room[0])}"><p class="panel-meta">${esc(room[0])} numaralı oda için izin verilen durumu seçin.</p><div class="form-field"><label>Yeni oda durumu</label><select name="statusKey" required>${options.map(key=>`<option value="${key}" ${key===room[2]?'selected':''}>${labels[key]}</option>`).join('')}</select></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Durumu kaydet</button></div></form>`;
}
function formatDateTime(value){ return value ? new Date(value).toLocaleString('tr-TR',{dateStyle:'short',timeStyle:'short'}) : ''; }
function removeCompletedRequestsForRoom(roomNumber){
  const completed=recordRows('guest_requests').filter(([id,item])=>String(item.roomNumber)===String(roomNumber)&&item.status==='completed');
  return Promise.all(completed.map(([id])=>removeRecord('guest_requests',id)));
}
function roomCards(sourceRooms=rooms){ return sourceRooms.map(([number,status,key,floor,,guestName,occupied,doNotDisturb]) => { const activity=roomActivity(number); const hasCleaningRequest=hasActiveCleaningRequest(activity.requests); const statusChoices=allowedRoomStatuses(currentRole,key).filter(nextKey=>nextKey!==key); const canAddRequest=currentRole!=='housekeeper'; const isHousekeepingStart=currentRole==='housekeeper'&&statusChoices.includes('progress')&&key==='dirty'&&(!occupied||hasCleaningRequest)&&!doNotDisturb?.enabled; return `<article class="room-card ${isHousekeepingStart?'housekeeping-room-card':''}" data-room-interaction data-status="${esc(key)}" data-room="${esc(number)}" data-action="room-details"><div class="room-card-top"><div><h3>${esc(number)}</h3><p>${esc(floor)}</p>${guestName?`<p class="room-guest-name"><span class="room-guest-icon" aria-hidden="true">●</span>${esc(guestName)}</p>`:''}</div><span class="room-status ${esc(key)}"><i></i>${esc(status)}</span></div><div class="room-alerts">${occupied?'<span class="room-alert occupied-alert"><span class="room-alert-icon" aria-hidden="true">●</span>Dolu</span>':'<span class="room-alert vacant-alert"><span class="room-alert-icon" aria-hidden="true">○</span>Boş</span>'}${key==='dirty'&&occupied&&!hasCleaningRequest?'<span class="room-alert request-alert"><span class="room-alert-icon" aria-hidden="true">⌁</span>Temizlik talebi yok</span>':''}${hasCleaningRequest?'<span class="room-alert request-alert"><span class="room-alert-icon" aria-hidden="true">✓</span>Temizlik talebi</span>':''}${doNotDisturb?.enabled?`<span class="room-alert dnd-alert"><span class="room-alert-icon" aria-hidden="true">⊘</span>Rahatsız Etmeyin: Açık</span>`:''}${activity.issues.length?`<span class="room-alert issue-alert"><span class="room-alert-icon" aria-hidden="true">!</span>${activity.issues.length} sorun</span>`:''}${!activity.requests.length&&!activity.issues.length&&!doNotDisturb?'<span class="room-clear"><span class="room-alert-icon" aria-hidden="true">✓</span>Açık kayıt yok</span>':''}</div><div class="room-dnd-status"><span class="room-dnd-icon" aria-hidden="true">⊘</span>${esc(doNotDisturbText(doNotDisturb))}</div><div class="room-card-actions ${isHousekeepingStart?'has-housekeeping-start':''}">${canAddRequest?`<button class="mini-button room-request-action" data-action="add-room-request" data-room="${esc(number)}"><span aria-hidden="true">＋</span> Talep ekle</button>`:''}${statusChoices.length&&isHousekeepingStart?`<div class="room-status-choices ${isHousekeepingStart?'housekeeping-start-choice':''}" aria-label="Yeni oda durumu">${statusChoices.map(nextKey=>`<button class="room-status-choice status-choice-${esc(nextKey)}" data-action="set-room-status" data-room="${esc(number)}" data-status-key="${esc(nextKey)}"><span aria-hidden="true">▶</span>Temizliğe başla</button>`).join('')}</div>`:''}</div>${currentRole==='admin'?`<div class="room-admin-actions"><button class="mini-button room-admin-action" data-action="edit-room" data-id="${esc(number)}">Düzenle</button><button class="mini-button room-admin-action" data-action="delete-room" data-id="${esc(number)}">Sil</button></div>`:''}</article>`; }).join(''); }
function dashboard(){ const counts=rooms.reduce((acc,room)=>{acc[room[2]]=(acc[room[2]]||0)+1;return acc;},{}); const openIssues=recordRows('issues').filter(([,item])=>!['resolved','closed'].includes(item.status)).length; const pendingRequests=recordRows('guest_requests').filter(([,item])=>item.status!=='completed').length; return `${shellHeading(new Date().toLocaleDateString('tr-TR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}),'Günaydın, '+esc(currentName().split(' ')[0]),'Bugünün operasyon özeti ve ekip durumu burada.')}<section class="stats-grid">${stat('TOPLAM ODA',rooms.length,'Kayıtlı oda','▦')}${stat('TEMİZ ODA',counts.clean||0,'Güncel durum','✓')}${stat('AÇIK SORUN',openIssues,'Çözüm bekleyen','△')}${stat('BEKLEYEN TALEP',pendingRequests,'Misafir işleri','♧')}</section><div class="content-grid"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Oda durumu</h2><p class="panel-meta">Gerçek zamanlı Firebase verisi</p></div><button class="text-link" data-view="rooms">Tüm odaları gör →</button></div><div class="room-summary"><div class="room-head"><strong>${rooms.length} oda</strong><div class="legend"><span><i class="clean"></i>Temiz</span><span><i class="dirty"></i>Kirli</span><span><i class="progress"></i>İşlemde</span></div></div><div class="room-bars"><span class="clean" style="width:${rooms.length?(counts.clean||0)/rooms.length*100:0}%"></span><span class="dirty" style="width:${rooms.length?(counts.dirty||0)/rooms.length*100:0}%"></span><span class="progress" style="width:${rooms.length?(counts.progress||0)/rooms.length*100:0}%"></span><span class="inspect" style="width:${rooms.length?(counts.inspect||0)/rooms.length*100:0}%"></span><span class="broken" style="width:${rooms.length?(counts.broken||0)/rooms.length*100:0}%"></span></div><div class="room-stats">${Object.entries(labels).map(([key,label])=>`<span><b>${counts[key]||0}</b> ${label}</span>`).join('')}</div></div></section><aside class="panel"><div class="panel-head"><div><h2 class="panel-title">Hızlı işlemler</h2><p class="panel-meta">Sık kullanılan aksiyonlar</p></div></div><div class="quick-actions"><button class="quick-action" data-action="issue"><span>△</span>Sorun bildir</button><button class="quick-action" data-action="request"><span>♧</span>Talep oluştur</button><button class="quick-action" data-view="rooms"><span>▦</span>Odaları görüntüle</button><button class="quick-action" data-action="sync"><span>↻</span>Verileri eşitle</button></div></aside></div>`; }
function roomDetails(number){
  const room=rooms.find(item=>String(item[0])===String(number)); const activity=roomActivity(number); const allRequests=recordRows('guest_requests').filter(([,item])=>String(item.roomNumber)===String(number)); const allIssues=recordRows('issues').filter(([,item])=>String(item.roomNumber)===String(number));
  const list=(items,empty,type)=>items.length?`<ul class="room-detail-list">${items.map(([id,item])=>`<li><div class="room-detail-item-head"><strong>${esc(item.title||item.requestType||'Kayıt')}</strong>${type==='request'?`<button class="complete-request-button ${item.status==='completed'?'is-complete':''}" data-action="complete-request" data-id="${esc(id)}" data-room="${esc(number)}" aria-label="Talebi tamamla" ${item.status==='completed'?'disabled':''}>✓</button>`:issueManageRoles.includes(currentRole)?`<span class="detail-actions"><button class="complete-request-button ${['resolved','closed'].includes(item.status)?'is-complete':''}" data-action="complete-issue" data-id="${esc(id)}" data-room="${esc(number)}" aria-label="Sorunu tamamla" ${['resolved','closed'].includes(item.status)?'disabled':''}>✓</button><button class="detail-delete-button" data-action="delete-issue" data-id="${esc(id)}" data-room="${esc(number)}" aria-label="Sorunu sil">×</button></span>`:''}</div><span>${esc(item.description||'Açıklama eklenmemiş')}</span><small>${statusText[item.status]||item.status||'Açık'} · ${priorityText[item.priority]||item.priority||'Normal'}${item.completedAt?` · Tamamlandı: ${esc(formatDateTime(item.completedAt))}`:''}</small></li>`).join('')}</ul>`:`<p class="room-detail-empty">${empty}</p>`;
  modal(`${esc(number)} numaralı oda`, `<div class="room-detail-summary"><span class="room-status ${esc(room?.[2]||'')}">${esc(room?.[1]||'')}</span><span>${esc(room?.[3]||'')}</span><button class="room-issue-button" data-action="report-room-issue" data-room="${esc(number)}">△ Sorun bildir</button></div><section class="room-detail-section"><h3>Misafir talepleri <b>${allRequests.length}</b></h3>${list(allRequests,'Misafir talebi yok.','request')}</section><section class="room-detail-section"><h3>Sorunlar <b>${allIssues.length}</b></h3>${list(allIssues,'Sorun kaydı yok.','issue')}</section>`, 'roomDetailsModal');
}
function roomsView(){ const visibleRooms=rooms.filter(([number,,key,floor])=>(roomFloorFilter==='all'||floor===roomFloorFilter)&&(roomStatusFilter==='all'||key===roomStatusFilter)); const floors=[...new Set(rooms.map(([, , ,floor])=>floor))]; const filterBody=`<div class="room-filter-modal"><div class="filter-modal-group"><strong>Kat</strong><div class="filter-modal-options"><button class="filter ${roomFloorFilter==='all'?'active':''}" data-room-floor="all">Tüm katlar</button>${floors.map(floor=>`<button class="filter ${roomFloorFilter===floor?'active':''}" data-room-floor="${esc(floor)}">${esc(floor)}</button>`).join('')}</div></div></div>`; const statusOptions=Object.entries(labels).map(([key,label])=>`<option value="${key}" ${roomStatusFilter===key?'selected':''}>${label}</option>`).join(''); return `<div class="page-heading room-page-heading"><div><p class="eyebrow">Operasyon / Odalar</p><h1>Odalar</h1></div></div><div class="room-toolbar"><span class="panel-meta">${visibleRooms.length} oda gösteriliyor</span><div class="room-toolbar-actions"><select class="room-status-select" data-room-status-select aria-label="Oda durumuna göre filtrele"><option value="all" ${roomStatusFilter==='all'?'selected':''}>Tüm durumlar</option>${statusOptions}</select><button class="filter-open-button" data-action="open-room-filters">☷ Kat filtresi</button>${currentRole==='admin'?'<button class="filter-open-button" data-action="bulk-rooms">＋ Toplu oda ekle</button>':''}</div></div><section class="panel room-panel"><div class="rooms-grid">${visibleRooms.length?roomCards(visibleRooms):'<p class="empty-state">Bu filtrelerde oda bulunmuyor.</p>'}</div></section><div class="room-filter-template" hidden>${filterBody}</div>`; }
function render(view=currentView){
  if (!canAccess(view)) view='dashboard';
  currentView=view;
  const views={dashboard,rooms:roomsView,issues:()=>operationalView('issues'),requests:()=>operationalView('guest_requests'),reports:reportsView,users:usersManagementView,notifications:notificationsView,settings:settingsView,cafe:cafeView};
  app.innerHTML=(views[view]||dashboard)()
    .replaceAll('Gerçek zamanlı Firebase verisi','Supabase verisi')
    .replaceAll('Firebase bağlantısı','Supabase Auth')
    .replaceAll('Firebase Auth UID','Supabase Auth UID')
    .replaceAll('Yeni kayıtlar otomatik Firebase UID ile burada görünür.','Yeni hesaplar Supabase Auth UID ile burada görünür.')
    .replaceAll('manuel Firebase bildirimi','manuel FCM bildirimi');
  addFrontDeskRoomStatusChoices();
  const activeTitle={dashboard:'Genel Bakış',rooms:'Odalar',issues:'Sorunlar',requests:'Misafir Talepleri',reports:'Raporlar',users:'Kullanıcılar',notifications:'Özel Bildirimler',settings:'Otel Ayarları',cafe:'Cafe'}[view];
  title.textContent=activeTitle;
  document.querySelectorAll('.nav-item[data-view]').forEach(item=>{item.classList.toggle('active',item.dataset.view===view);item.hidden=!item.dataset.roles.split(',').includes(currentRole);});
  updateNavCounts();
  applyHotelName();
}
function settingsView(){
  const settings=records.settings||{};
  return `${shellHeading('Yönetim','Otel ayarları','Otel kimliğini, vardiya düzenini ve operasyon tercihlerini yönetin.')}<div class="settings-grid"><section class="setting-card"><h3>Otel bilgileri</h3><p class="panel-meta">Uygulamanın görünen tesis bilgileri.</p><form class="management-form" data-form="settings"><div class="form-grid"><div class="form-field full"><label>Otel adı</label><input name="hotelName" value="${esc(settings.hotelName||'Cityport Hotel')}" required></div><div class="form-field"><label>Telefon</label><input name="hotelPhone" value="${esc(settings.hotelPhone||'')}" placeholder="+90"></div><div class="form-field"><label>E-posta</label><input type="email" name="hotelEmail" value="${esc(settings.hotelEmail||'')}" placeholder="info@otel.com"></div><div class="form-field full"><label>Adres</label><textarea name="hotelAddress">${esc(settings.hotelAddress||'')}</textarea></div></div><div class="modal-actions"><button class="primary-button">Otel bilgilerini kaydet</button></div></form></section><section class="setting-card"><h3>Operasyon tercihleri</h3><p class="panel-meta">Dashboard ve oda akışının davranışını belirleyin.</p><form class="management-form" data-form="settings"><div class="form-grid"><div class="form-field"><label>Vardiya başlangıcı</label><input type="time" name="shiftStart" value="${esc(settings.shiftStart||'08:00')}"></div><div class="form-field"><label>Vardiya bitişi</label><input type="time" name="shiftEnd" value="${esc(settings.shiftEnd||'17:00')}"></div><div class="form-field full"><label>Arıza açılınca odayı kullanım dışı yap</label><select name="autoOutOfOrder"><option value="true" ${settings.autoOutOfOrder!==false?'selected':''}>Evet</option><option value="false" ${settings.autoOutOfOrder===false?'selected':''}>Hayır</option></select></div></div><div class="modal-actions"><button class="primary-button">Tercihleri kaydet</button></div></form></section><section class="setting-card"><h3>Kimlik doğrulama ve bildirim</h3><p class="panel-meta">Personel girişi Supabase Auth ile, bildirim teslimatı Firebase Cloud Messaging ile yapılır.</p></section><section class="setting-card"><h3>Güvenlik</h3><p class="panel-meta">Rol ataması ve kullanıcı aktifliği yalnızca admin tarafından yönetilebilir. Yeni personel hesapları varsayılan olarak beklemededir.</p><span class="status-badge">Rol kontrollü</span></section></div>`;
}
function showApp(){
  document.body.classList.remove('logged-out'); document.querySelector('#authScreen').classList.remove('visible');
  const name=currentName(); document.querySelector('#userName').textContent=name; document.querySelector('#userRole').textContent=roleLabels[currentRole]||currentRole; document.querySelector('#userAvatar').textContent=name.slice(0,2).toUpperCase(); document.querySelector('#topAvatar').textContent=name.slice(0,2).toUpperCase();
  attachDataListeners(); render(currentRole==='admin'?'dashboard':'rooms');
}
document.addEventListener('click',(event)=>{
  if(!event.target.closest('[data-action="sync"]'))return;
  event.stopImmediatePropagation();
  refreshManagementData();
},true);
document.addEventListener('click',(event)=>{
  const close=event.target.closest('[data-close-modal]'); if(close){closeModal();return;}
  const selectAllRooms=event.target.closest('[data-select-all-rooms]');
  if(selectAllRooms){const form=selectAllRooms.closest('[data-form="manual-notification"]');const inputs=[...form.querySelectorAll('[name="rooms"]')].filter(input=>!input.closest('.notification-room-group')?.hidden&&!input.closest('.notification-room-option')?.hidden);const shouldSelect=inputs.some(input=>!input.checked);inputs.forEach(input=>{input.checked=shouldSelect;});updateNotificationRoomSelection(form);return;}
  const clearRooms=event.target.closest('[data-clear-rooms]');
  if(clearRooms){const form=clearRooms.closest('[data-form="manual-notification"]');form.querySelectorAll('[name="rooms"]').forEach(input=>{input.checked=false;});updateNotificationRoomSelection(form);return;}
  const floorButton=event.target.closest('[data-room-floor]'); if(floorButton){roomFloorFilter=floorButton.dataset.roomFloor;closeModal();render('rooms');return;}
  const statusButton=event.target.closest('[data-room-status]'); if(statusButton){roomStatusFilter=statusButton.dataset.roomStatus;closeModal();render('rooms');return;}
  const action=event.target.closest('[data-action]')?.dataset.action; if(!action)return;
  if(action==='open-room-filters'){const template=document.querySelector('.room-filter-template');if(template)modal('Oda filtreleri',template.innerHTML);return;}
  if(action==='bulk-rooms'){if(currentRole!=='admin'){showToast('Toplu oda ekleme yalnızca admin içindir.');return;} modal('Toplu oda ekle',bulkRoomForm());return;}
  if(action==='cafe-product'){if(canManageCafe())modal('Yeni cafe ürünü',recordForm('cafe_products'));return;}
  if(action==='cafe-order'){if(canManageCafe())modal('Yeni cafe siparişi',cafeOrderForm());return;}
  if(action==='pay-cafe-order'){if(canManageCafe())modal('POS ödeme al',cafeOrderPaymentForm(event.target.closest('[data-action]').dataset.id));return;}
  if(action==='close-cafe-order'){
    if(!canManageCafe())return;
    const id=event.target.closest('[data-action]').dataset.id;
    patchRecord('guest_requests',id,{status:'closed',paymentStatus:'paid',paymentMethod:'manual_close',paidAt:Date.now(),closedAt:Date.now()}).then(()=>showToast('Cafe hesabı kapatıldı.')).catch(error=>showToast(error.message||'Cafe hesabı kapatılamadı.'));
    return;
  }
  if(action==='edit-cafe-product'){if(canManageCafe())modal('Cafe ürününü düzenle',recordForm('cafe_products',event.target.closest('[data-action]').dataset.id));return;}
  if(action==='toggle-cafe-product'){
    if(!canManageCafe())return;
    const id=event.target.closest('[data-action]').dataset.id; const item=records.cafe_products?.[id];
    if(!item)return;
    patchRecord('cafe_products',id,{active:item.active===false}).then(()=>showToast(item.active===false?'Ürün aktifleştirildi.':'Ürün pasifleştirildi.')).catch(error=>showToast(error.message||'Ürün durumu güncellenemedi.'));
    return;
  }
  if(action==='delete-cafe-product'){
    if(!canManageCafe())return;
    const id=event.target.closest('[data-action]').dataset.id;
    if(!id||!confirm('Bu cafe ürünü silinsin mi?'))return;
    removeRecord('cafe_products',id).then(()=>showToast('Cafe ürünü silindi.')).catch(()=>showToast('Cafe ürünü silinemedi.'));
    return;
  }
  if(action==='room-details'){roomDetails(event.target.closest('[data-room]')?.dataset.room);return;}
  if(action==='add-room-request'){
    const roomNumber=event.target.closest('[data-room]')?.dataset.room;
    if(currentRole==='housekeeper'){showToast('Housekeeping kullanıcıları talep ekleyemez.');return;}
    if(roomNumber)modal(`${roomNumber} numaralı oda için talep`,recordForm('guest_requests','',roomNumber));
    return;
  }
  if(action==='complete-request'){
    const button=event.target.closest('[data-action="complete-request"]'); const id=button?.dataset.id; const roomNumber=button?.dataset.room;
    if(!id)return;
    patchRecord('guest_requests',id,{status:'completed',completedAt:Date.now(),completedBy:currentUser?.uid||null}).then(()=>{closeModal();roomDetails(roomNumber);showToast('Misafir talebi tamamlandı. Oda kirliye alındığında kayıttan kaldırılır.');}).catch(error=>showToast(error.message||'Talep tamamlanamadı.'));
    return;
  }
  if(action==='complete-issue'){
    const button=event.target.closest('[data-action="complete-issue"]'); const id=button?.dataset.id; const roomNumber=button?.dataset.room;
    if(!issueManageRoles.includes(currentRole)){showToast('Sorun güncelleme yetkiniz yok.');return;}
    if(!id)return;
    patchRecord('issues',id,{status:'resolved',completedAt:Date.now(),completedBy:currentUser?.uid||null}).then(()=>{closeModal();roomDetails(roomNumber);showToast('Sorun tamamlandı olarak işaretlendi.');}).catch(error=>showToast(error.message||'Sorun güncellenemedi.'));
    return;
  }
  if(action==='delete-issue'){
    const button=event.target.closest('[data-action="delete-issue"]'); const id=button?.dataset.id; const roomNumber=button?.dataset.room;
    if(!issueManageRoles.includes(currentRole)){showToast('Sorun silme yetkiniz yok.');return;}
    if(!id||!confirm('Bu sorun kaydı silinsin mi?'))return;
    removeRecord('issues',id).then(()=>{closeModal();roomDetails(roomNumber);showToast('Sorun kaydı silindi.');}).catch(()=>showToast('Sorun silinemedi.'));
    return;
  }
  if(action==='report-room-issue'){const roomNumber=event.target.closest('[data-room]')?.dataset.room;if(roomNumber)modal(`${roomNumber} numaralı oda için sorun bildir`,recordForm('issues','',roomNumber));return;}
  if(action==='set-room-status'){
    const room=rooms.find(item=>item[0]===event.target.closest('[data-room]').dataset.room);
    const nextStatus=event.target.closest('[data-status-key]')?.dataset.statusKey;
    if(!room||!allowedRoomStatuses(currentRole,room[2]).includes(nextStatus)||nextStatus===room[2]){showToast('Bu oda durumuna geçiş yetkiniz yok.');return;}
    const previousStatus=room[2]; room[2]=nextStatus; room[1]=labels[nextStatus]; render('rooms'); saveRoomToSupabase(room,previousStatus); showToast(`${room[0]} numaralı oda: ${room[1]}`); return;
  }
  if(action==='room' && currentRole==='admin') modal('Yeni oda ekle',recordForm('rooms'));
  if(action==='issue' && ['admin','supervisor','housekeeper','maintenance','front_desk'].includes(currentRole)) modal('Sorun bildir',recordForm('issues'));
  if(action==='request' && ['admin','supervisor','housekeeper','front_desk'].includes(currentRole)) modal('Yeni misafir talebi',recordForm('guest_requests'));
  if(action==='user' && adminOnly()) modal('Kullanıcı profili ekle',recordForm('users'));
  if(action==='edit-user' && adminOnly()) modal('Kullanıcı profilini düzenle',recordForm('users',event.target.closest('[data-action]').dataset.id));
  if(action==='edit-issue') modal('Sorunu düzenle',recordForm('issues',event.target.closest('[data-action]').dataset.id));
  if(action==='edit-request') modal('Talebi düzenle',recordForm('guest_requests',event.target.closest('[data-action]').dataset.id));
  if(action?.startsWith('delete-')){ const type=action.replace('delete-',''); const path=type==='user'?'users':type==='issue'?'issues':'guest_requests'; const id=event.target.closest('[data-action]').dataset.id; if((path==='users'&&!adminOnly())||!confirm('Bu kayıt silinsin mi?'))return; removeRecord(path,id).then(()=>showToast('Kayıt silindi.')).catch(error=>showToast(`Silme işlemi başarısız: ${error.message||'Firebase izni yok.'}`)); }
});
document.addEventListener('change',(event)=>{
  const statusSelect=event.target.closest('[data-room-status-select]');
  if(statusSelect){ roomStatusFilter=statusSelect.value; render('rooms'); }
  const cafeControl=event.target.closest('[data-cafe-category],[data-cafe-active],[data-cafe-sort]');
  if(cafeControl){ cafeCategoryFilter=document.querySelector('[data-cafe-category]')?.value||'all'; cafeActiveFilter=document.querySelector('[data-cafe-active]')?.value||'all'; cafeSort=document.querySelector('[data-cafe-sort]')?.value||'sortOrder'; render('cafe'); }
  if(event.target.matches('[name="rooms"]')) updateNotificationRoomSelection(event.target.closest('[data-form="manual-notification"]'));
});
document.addEventListener('input',(event)=>{
  if(event.target.matches('[data-cafe-search]')){ cafeSearch=event.target.value; render('cafe'); const input=document.querySelector('[data-cafe-search]'); input?.focus(); input?.setSelectionRange(cafeSearch.length,cafeSearch.length); }
  if(event.target.matches('[data-room-search]')){const query=event.target.value.toLocaleLowerCase('tr-TR').trim();document.querySelectorAll('.notification-room-group').forEach(group=>{const matches=group.textContent.toLocaleLowerCase('tr-TR').includes(query);group.hidden=!matches;group.querySelectorAll('.notification-room-option').forEach(option=>{option.hidden=Boolean(query)&&!option.textContent.toLocaleLowerCase('tr-TR').includes(query);});});}
});
document.addEventListener('submit',(event)=>{
  const form=event.target.closest('.management-form'); if(!form)return; event.preventDefault(); const data=Object.fromEntries(new FormData(form));
  if(form.dataset.form==='manual-notification'){
    const selectedRooms=[...form.querySelectorAll('[name="rooms"]:checked')].map(input=>input.value);
    if(!adminOnly()||!currentUser||!selectedRooms.length||!data.body){showToast('En az bir oda ve mesaj zorunludur.');return;}
    const button=form.querySelector('button[type="submit"]'); button.disabled=true;
    getAccessToken().then(accessToken=>fetch('/api/send-push',{method:'POST',headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},body:JSON.stringify({manual:true,rooms:selectedRooms,title:data.title,body:data.body,url:data.url||'/'})})).then(async response=>{const result=await response.json();if(!response.ok){const detail=result.errorType?` (${result.errorType})`:'';throw new Error(`${result.error||'Bildirim gönderilemedi.'}${detail}`);}return result;}).then(result=>{showToast(`${result.results?.filter(item=>item.result==='sent').length||0}/${selectedRooms.length} odaya bildirim gönderildi.`);form.reset();form.querySelector('[name="url"]').value='/';}).catch(error=>showToast(error.message||'Bildirim gönderilemedi.')).finally(()=>{button.disabled=false;}); return;
  }
  if(form.dataset.form==='checkout-settings'){
    if(!adminOnly())return;
    patchRecord('settings','main',{checkoutAutoEnabled:data.checkoutAutoEnabled==='true',checkoutAutoTime:data.checkoutAutoTime,checkoutTemplate:data.checkoutTemplate}).then(()=>showToast('Checkout otomasyonu kaydedildi.')).catch(error=>showToast(error.message||'Checkout ayarları kaydedilemedi.'));
    return;
  }
  if(form.dataset.form==='cafe-order'){
    if(!canManageCafe())return;
    const productMap=Object.entries(records.cafe_products||{}).filter(([,item])=>item.active!==false).reduce((map,[id,item])=>{map[item.name.toLocaleLowerCase('tr-TR')]={id,...item};return map;},{});
    const items=data.itemsText.split(/\r?\n/).map(line=>line.split('|').map(value=>value.trim())).filter(parts=>parts[0]).map(([name,quantity='1'])=>{const product=productMap[name.toLocaleLowerCase('tr-TR')];return product?{productId:product.id||null,name:product.name,quantity:Math.max(1,Number(quantity)||1),unitPrice:Number(product.price)||0,totalPrice:(Math.max(1,Number(quantity)||1))*(Number(product.price)||0)}:null;}).filter(Boolean);
    if(!items.length){showToast('Menüden geçerli en az bir ürün girin.');return;}
    const total=items.reduce((sum,item)=>sum+item.totalPrice,0); const id=dbKey();
    writeRecord('guest_requests',id,{requestType:'cafe',roomNumber:data.roomNumber.trim(),guestName:data.guestName.trim(),items,total,currency:'TRY',description:data.description.trim(),status:'waiting',paymentStatus:'unpaid'}).then(()=>{closeModal();render('cafe');showToast('Cafe siparişi oluşturuldu.');}).catch(()=>showToast('Cafe siparişi oluşturulamadı.')); return;
  }
  if(form.dataset.form==='cafe-payment'){
    if(!canManageCafe())return;
    const id=form.dataset.id; const order=records.guest_requests?.[id]; const paidAmount=Number(data.paidAmount);
    if(!order||!Number.isFinite(paidAmount)||paidAmount<Number(order.total||0)){showToast('Ödeme tutarı sipariş toplamından küçük olamaz.');return;}
    patchRecord('guest_requests',id,{status:'closed',paymentStatus:'paid',paymentMethod:data.paymentMethod,paidAmount,paidAt:Date.now(),closedAt:Date.now()}).then(()=>{closeModal();render('cafe');showToast('Ödeme alındı, hesap kapatıldı.');}).catch(error=>showToast(error.message||'Ödeme kaydedilemedi.')); return;
  }
  if(form.dataset.form==='settings'){ if(!adminOnly())return; const settings={...data}; if(settings.autoOutOfOrder)settings.autoOutOfOrder=settings.autoOutOfOrder==='true'; patchRecord('settings','main',settings).then(()=>showToast('Ayarlar güncellendi.')).catch(error=>showToast(error.message||'Ayarlar kaydedilemedi.')); return; }
  if(form.dataset.form==='room-status'){
    const room=rooms.find(item=>item[0]===form.dataset.room); const allowed=room&&allowedRoomStatuses(currentRole,room[2]);
    if(!room||!allowed.includes(data.statusKey)){showToast('Bu oda durumuna geçiş yetkiniz yok.');return;}
    const previousStatus=room[2]; room[2]=data.statusKey; room[1]=labels[data.statusKey];
    saveRoomToSupabase(room,previousStatus); closeModal(); render('rooms'); showToast(`${room[0]} numaralı oda: ${room[1]}`); return;
  }
  if(form.dataset.form==='bulk-rooms'){
    if(currentRole!=='admin'){showToast('Toplu oda ekleme yalnızca admin içindir.');return;}
    const parsed=data.roomsText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>line.split(',').map(value=>value.trim()));
    const invalid=parsed.find(parts=>!parts[0]||!parts[1]||!labels[parts[2]]);
    const ids=parsed.map(parts=>parts[0]);
    if(invalid||new Set(ids).size!==ids.length){showToast('Her satır oda no, kat ve geçerli durum içermeli; oda numaraları tekrarlanmamalı.');return;}
    const existing=new Set(rooms.map(room=>String(room[0]))); const duplicate=ids.find(id=>existing.has(String(id)));
    if(duplicate){showToast(`${duplicate} numaralı oda zaten kayıtlı.`);return;}
    Promise.all(parsed.map(([number,floor,statusKey,roomType='Standart'])=>writeRecord('rooms',number,{roomNumber:number,status:labels[statusKey],statusKey,floor,roomType}))).then(()=>{closeModal();showToast(`${parsed.length} oda Supabase'e kaydedildi.`);}).catch(error=>showToast(error.message||'Toplu oda kaydı sırasında hata oluştu.'));
    return;
  }
  if(form.dataset.form==='room'){ if(currentRole!=='admin'){showToast('Oda ekleme yalnızca admin içindir.');return;} const id=data.roomNumber; const key=data.statusKey; const room=[id,labels[key],key,data.floor,data.roomType||'Standart']; const old=rooms.find(item=>item[0]===id); writeRecord('rooms',id,{roomNumber:id,status:room[1],statusKey:key,floor:data.floor,roomType:data.roomType}).then(()=>{if(old){old[1]=room[1];old[2]=room[2];old[3]=room[3];old[4]=room[4];}else rooms.push(room);return key==='dirty'?removeCompletedRequestsForRoom(id):null;}).then(()=>{closeModal();render('rooms');showToast('Oda Supabase\'e kaydedildi.');}).catch(error=>showToast(error.message||'Oda kaydedilemedi.')); return; }
  if(form.dataset.form==='cafe-product'){
    if(!canManageCafe())return;
    const price=Number(data.price); const sortOrder=Number(data.sortOrder);
    if(!data.name.trim()||!Number.isFinite(price)||price<0||!Number.isFinite(sortOrder)){showToast('Ürün adı zorunlu; fiyat negatif olmayan, sıra sayısal olmalıdır.');return;}
    const id=form.dataset.id||dbKey(); const previous=records.cafe_products?.[id]||{};
    const payload={name:data.name.trim(),description:data.description.trim(),price,category:data.category.trim(),image:data.image.trim(),active:data.active==='true',sortOrder,createdAt:previous.createdAt||Date.now()};
    writeRecord('cafe_products',id,payload).then(()=>{closeModal();render('cafe');showToast('Cafe ürünü kaydedildi.');}).catch(()=>showToast('Cafe ürünü kaydedilemedi.'));
    return;
  }
  const type=form.dataset.form==='user'?'users':form.dataset.form==='issue'?'issues':'guest_requests'; const id=form.dataset.id||data.uid||dbKey(); const payload={...data}; if(type==='users')payload.is_active=data.is_active==='true'; if(type==='guest_requests'){payload.requestType=payload.title;delete payload.title;} writeRecord(type,id,payload).then(()=>{closeModal();render(currentView);showToast('Kayıt kaydedildi.');}).catch(()=>showToast('Kayıt kaydedilemedi.'));
});
document.addEventListener('click',(event)=>{
  const actionButton=event.target.closest('.room-admin-action'); if(!actionButton)return;
  event.stopPropagation(); event.preventDefault(); const id=actionButton.dataset.id; const room=rooms.find(item=>item[0]===id);
  if(actionButton.dataset.action==='delete-room'){ if(confirm(`${id} numaralı oda silinsin mi?`)){removeRecord('rooms',id).then(()=>{const index=rooms.findIndex(item=>item[0]===id);if(index>=0)rooms.splice(index,1);render('rooms');showToast('Oda silindi.');}).catch(error=>showToast(error.message||'Oda silinemedi.'));} return; }
  modal('Odayı düzenle',`<form class="management-form" data-form="room" data-id="${esc(id)}"><div class="form-grid"><div class="form-field"><label>Oda numarası</label><input name="roomNumber" value="${esc(room?.[0])}" readonly></div><div class="form-field"><label>Kat</label><input name="floor" value="${esc(room?.[3])}" required></div><div class="form-field"><label>Durum</label><select name="statusKey">${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${room?.[2]===key?'selected':''}>${label}</option>`).join('')}</select></div><div class="form-field"><label>Oda tipi</label><input name="roomType" value="Standart"></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`);
}, true);
