const rooms = [
  ['101','Temiz','clean','Zemin kat'],['102','Kirli','dirty','Zemin kat'],['103','Kontrol edildi','inspect','Zemin kat'],['104','Temizleniyor','progress','Zemin kat'],['105','Temiz','clean','Zemin kat'],['106','Kullanım dışı','broken','Zemin kat'],
  ['201','Temiz','clean','1. kat'],['202','Kirli','dirty','1. kat'],['203','Temiz','clean','1. kat'],['204','Kontrol edildi','inspect','1. kat'],['205','Kirli','dirty','1. kat'],['206','Temiz','clean','1. kat'],
  ['301','Temizleniyor','progress','2. kat'],['302','Temiz','clean','2. kat'],['303','Temiz','clean','2. kat'],['304','Kirli','dirty','2. kat'],['305','Temiz','clean','2. kat'],['306','Kontrol edildi','inspect','2. kat']
];
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
let firebaseListenerAttached = false;
let currentUser = null;
let currentProfile = null;
let currentRole = null;
let registrationInProgress = false;
let roomFloorFilter = 'all';
let roomStatusFilter = 'all';
const roleLabels = { admin:'Yönetici', supervisor:'Süpervizör', housekeeper:'Kat hizmetleri', front_desk:'Ön büro', maintenance:'Teknik servis' };
const roleViews = {
  admin: ['dashboard','rooms','issues','requests','reports','users','settings'],
  supervisor: ['dashboard','rooms','issues','requests','reports'],
  housekeeper: ['dashboard','rooms','issues','requests'],
  front_desk: ['dashboard','rooms','issues','requests'],
  maintenance: ['dashboard','rooms','issues']
};
const issueManageRoles = ['admin','supervisor','front_desk','maintenance'];

function showToast(message){ toast.textContent = message; toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2600); }
function canAccess(view){ return Boolean(currentRole && roleViews[currentRole]?.includes(view)); }
function authMessage(error){
  const messages = { 'auth/invalid-credential':'E-posta veya şifre hatalı.', 'auth/user-disabled':'Bu kullanıcı pasif durumda.', 'auth/too-many-requests':'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.', 'auth/email-already-in-use':'Bu e-posta zaten kayıtlı.', 'auth/weak-password':'Şifre en az 6 karakter olmalı.', 'auth/invalid-email':'Geçerli bir e-posta adresi girin.' };
  return messages[error.code] || 'Giriş yapılamadı. Firebase Authentication ayarlarını kontrol edin.';
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
  loadRoomsFromFirebase();
}
async function loadUserProfile(user){
  if (!firebaseDatabase) throw new Error('Firebase Database hazır değil.');
  const snapshot = await firebaseDatabase.ref(`users/${user.uid}`).once('value');
  const profile = snapshot.val();
  if (!profile?.role || !roleViews[profile.role] || profile.is_active === false) throw new Error('Hesabınıza geçerli bir rol atanmamış.');
  currentProfile = profile;
  currentRole = profile.role;
}
function startAuthentication(){
  if (!firebaseReady || !firebaseAuth) { showLogin('Firebase bağlantısı kurulamadı.'); return; }
  firebaseAuth.onAuthStateChanged(async (user) => {
    currentUser = user;
    if (registrationInProgress) return;
    if (!user) { currentProfile = null; currentRole = null; showLogin(); return; }
    try { await loadUserProfile(user); showApp(); }
    catch (error) { await firebaseAuth.signOut(); showLogin(error.message); }
  });
}
function setSyncState(message, online = true){
  document.querySelector('.online-dot').style.background = online ? '#2eb486' : '#e17a65';
  document.querySelector('.sync-pill span:nth-child(2)').textContent = online ? 'Çevrimiçi' : 'Demo modu';
  document.querySelector('#syncText').textContent = `· ${message}`;
}
function roomRecord([number, status, key, floor]){
  return { roomNumber: number, status, statusKey: key, floor, updatedAt: firebase.database.ServerValue.TIMESTAMP };
}
function saveRoomToFirebase(room, previousStatus){
  if (!firebaseReady || !firebaseDatabase) return;
  const roomRef = firebaseDatabase.ref(`rooms/${room[0]}`);
  roomRef.update(roomRecord(room)).then(() => {
    return firebaseDatabase.ref('room_status_logs').push({ roomId: room[0], oldStatus: previousStatus, newStatus: room[2], changedAt: firebase.database.ServerValue.TIMESTAMP, changedBy: 'demo-supervisor' });
  }).then(() => {
    if(room[2]==='dirty') return removeCompletedRequestsForRoom(room[0]);
  }).then(() => setSyncState('Kaydedildi')).catch((error) => {
    setSyncState('Yetki gerekli', false);
    console.warn('Oda Firebase kaydı başarısız:', error);
    showToast('Firebase yazma izni gerekli.');
  });
}
function loadRoomsFromFirebase(){
  if (!firebaseReady || !firebaseDatabase || firebaseListenerAttached) return;
  firebaseListenerAttached = true;
  firebaseDatabase.ref('rooms').on('value', (snapshot) => {
    const remoteRooms = snapshot.val();
    if (!remoteRooms) {
      firebaseDatabase.ref('rooms').set(Object.fromEntries(rooms.map(room => [room[0], roomRecord(room)]))).then(() => setSyncState('Demo verisi yüklendi')).catch(() => setSyncState('Yetki gerekli', false));
      return;
    }
    const syncedRooms = Object.values(remoteRooms).filter(remoteRoom => remoteRoom?.roomNumber).map(remoteRoom => [
      String(remoteRoom.roomNumber),
      remoteRoom.status || labels[remoteRoom.statusKey] || 'Temiz',
      remoteRoom.statusKey || 'clean',
      remoteRoom.floor || 'Belirtilmemiş',
      remoteRoom.roomType || 'Standart'
    ]).sort((first, second) => first[0].localeCompare(second[0], 'tr', { numeric: true }));
    rooms.splice(0, rooms.length, ...syncedRooms);
    render(currentView);
    setSyncState('Güncel');
  }, () => setSyncState('Yetki gerekli', false));
}
function shellHeading(eyebrow, heading, sub, button=''){ return `<div class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${heading}</h1><p class="subheading">${sub}</p></div>${button ? `<button class="primary-button" data-action="${button}">＋ ${button === 'room' ? 'Yeni oda ekle' : button === 'issue' ? 'Sorun bildir' : 'Yeni talep'}</button>` : ''}</div>`; }
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
  app.innerHTML=(views[view]||dashboard)();
  const activeTitle={dashboard:'Genel Bakış',rooms:'Odalar',issues:'Sorunlar',requests:'Misafir Talepleri',reports:'Raporlar',users:'Kullanıcılar'}[view];
  title.textContent=activeTitle;
  document.querySelectorAll('.nav-item[data-view]').forEach(item=>{ item.classList.toggle('active',item.dataset.view===view); item.hidden=!item.dataset.roles.split(',').includes(currentRole); });
}

