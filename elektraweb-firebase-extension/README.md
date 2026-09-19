# ElektraWEB Firebase Oda Durumu Eklentisi

Bu Chrome MV3 eklentisi, ElektraWEB Room Rack ekranındaki oda kartlarını izler ve oda durumlarını mevcut Firebase Realtime Database projesindeki `rooms/{odaNo}` kaydına aktarır.

## Desteklenen eşleşmeler

- `Temiz` -> `clean`
- `Kirli` -> `dirty`
- `Temizleniyor` -> `progress`
- `Kontrol edildi` -> `inspect`
- `Arızalı` / `Kullanım dışı` -> `broken`

Ekteki ERP DOM yapısına göre kullanılan seçiciler:

- Oda kartı: `.rr-room`
- Oda numarası: `.rr-room .rno`
- Oda durumu: `.rr-room .roomrackstate .mat-select-min-line`

## Chrome'a yükleme

1. Chrome'da `chrome://extensions` adresini açın.
2. Sağ üstten **Geliştirici modu**nu etkinleştirin.
3. **Paketlenmemiş öğe yükle** seçeneğine tıklayın.
4. Bu klasörü seçin: `elektraweb-firebase-extension`
5. ElektraWEB Room Rack sayfasını yenileyin.
6. Chrome araç çubuğundaki eklenti ikonunu açıp Firebase personel hesabıyla giriş yapın.
7. Otomatik senkronizasyon açıkken Room Rack içindeki durum değişiklikleri Firebase'e yazılır.

## Firebase gereksinimi

Eklenti, `firebase-config.js` içindeki aynı Firebase projesini kullanır. Firebase Rules içinde giriş yapan hesabın rolüne `/rooms/$roomId` yazma izni verilmiş olmalıdır. Mevcut projedeki `admin`, `supervisor`, `housekeeper` ve `front_desk` rolleriyle uyumludur.

## Notlar

- Eklenti Firebase'e `updatedBy`, `source` ve `room_status_logs` bilgilerini de yazar.
- Firebase Auth token'ı Chrome extension storage'da tutulur. Token süresi dolduğunda popup'tan yeniden giriş yapılmalıdır.
- Eklenti yalnızca oda numarası ve durum metnini okur; misafir adı veya kişisel veriyi Firebase'e göndermez.
- Geniş `<all_urls>` content script izni, Chrome'un dinamik host izinlerini kullanmadan farklı ElektraWEB kurulumlarında çalışabilmek için kullanılmıştır; DOM eşleşmesi yoksa hiçbir işlem yapılmaz.
