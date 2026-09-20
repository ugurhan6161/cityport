(() => {
  const ROOM_SELECTOR = '.rr-room';
  // DÜZELTME: Angular Material sürümüne göre class ismi değişebiliyor,
  // üçüncü bir yedek seçici eklendi (mat-mdc-select-value-text).
  const STATUS_SELECTOR =
    '.roomrackstate .mat-select-min-line, ' +
    '.roomrackstate .mat-mdc-select-min-line, ' +
    '.roomrackstate .mat-mdc-select-value-text';

  const seen = new Map();
  let enabled = true;
  let observer;
  let scanTimer = null;

  chrome.storage.local.get('enabled').then(state => {
    enabled = state.enabled !== false;
    if (enabled) start();
  });

  chrome.storage.onChanged.addListener(changes => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      if (enabled) start();
      else observer?.disconnect();
    }
  });

  function start() {
    scan();
    observer?.disconnect();
    observer = new MutationObserver(() => {
      // Angular DOM'u çok sık değiştiriyor; her mutasyonda değil,
      // 300ms sessizlikten sonra tara (performans + gereksiz mesaj önler).
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // DÜZELTME: Eklenti chrome://extensions üzerinden yeniden yüklendiğinde/
  // güncellendiğinde, hâlâ açık olan sekmelerdeki eski content script'in
  // extension bağlantısı geçersiz olur ("orphaned"). Bu durumda chrome.*
  // API çağrıları "Extension context invalidated" hatası fırlatır.
  // Bunu önceden tespit edip taramayı durduruyoruz; kullanıcı sayfayı
  // yenilediğinde script yeniden enjekte edilip normal çalışacaktır.
  function isContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (e) {
      return false;
    }
  }

  function scan() {
    if (!enabled) return;

    if (!isContextValid()) {
      console.warn('[Oda senkronizasyonu] Eklenti yeniden yüklendi, sayfayı yenileyin. Tarama durduruldu.');
      observer?.disconnect();
      clearTimeout(scanTimer);
      return;
    }

    if (!isElektraRoomRack()) {
      report({ matched: 0, skipped: 0, cards: 0, statusNodes: 0, roomRack: false });
      return;
    }

    const cards = document.querySelectorAll(ROOM_SELECTOR);
    const statusNodes = document.querySelectorAll(STATUS_SELECTOR);
    let matched = 0;
    let skipped = 0;

    cards.forEach(roomCard => {
      const roomNumber = roomCard.querySelector('.rno')?.textContent?.trim();
      const status = roomCard.querySelector(STATUS_SELECTOR)?.textContent?.trim();
      if (!roomNumber || !status) { skipped += 1; return; }

      // Oda dolu mu boş mu: dolu odalarda misafir bilgisi (.inHouseResGuest)
      // ve konteynerde "inhouseguest" class'ı bulunuyor.
      const occupied = isRoomOccupied(roomCard);
      const guestName = getGuestName(roomCard);

      matched += 1;
      const key = `${roomNumber}:${status}:${occupied}:${guestName || ''}`;
      if (seen.get(roomNumber) === key) return;
      seen.set(roomNumber, key);

      try {
        chrome.runtime.sendMessage({ type: 'sync-room-status', roomNumber, status, occupied, guestName }, response => {
          if (chrome.runtime.lastError) {
            console.warn('[Oda senkronizasyonu] mesaj hatası:', chrome.runtime.lastError.message);
          } else if (!response?.ok) {
            console.warn('[Oda senkronizasyonu] senkronizasyon hatası:', response?.error || 'Bilinmeyen hata');
          }
        });
      } catch (e) {
        // Extension context invalidated - sayfa yenilenene kadar sessizce durdur
        console.warn('[Oda senkronizasyonu] Eklenti bağlantısı geçersiz, sayfayı yenileyin.');
        observer?.disconnect();
      }
    });

    report({
      matched,
      skipped,
      cards: cards.length,
      statusNodes: statusNodes.length,
      roomRack: true
    });
  }

  // DÜZELTME: background.js sadece 'scan-report' tipini dinliyor.
  // Eskiden burada 'content-report' gönderiliyordu ve hiçbir zaman
  // işlenmiyordu; bu yüzden popup'taki tarama/hata bilgisi hiç güncellenmiyordu.
  function report(details) {
    try {
      chrome.runtime.sendMessage({ type: 'scan-report', ...details }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // Extension context invalidated - sessizce yut, konsolu kirletme
    }
  }

  function isElektraRoomRack() {
    return Boolean(document.querySelector('.room-rack-container, app-room-rack, .rr-room'));
  }

  // Dolu oda göstergesi: guest-info konteynerinde "inhouseguest" class'ı
  // veya içinde misafir adı elementi (.inHouseResGuest) varsa oda doludur.
  function isRoomOccupied(roomCard) {
    return Boolean(roomCard.querySelector('.rr-room-guest-info.inhouseguest, .inHouseResGuest'));
  }

  function getGuestName(roomCard) {
    return roomCard.querySelector('.inHouseResGuest')?.textContent?.replace(/\s+/g, ' ').trim() || null;
  }
})();