document.addEventListener('click',(event)=>{ const viewTarget=event.target.closest('[data-view]'); if(viewTarget){ if(!canAccess(viewTarget.dataset.view)){showToast('Bu bölüme erişim yetkiniz yok.');return;} render(viewTarget.dataset.view); document.querySelector('#sidebar').classList.remove('open'); return;} const action=event.target.closest('[data-action]')?.dataset.action; if(['room-details','change-room-status','set-room-status','report-room-issue','open-room-filters','complete-request','add-room-request','complete-issue','delete-issue'].includes(action))return; if(action){ if(action==='logout'){firebaseAuth?.signOut();return;} if(action==='sync'){showToast('Veriler başarıyla eşitlendi.');setSyncState('Az önce güncellendi');} else {showToast(action==='room'?'Yeni oda formu açılıyor...':action==='issue'?'Sorun bildirim formu açılıyor...':'Misafir talebi formu açılıyor...');} } const card=event.target.closest('.room-card'); if(card && !card.hasAttribute('data-room-interaction')){ if(!['admin','supervisor','housekeeper'].includes(currentRole)){showToast('Oda durumunu güncelleme yetkiniz yok.');return;} const room=rooms.find(item=>item[0]===card.dataset.room); const previousStatus=room[2]; const next={clean:'dirty',dirty:'progress',progress:'inspect',inspect:'clean',broken:'clean'}[room[2]]; room[2]=next; room[1]=labels[next]; render('rooms'); saveRoomToFirebase(room, previousStatus); showToast(`${room[0]} numaralı oda: ${room[1]}`); } });
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
  try { await firebaseAuth.signInWithEmailAndPassword(document.querySelector('#loginEmail').value.trim(), document.querySelector('#loginPassword').value); }
  catch (error) { document.querySelector('#authError').textContent = authMessage(error); }
  finally { button.disabled = false; }
});
document.querySelector('#showRegister').addEventListener('click', showRegisterForm);
document.querySelector('#showLogin').addEventListener('click', showLoginForm);
document.querySelector('#registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form=event.currentTarget; const button=form.querySelector('button[type="submit"]'); button.disabled=true; document.querySelector('#authError').textContent='';
  registrationInProgress=true;
  try {
    const name=document.querySelector('#registerName').value.trim(); const email=document.querySelector('#registerEmail').value.trim(); const password=document.querySelector('#registerPassword').value;
    const result=await firebaseAuth.createUserWithEmailAndPassword(email,password);
    const profileRef=firebaseDatabase.ref(`users/${result.user.uid}`);
    await profileRef.set({full_name:name,email,role:'pending',is_active:false,created_at:firebase.database.ServerValue.TIMESTAMP});
    const profileCheck=await profileRef.once('value');
    if(!profileCheck.exists()) throw new Error('Kullanıcı profili veritabanına yazılamadı.');
    await firebaseAuth.signOut();
    showLoginForm(); document.querySelector('#authError').textContent='Kaydınız oluşturuldu. Admin rolünüzü aktif ettiğinde giriş yapabilirsiniz.'; form.reset();
  } catch(error) { document.querySelector('#authError').textContent=error.code==='auth/operation-not-allowed'?'Firebase Authentication içinde Email/Password sağlayıcısını etkinleştirin.':error.code==='PERMISSION_DENIED'?'Kullanıcı profili yazma izni yok. Firebase Rules içindeki users kuralını güncelleyin.':error.message||authMessage(error); }
  finally { registrationInProgress=false; button.disabled=false; }
});
document.querySelector('#sidebarClose').addEventListener('click',()=>document.querySelector('#sidebar').classList.remove('open'));
showLogin();
startAuthentication();

/* Firebase-backed management layer */
const records = { issues: {}, guest_requests: {}, users: {}, settings: {} };
let dataListenersAttached = false;
const statusText = { open:'Açık', in_progress:'İşlemde', resolved:'Çözüldü', closed:'Kapalı', waiting:'Bekliyor', completed:'Tamamlandı' };
const priorityText = { low:'Düşük', medium:'Orta', high:'Yüksek', urgent:'Acil', normal:'Normal' };

function currentName(){ return currentProfile?.full_name || currentUser?.email || 'Kullanıcı'; }
function dbKey(){ return firebaseDatabase?.ref().push().key; }
function attachDataListeners(){
  if (!firebaseDatabase || dataListenersAttached) return;
  dataListenersAttached = true;
  ['issues','guest_requests','users'].forEach(path => firebaseDatabase.ref(path).on('value', snapshot => { records[path] = snapshot.val() || {}; render(currentView); }, error => { console.warn(`${path} okunamadı`, error); if(path==='users') showToast('Kullanıcı listesi okunamadı. Firebase Rules kontrol edilmeli.'); }));
  firebaseDatabase.ref('settings').on('value', snapshot => { records.settings = snapshot.val() || {}; applyHotelName(); render(currentView); });
}
function applyHotelName(){
  const hotelName = records.settings.hotelName || 'Marina Palace Hotel';
  document.querySelector('.hotel-switcher strong').textContent = hotelName;
  document.querySelector('#hotelNameBreadcrumb').textContent = hotelName.replace(/ Hotel$/,'');
  document.querySelector('.auth-screen .eyebrow').textContent = hotelName;
}
function writeRecord(path, id, value){
  if (!firebaseDatabase) return Promise.reject(new Error('Firebase bağlantısı yok.'));
  return firebaseDatabase.ref(`${path}/${id}`).set({ ...value, updatedAt: firebase.database.ServerValue.TIMESTAMP, updatedBy: currentUser?.uid || null });
}
function removeRecord(path, id){ return firebaseDatabase.ref(`${path}/${id}`).remove(); }
function recordRows(path){ return Object.entries(records[path] || {}).sort((a,b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)); }
function updateNavCounts(){
  const counts = { rooms: rooms.length, issues: recordRows('issues').length, guest_requests: recordRows('guest_requests').length };
  Object.entries(counts).forEach(([key, value]) => { const badge=document.querySelector(`[data-count="${key}"]`); if(badge) badge.textContent=value; });
}
function esc(value=''){ return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char])); }
function modal(titleText, body, id='managementModal'){ let node=document.querySelector(`#${id}`); if(!node){ node=document.createElement('div'); node.id=id; node.className='modal-backdrop'; document.body.appendChild(node); } node.innerHTML=`<div class="modal"><div class="modal-head"><h2>${titleText}</h2><button class="modal-close" data-close-modal aria-label="Kapat">×</button></div>${body}</div>`; node.classList.add('visible'); }
function closeModal(){ document.querySelectorAll('.modal-backdrop').forEach(node => node.classList.remove('visible')); }
function recordForm(type, id='', roomNumber=''){
  const item = records[type]?.[id] || {};
  if(type==='rooms') return `<form class="management-form" data-form="room" data-id="${esc(id)}"><div class="form-grid"><div class="form-field"><label>Oda numarası</label><input name="roomNumber" value="${esc(item.roomNumber || '')}" required ${id?'readonly':''}></div><div class="form-field"><label>Kat</label><input name="floor" value="${esc(item.floor || '')}" placeholder="1. kat" required></div><div class="form-field"><label>Durum</label><select name="statusKey"><option value="clean" ${item.statusKey==='clean'?'selected':''}>Temiz</option><option value="dirty" ${item.statusKey==='dirty'?'selected':''}>Kirli</option><option value="progress" ${item.statusKey==='progress'?'selected':''}>Temizleniyor</option><option value="inspect" ${item.statusKey==='inspect'?'selected':''}>Kontrol edildi</option><option value="broken" ${item.statusKey==='broken'?'selected':''}>Kullanım dışı</option></select></div><div class="form-field"><label>Oda tipi</label><input name="roomType" value="${esc(item.roomType || 'Standart')}" placeholder="Standart"></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`;
  if(type==='users') return `<form class="management-form" data-form="user" data-id="${esc(id)}"><div class="form-grid"><div class="form-field full"><label>Firebase Auth UID</label><input name="uid" value="${esc(id)}" placeholder="Authentication UID" required ${id?'readonly':''}></div><div class="form-field"><label>Ad soyad</label><input name="full_name" value="${esc(item.full_name || '')}" required></div><div class="form-field"><label>E-posta</label><input type="email" name="email" value="${esc(item.email || '')}" required></div><div class="form-field"><label>Rol</label><select name="role"><option value="admin" ${item.role==='admin'?'selected':''}>Yönetici</option><option value="supervisor" ${item.role==='supervisor'?'selected':''}>Süpervizör</option><option value="housekeeper" ${item.role==='housekeeper'?'selected':''}>Kat hizmetleri</option><option value="front_desk" ${item.role==='front_desk'?'selected':''}>Ön büro</option><option value="maintenance" ${item.role==='maintenance'?'selected':''}>Teknik servis</option></select></div><div class="form-field"><label>Durum</label><select name="is_active"><option value="true" ${item.is_active!==false?'selected':''}>Aktif</option><option value="false" ${item.is_active===false?'selected':''}>Pasif</option></select></div></div><p class="panel-meta">Bu işlem profil kaydı oluşturur. Kullanıcının giriş hesabı Firebase Authentication bölümünden ayrıca oluşturulmalıdır.</p><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`;
  const isIssue=type==='issues';
  return `<form class="management-form" data-form="${isIssue?'issue':'request'}" data-id="${esc(id)}"><div class="form-grid"><div class="form-field"><label>Oda numarası</label><input name="roomNumber" value="${esc(item.roomNumber || roomNumber)}" required ${roomNumber?'readonly':''}></div><div class="form-field"><label>Öncelik</label><select name="priority"><option value="normal" ${item.priority==='normal'?'selected':''}>Normal</option><option value="low" ${item.priority==='low'?'selected':''}>Düşük</option><option value="medium" ${item.priority==='medium'?'selected':''}>Orta</option><option value="high" ${item.priority==='high'?'selected':''}>Yüksek</option><option value="urgent" ${item.priority==='urgent'?'selected':''}>Acil</option></select></div><div class="form-field full"><label>${isIssue?'Sorun başlığı':'Talep türü'}</label><input name="title" value="${esc(item.title || item.requestType || '')}" placeholder="${isIssue?'Örn. Klima çalışmıyor':'Ekstra havlu'}" required></div><div class="form-field full"><label>Açıklama</label><textarea name="description">${esc(item.description || '')}</textarea></div><div class="form-field"><label>Durum</label><select name="status"><option value="${isIssue?'open':'waiting'}">${isIssue?'Açık':'Bekliyor'}</option><option value="in_progress" ${item.status==='in_progress'?'selected':''}>İşlemde</option><option value="${isIssue?'resolved':'completed'}" ${item.status==='resolved'||item.status==='completed'?'selected':''}>${isIssue?'Çözüldü':'Tamamlandı'}</option></select></div><div class="form-field"><label>Atanan kişi</label><input name="assignedTo" value="${esc(item.assignedTo || '')}" placeholder="Personel adı"></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`;
}
function bulkRoomForm(){ return `<form class="management-form" data-form="bulk-rooms"><p class="panel-meta">Her satıra şu sırayla yazın: oda numarası, kat, durum anahtarı, oda tipi. Durum anahtarı: clean, dirty, progress, inspect veya broken.</p><div class="form-field"><label>Odalar</label><textarea name="roomsText" rows="8" placeholder="101, Zemin kat, clean, Standart&#10;102, Zemin kat, dirty, Standart&#10;201, 1. kat, clean, Suite" required></textarea></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Odaları kaydet</button></div></form>`; }
function adminOnly(){ if(currentRole!=='admin'){showToast('Bu işlem yalnızca admin içindir.');return false;} return true; }
function settingsView(){ return `${shellHeading('Yönetim','Otel ayarları','Otel kimliğini, vardiya düzenini ve operasyon tercihlerini yönetin.')}<div class="settings-grid"><section class="setting-card"><h3>Otel bilgileri</h3><p class="panel-meta">Uygulamanın görünen tesis bilgileri.</p><form class="management-form" data-form="settings"><div class="form-grid"><div class="form-field full"><label>Otel adı</label><input name="hotelName" value="${esc(records.settings.hotelName || 'Marina Palace Hotel')}" required></div><div class="form-field"><label>Telefon</label><input name="hotelPhone" value="${esc(records.settings.hotelPhone || '')}" placeholder="+90"></div><div class="form-field"><label>E-posta</label><input type="email" name="hotelEmail" value="${esc(records.settings.hotelEmail || '')}" placeholder="info@otel.com"></div><div class="form-field full"><label>Adres</label><textarea name="hotelAddress">${esc(records.settings.hotelAddress || '')}</textarea></div></div><div class="modal-actions"><button class="primary-button">Otel bilgilerini kaydet</button></div></form></section><section class="setting-card"><h3>Operasyon tercihleri</h3><p class="panel-meta">Dashboard ve oda akışının davranışını belirleyin.</p><form class="management-form" data-form="settings"><div class="form-grid"><div class="form-field"><label>Vardiya başlangıcı</label><input type="time" name="shiftStart" value="${esc(records.settings.shiftStart || '08:00')}"></div><div class="form-field"><label>Vardiya bitişi</label><input type="time" name="shiftEnd" value="${esc(records.settings.shiftEnd || '17:00')}"></div><div class="form-field full"><label>Arıza açılınca odayı kullanım dışı yap</label><select name="autoOutOfOrder"><option value="true" ${records.settings.autoOutOfOrder!==false?'selected':''}>Evet</option><option value="false" ${records.settings.autoOutOfOrder===false?'selected':''}>Hayır</option></select></div></div><div class="modal-actions"><button class="primary-button">Tercihleri kaydet</button></div></form></section><section class="setting-card"><h3>Firebase bağlantısı</h3><p class="panel-meta">Veriler gerçek zamanlı olarak Realtime Database ile eşitleniyor.</p><span class="status-badge">${firebaseReady?'Bağlı':'Bağlantı yok'}</span></section><section class="setting-card"><h3>Güvenlik</h3><p class="panel-meta">Rol ataması ve kullanıcı aktifliği yalnızca admin tarafından yönetilebilir. Kayıt olan kullanıcılar varsayılan olarak beklemededir.</p><span class="status-badge">Rol kontrollü</span></section></div>`; }
function usersManagementView(){ const rows=recordRows('users'); return `${shellHeading('Yönetim','Kullanıcılar','Kayıt olan personelin rolünü ve aktiflik durumunu belirleyin.')}<div class="filter-row"><span class="panel-meta">Yeni kayıtlar otomatik Firebase UID ile burada görünür. Rol verilene kadar beklemede kalır.</span></div><section class="panel"><table class="table"><thead><tr><th>PERSONEL</th><th>E-POSTA</th><th>ROL</th><th>DURUM</th><th></th></tr></thead><tbody>${rows.length?rows.map(([id,item])=>`<tr><td><strong>${esc(item.full_name||'-')}</strong><br><span class="panel-meta">UID: ${esc(id)}</span></td><td>${esc(item.email||'-')}</td><td>${esc(roleLabels[item.role]||item.role||'Rol bekliyor')}</td><td><span class="status-badge ${item.is_active===false?'open':''}">${item.is_active===false?'Beklemede':'Aktif'}</span></td><td><div class="table-actions"><button class="mini-button" data-action="edit-user" data-id="${esc(id)}">Rolü düzenle</button><button class="mini-button" data-action="delete-user" data-id="${esc(id)}">Sil</button></div></td></tr>`).join(''):'<tr><td colspan="5" class="empty-state">Henüz kayıt olan personel bulunmuyor.</td></tr>'}</tbody></table></section>`; }
function operationalView(type){ const isIssue=type==='issues'; const rows=recordRows(type); return `${shellHeading(isIssue?'Operasyon / Takip':'Operasyon / Misafir deneyimi',isIssue?'Sorunlar':'Misafir talepleri',isIssue?'Bakım ve arıza kayıtlarını yönetin.':'Misafir taleplerini ekibe atayın ve takip edin.',isIssue?'issue':'request')}<section class="panel"><table class="table"><thead><tr><th>${isIssue?'SORUN':'TALEP'}</th><th>ODA</th><th>ÖNCELİK</th><th>ATANAN</th><th>DURUM</th><th></th></tr></thead><tbody>${rows.length?rows.map(([id,item])=>`<tr><td><strong>${esc(item.title||item.requestType||'-')}</strong><br><span class="panel-meta">${esc(item.description||'')}</span></td><td>${esc(item.roomNumber||'-')}</td><td><span class="priority ${item.priority==='high'||item.priority==='urgent'?'high':'medium'}">${priorityText[item.priority]||item.priority||'Normal'}</span></td><td>${esc(item.assignedTo||'Atanmadı')}</td><td><span class="status-badge ${item.status==='open'?'open':item.status==='in_progress'?'progress':''}">${statusText[item.status]||item.status||'-'}</span></td><td><div class="table-actions"><button class="mini-button" data-action="edit-${isIssue?'issue':'request'}" data-id="${esc(id)}">Düzenle</button><button class="mini-button" data-action="delete-${isIssue?'issue':'request'}" data-id="${esc(id)}">Sil</button></div></td></tr>`).join(''):'<tr><td colspan="6" class="empty-state">Henüz kayıt bulunmuyor.</td></tr>'}</tbody></table></section>`; }
function reportsView(){ const roomCounts=rooms.reduce((acc,room)=>{acc[room[2]]=(acc[room[2]]||0)+1;return acc;},{}); return `${shellHeading('Yönetim','Raporlar','Operasyonun güncel durumunu tek ekranda inceleyin.')}<section class="stats-grid">${stat('TOPLAM ODA',rooms.length,'Kayıtlı oda','▦')}${stat('TEMİZ ODA',roomCounts.clean||0,'Güncel durum','✓')}${stat('AÇIK SORUN',recordRows('issues').filter(([,item])=>item.status!=='resolved'&&item.status!=='closed').length,'Çözüm bekleyen','△')}${stat('BEKLEYEN TALEP',recordRows('guest_requests').filter(([,item])=>item.status!=='completed').length,'Misafir işleri','♧')}</section><section class="panel" style="padding:22px"><h2 class="panel-title">Durum dağılımı</h2><div class="room-stats" style="margin-top:18px">${Object.entries(labels).map(([key,label])=>`<span><b>${roomCounts[key]||0}</b> ${label}</span>`).join('')}</div></section>`; }
roleViews.admin.push('settings');
function roomActivity(roomNumber){
  const issues=recordRows('issues').filter(([,item])=>String(item.roomNumber)===String(roomNumber)&&!['resolved','closed'].includes(item.status));
  const requests=recordRows('guest_requests').filter(([,item])=>String(item.roomNumber)===String(roomNumber)&&item.status!=='completed');
  return {issues,requests};
}
function allowedRoomStatuses(role, roomKey){
  if(roomKey==='broken' && role!=='admin') return [];
  return roomStatusPermissions[role] || [];
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
function roomCards(sourceRooms=rooms){ return sourceRooms.map(([number,status,key,floor]) => { const activity=roomActivity(number); const statusChoices=allowedRoomStatuses(currentRole,key).filter(nextKey=>nextKey!==key); const canAddRequest=currentRole!=='housekeeper'; return `<article class="room-card" data-room-interaction data-status="${esc(key)}" data-room="${esc(number)}" data-action="room-details"><div class="room-card-top"><div><h3>${esc(number)}</h3><p>${esc(floor)}</p></div><span class="room-status ${esc(key)}"><i></i>${esc(status)}</span></div><div class="room-alerts">${activity.requests.length?`<span class="room-alert request-alert">♧ ${activity.requests.length} talep</span>`:''}${activity.issues.length?`<span class="room-alert issue-alert">△ ${activity.issues.length} sorun</span>`:''}${!activity.requests.length&&!activity.issues.length?'<span class="room-clear">Açık kayıt yok</span>':''}</div><div class="room-card-actions">${canAddRequest?`<button class="mini-button room-request-action" data-action="add-room-request" data-room="${esc(number)}"><span aria-hidden="true">＋</span> Talep ekle</button>`:''}${statusChoices.length?`<div class="room-status-choices" aria-label="Yeni oda durumu">${statusChoices.map(nextKey=>`<button class="room-status-choice status-choice-${esc(nextKey)}" data-action="set-room-status" data-room="${esc(number)}" data-status-key="${esc(nextKey)}">${labels[nextKey]}</button>`).join('')}</div>`:''}</div>${currentRole==='admin'?`<div class="room-admin-actions"><button class="mini-button room-admin-action" data-action="edit-room" data-id="${esc(number)}">Düzenle</button><button class="mini-button room-admin-action" data-action="delete-room" data-id="${esc(number)}">Sil</button></div>`:''}</article>`; }).join(''); }
function dashboard(){ const counts=rooms.reduce((acc,room)=>{acc[room[2]]=(acc[room[2]]||0)+1;return acc;},{}); const openIssues=recordRows('issues').filter(([,item])=>!['resolved','closed'].includes(item.status)).length; const pendingRequests=recordRows('guest_requests').filter(([,item])=>item.status!=='completed').length; return `${shellHeading(new Date().toLocaleDateString('tr-TR',{weekday:'long',day:'numeric',month:'long',year:'numeric'}),'Günaydın, '+esc(currentName().split(' ')[0]),'Bugünün operasyon özeti ve ekip durumu burada.')}<section class="stats-grid">${stat('TOPLAM ODA',rooms.length,'Kayıtlı oda','▦')}${stat('TEMİZ ODA',counts.clean||0,'Güncel durum','✓')}${stat('AÇIK SORUN',openIssues,'Çözüm bekleyen','△')}${stat('BEKLEYEN TALEP',pendingRequests,'Misafir işleri','♧')}</section><div class="content-grid"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Oda durumu</h2><p class="panel-meta">Gerçek zamanlı Firebase verisi</p></div><button class="text-link" data-view="rooms">Tüm odaları gör →</button></div><div class="room-summary"><div class="room-head"><strong>${rooms.length} oda</strong><div class="legend"><span><i class="clean"></i>Temiz</span><span><i class="dirty"></i>Kirli</span><span><i class="progress"></i>İşlemde</span></div></div><div class="room-bars"><span class="clean" style="width:${rooms.length?(counts.clean||0)/rooms.length*100:0}%"></span><span class="dirty" style="width:${rooms.length?(counts.dirty||0)/rooms.length*100:0}%"></span><span class="progress" style="width:${rooms.length?(counts.progress||0)/rooms.length*100:0}%"></span><span class="inspect" style="width:${rooms.length?(counts.inspect||0)/rooms.length*100:0}%"></span><span class="broken" style="width:${rooms.length?(counts.broken||0)/rooms.length*100:0}%"></span></div><div class="room-stats">${Object.entries(labels).map(([key,label])=>`<span><b>${counts[key]||0}</b> ${label}</span>`).join('')}</div></div></section><aside class="panel"><div class="panel-head"><div><h2 class="panel-title">Hızlı işlemler</h2><p class="panel-meta">Sık kullanılan aksiyonlar</p></div></div><div class="quick-actions"><button class="quick-action" data-action="issue"><span>△</span>Sorun bildir</button><button class="quick-action" data-action="request"><span>♧</span>Talep oluştur</button><button class="quick-action" data-view="rooms"><span>▦</span>Odaları görüntüle</button><button class="quick-action" data-action="sync"><span>↻</span>Verileri eşitle</button></div></aside></div>`; }
function roomDetails(number){
  const room=rooms.find(item=>String(item[0])===String(number)); const activity=roomActivity(number); const allRequests=recordRows('guest_requests').filter(([,item])=>String(item.roomNumber)===String(number)); const allIssues=recordRows('issues').filter(([,item])=>String(item.roomNumber)===String(number));
  const list=(items,empty,type)=>items.length?`<ul class="room-detail-list">${items.map(([id,item])=>`<li><div class="room-detail-item-head"><strong>${esc(item.title||item.requestType||'Kayıt')}</strong>${type==='request'?`<button class="complete-request-button ${item.status==='completed'?'is-complete':''}" data-action="complete-request" data-id="${esc(id)}" data-room="${esc(number)}" aria-label="Talebi tamamla" ${item.status==='completed'?'disabled':''}>✓</button>`:issueManageRoles.includes(currentRole)?`<span class="detail-actions"><button class="complete-request-button ${['resolved','closed'].includes(item.status)?'is-complete':''}" data-action="complete-issue" data-id="${esc(id)}" data-room="${esc(number)}" aria-label="Sorunu tamamla" ${['resolved','closed'].includes(item.status)?'disabled':''}>✓</button><button class="detail-delete-button" data-action="delete-issue" data-id="${esc(id)}" data-room="${esc(number)}" aria-label="Sorunu sil">×</button></span>`:''}</div><span>${esc(item.description||'Açıklama eklenmemiş')}</span><small>${statusText[item.status]||item.status||'Açık'} · ${priorityText[item.priority]||item.priority||'Normal'}${item.completedAt?` · Tamamlandı: ${esc(formatDateTime(item.completedAt))}`:''}</small></li>`).join('')}</ul>`:`<p class="room-detail-empty">${empty}</p>`;
  modal(`${esc(number)} numaralı oda`, `<div class="room-detail-summary"><span class="room-status ${esc(room?.[2]||'')}">${esc(room?.[1]||'')}</span><span>${esc(room?.[3]||'')}</span><button class="room-issue-button" data-action="report-room-issue" data-room="${esc(number)}">△ Sorun bildir</button></div><section class="room-detail-section"><h3>Misafir talepleri <b>${allRequests.length}</b></h3>${list(allRequests,'Misafir talebi yok.','request')}</section><section class="room-detail-section"><h3>Sorunlar <b>${allIssues.length}</b></h3>${list(allIssues,'Sorun kaydı yok.','issue')}</section>`);
}
function roomsView(){ const visibleRooms=rooms.filter(([number,,key,floor])=>(roomFloorFilter==='all'||floor===roomFloorFilter)&&(roomStatusFilter==='all'||key===roomStatusFilter)); const floors=[...new Set(rooms.map(([, , ,floor])=>floor))]; const filterBody=`<div class="room-filter-modal"><div class="filter-modal-group"><strong>Kat</strong><div class="filter-modal-options"><button class="filter ${roomFloorFilter==='all'?'active':''}" data-room-floor="all">Tüm katlar</button>${floors.map(floor=>`<button class="filter ${roomFloorFilter===floor?'active':''}" data-room-floor="${esc(floor)}">${esc(floor)}</button>`).join('')}</div></div><div class="filter-modal-group"><strong>Durum</strong><div class="filter-modal-options"><button class="filter ${roomStatusFilter==='all'?'active':''}" data-room-status="all">Tüm durumlar</button>${Object.entries(labels).map(([key,label])=>`<button class="filter ${roomStatusFilter===key?'active':''}" data-room-status="${key}">${label}</button>`).join('')}</div></div></div>`; return `${shellHeading('Operasyon / Odalar','Odalar','Oda durumlarını ve oda işlerini tek ekrandan takip edin.',currentRole==='admin'?'room':'')}<div class="room-toolbar"><span class="panel-meta">${visibleRooms.length} oda gösteriliyor</span><div class="room-toolbar-actions"><button class="filter-open-button" data-action="open-room-filters">☷ Filtrele</button>${currentRole==='admin'?'<button class="filter-open-button" data-action="bulk-rooms">＋ Toplu oda ekle</button>':''}</div></div><section class="panel room-panel"><div class="rooms-grid">${visibleRooms.length?roomCards(visibleRooms):'<p class="empty-state">Bu filtrelerde oda bulunmuyor.</p>'}</div></section><div class="room-filter-template" hidden>${filterBody}</div>`; }
function render(view=currentView){
  if (!canAccess(view)) view='dashboard';
  currentView=view;
  const views={dashboard,rooms:roomsView,issues:()=>operationalView('issues'),requests:()=>operationalView('guest_requests'),reports:reportsView,users:usersManagementView,settings:settingsView};
  app.innerHTML=(views[view]||dashboard)();
  const activeTitle={dashboard:'Genel Bakış',rooms:'Odalar',issues:'Sorunlar',requests:'Misafir Talepleri',reports:'Raporlar',users:'Kullanıcılar',settings:'Otel Ayarları'}[view];
  title.textContent=activeTitle;
  document.querySelectorAll('.nav-item[data-view]').forEach(item=>{item.classList.toggle('active',item.dataset.view===view);item.hidden=currentRole!=='admin'?(item.dataset.view!=='rooms'||!item.dataset.roles.split(',').includes(currentRole)):!item.dataset.roles.split(',').includes(currentRole);});
  updateNavCounts();
  applyHotelName();
}
function showApp(){
  document.body.classList.remove('logged-out'); document.querySelector('#authScreen').classList.remove('visible');
  const name=currentName(); document.querySelector('#userName').textContent=name; document.querySelector('#userRole').textContent=roleLabels[currentRole]||currentRole; document.querySelector('#userAvatar').textContent=name.slice(0,2).toUpperCase(); document.querySelector('#topAvatar').textContent=name.slice(0,2).toUpperCase();
  attachDataListeners(); render(currentRole==='admin'?'dashboard':'rooms'); loadRoomsFromFirebase();
}
document.addEventListener('click',(event)=>{
  const close=event.target.closest('[data-close-modal]'); if(close){closeModal();return;}
  const floorButton=event.target.closest('[data-room-floor]'); if(floorButton){roomFloorFilter=floorButton.dataset.roomFloor;closeModal();render('rooms');return;}
  const statusButton=event.target.closest('[data-room-status]'); if(statusButton){roomStatusFilter=statusButton.dataset.roomStatus;closeModal();render('rooms');return;}
  const action=event.target.closest('[data-action]')?.dataset.action; if(!action)return;
  if(action==='open-room-filters'){const template=document.querySelector('.room-filter-template');if(template)modal('Oda filtreleri',template.innerHTML);return;}
  if(action==='bulk-rooms'){if(currentRole!=='admin'){showToast('Toplu oda ekleme yalnızca admin içindir.');return;} modal('Toplu oda ekle',bulkRoomForm());return;}
  if(action==='room-details'){roomDetails(event.target.closest('[data-room]')?.dataset.room);return;}
  if(action==='add-room-request'){
    const roomNumber=event.target.closest('[data-room]')?.dataset.room;
    if(currentRole==='housekeeper'){showToast('Housekeeping kullanıcıları talep ekleyemez.');return;}
    if(roomNumber)modal(`${roomNumber} numaralı oda için talep`,recordForm('guest_requests','',roomNumber));
    return;
  }
  if(action==='complete-request'){
    const button=event.target.closest('[data-action="complete-request"]'); const id=button?.dataset.id; const roomNumber=button?.dataset.room;
    if(!id||!firebaseDatabase)return;
    firebaseDatabase.ref(`guest_requests/${id}`).update({status:'completed',completedAt:firebase.database.ServerValue.TIMESTAMP,completedBy:currentUser?.uid||null,updatedAt:firebase.database.ServerValue.TIMESTAMP}).then(()=>{closeModal();roomDetails(roomNumber);showToast('Misafir talebi tamamlandı. Oda kirliye alındığında kayıttan kaldırılır.');}).catch(()=>showToast('Talep tamamlanamadı.'));
    return;
  }
  if(action==='complete-issue'){
    const button=event.target.closest('[data-action="complete-issue"]'); const id=button?.dataset.id; const roomNumber=button?.dataset.room;
    if(!issueManageRoles.includes(currentRole)){showToast('Sorun güncelleme yetkiniz yok.');return;}
    if(!id||!firebaseDatabase)return;
    firebaseDatabase.ref(`issues/${id}`).update({status:'resolved',completedAt:firebase.database.ServerValue.TIMESTAMP,completedBy:currentUser?.uid||null,updatedAt:firebase.database.ServerValue.TIMESTAMP}).then(()=>{closeModal();roomDetails(roomNumber);showToast('Sorun tamamlandı olarak işaretlendi.');}).catch(()=>showToast('Sorun güncellenemedi.'));
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
    const previousStatus=room[2]; room[2]=nextStatus; room[1]=labels[nextStatus]; render('rooms'); saveRoomToFirebase(room,previousStatus); showToast(`${room[0]} numaralı oda: ${room[1]}`); return;
  }
  if(action==='room' && currentRole==='admin') modal('Yeni oda ekle',recordForm('rooms'));
  if(action==='issue' && ['admin','supervisor','housekeeper','maintenance','front_desk'].includes(currentRole)) modal('Sorun bildir',recordForm('issues'));
  if(action==='request' && ['admin','supervisor','housekeeper','front_desk'].includes(currentRole)) modal('Yeni misafir talebi',recordForm('guest_requests'));
  if(action==='user' && adminOnly()) modal('Kullanıcı profili ekle',recordForm('users'));
  if(action==='edit-user' && adminOnly()) modal('Kullanıcı profilini düzenle',recordForm('users',event.target.closest('[data-action]').dataset.id));
  if(action==='edit-issue') modal('Sorunu düzenle',recordForm('issues',event.target.closest('[data-action]').dataset.id));
  if(action==='edit-request') modal('Talebi düzenle',recordForm('guest_requests',event.target.closest('[data-action]').dataset.id));
  if(action?.startsWith('delete-')){ const type=action.replace('delete-',''); const path=type==='user'?'users':type==='issue'?'issues':'guest_requests'; const id=event.target.closest('[data-action]').dataset.id; if((path==='users'&&!adminOnly())||!confirm('Bu kayıt silinsin mi?'))return; removeRecord(path,id).then(()=>showToast('Kayıt silindi.')).catch(()=>showToast('Silme işlemi başarısız.')); }
});
document.addEventListener('submit',(event)=>{
  const form=event.target.closest('.management-form'); if(!form)return; event.preventDefault(); const data=Object.fromEntries(new FormData(form));
  if(form.dataset.form==='settings'){ if(!adminOnly())return; const settings={...data}; if(settings.autoOutOfOrder)settings.autoOutOfOrder=settings.autoOutOfOrder==='true'; firebaseDatabase.ref('settings').update(settings).then(()=>showToast('Ayarlar güncellendi.')).catch(()=>showToast('Ayarlar kaydedilemedi.')); return; }
  if(form.dataset.form==='room-status'){
    const room=rooms.find(item=>item[0]===form.dataset.room); const allowed=room&&allowedRoomStatuses(currentRole,room[2]);
    if(!room||!allowed.includes(data.statusKey)){showToast('Bu oda durumuna geçiş yetkiniz yok.');return;}
    const previousStatus=room[2]; room[2]=data.statusKey; room[1]=labels[data.statusKey];
    saveRoomToFirebase(room,previousStatus); closeModal(); render('rooms'); showToast(`${room[0]} numaralı oda: ${room[1]}`); return;
  }
  if(form.dataset.form==='bulk-rooms'){
    if(currentRole!=='admin'){showToast('Toplu oda ekleme yalnızca admin içindir.');return;}
    const parsed=data.roomsText.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>line.split(',').map(value=>value.trim()));
    const invalid=parsed.find(parts=>!parts[0]||!parts[1]||!labels[parts[2]]);
    const ids=parsed.map(parts=>parts[0]);
    if(invalid||new Set(ids).size!==ids.length){showToast('Her satır oda no, kat ve geçerli durum içermeli; oda numaraları tekrarlanmamalı.');return;}
    const existing=new Set(rooms.map(room=>String(room[0]))); const duplicate=ids.find(id=>existing.has(String(id)));
    if(duplicate){showToast(`${duplicate} numaralı oda zaten kayıtlı.`);return;}
    Promise.all(parsed.map(([number,floor,statusKey,roomType='Standart'])=>writeRecord('rooms',number,{roomNumber:number,status:labels[statusKey],statusKey,floor,roomType}))).then(()=>{closeModal();showToast(`${parsed.length} oda Firebase'e kaydedildi.`);}).catch(()=>showToast('Toplu oda kaydı sırasında hata oluştu.'));
    return;
  }
  if(form.dataset.form==='room'){ if(currentRole!=='admin'){showToast('Oda ekleme yalnızca admin içindir.');return;} const id=data.roomNumber; const key=data.statusKey; const room=[id,labels[key],key,data.floor,data.roomType||'Standart']; const old=rooms.find(item=>item[0]===id); writeRecord('rooms',id,{roomNumber:id,status:room[1],statusKey:key,floor:data.floor,roomType:data.roomType}).then(()=>{if(old){old[1]=room[1];old[2]=room[2];old[3]=room[3];old[4]=room[4];}else rooms.push(room);return key==='dirty'?removeCompletedRequestsForRoom(id):null;}).then(()=>{closeModal();render('rooms');showToast('Oda Firebase\'e kaydedildi.');}).catch(()=>showToast('Oda kaydedilemedi.')); return; }
  const type=form.dataset.form==='user'?'users':form.dataset.form==='issue'?'issues':'guest_requests'; const id=form.dataset.id||data.uid||dbKey(); const payload={...data}; if(type==='users')payload.is_active=data.is_active==='true'; if(type==='guest_requests'){payload.requestType=payload.title;delete payload.title;} writeRecord(type,id,payload).then(()=>{closeModal();render(currentView);showToast('Kayıt kaydedildi.');}).catch(()=>showToast('Kayıt kaydedilemedi.'));
});
document.addEventListener('click',(event)=>{
  const actionButton=event.target.closest('.room-admin-action'); if(!actionButton)return;
  event.stopPropagation(); event.preventDefault(); const id=actionButton.dataset.id; const room=rooms.find(item=>item[0]===id);
  if(actionButton.dataset.action==='delete-room'){ if(confirm(`${id} numaralı oda silinsin mi?`)){firebaseDatabase.ref(`rooms/${id}`).remove().then(()=>{const index=rooms.findIndex(item=>item[0]===id);if(index>=0)rooms.splice(index,1);render('rooms');showToast('Oda silindi.');});} return; }
  modal('Odayı düzenle',`<form class="management-form" data-form="room" data-id="${esc(id)}"><div class="form-grid"><div class="form-field"><label>Oda numarası</label><input name="roomNumber" value="${esc(room?.[0])}" readonly></div><div class="form-field"><label>Kat</label><input name="floor" value="${esc(room?.[3])}" required></div><div class="form-field"><label>Durum</label><select name="statusKey">${Object.entries(labels).map(([key,label])=>`<option value="${key}" ${room?.[2]===key?'selected':''}>${label}</option>`).join('')}</select></div><div class="form-field"><label>Oda tipi</label><input name="roomType" value="Standart"></div></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>İptal</button><button class="primary-button">Kaydet</button></div></form>`);
}, true);
