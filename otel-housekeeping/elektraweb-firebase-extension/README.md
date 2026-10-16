# ElektraWEB Supabase Oda Durumu Eklentisi

Bu Chrome MV3 eklentisi, ElektraWEB Room Rack ekranındaki oda kartlarını izler ve oda durumlarını housekeeping uygulamasının Supabase API'sine aktarır. Ayrıca Supabase'deki oda durumlarını ElektraWEB Room Rack'e uygular. Personel girişinde Firebase Authentication kullanılır; oda ve durum günlüğü verileri Supabase'te tutulur.

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
7. Housekeeping uygulamasının HTTPS adresini **Housekeeping API adresi** alanına girip kaydedin. Eklenti sadece bu host için erişim izni ister.
8. Otomatik senkronizasyon açıkken Room Rack içindeki durum değişiklikleri Supabase'e yazılır.

## Supabase ve Firebase Authentication

Housekeeping uygulamasındaki `SUPABASE_URL` ve `SUPABASE_SERVICE_ROLE_KEY` değişkenleri, Firebase kullanıcı profilleri ve `supabase-housekeeping.sql` şeması Vercel'de hazır olmalıdır. Eklenti Firebase ID token'ını housekeeping API'sine gönderir; API personelin Supabase profilini ve oda durumu yetkisini doğrular. Mevcut `admin`, `supervisor`, `housekeeper` ve `front_desk` oda durumu izinleri korunur.

## Notlar

- Eklenti oda güncellemelerini ve `room_status_logs` kayıtlarını Supabase'e yazar.
- Firebase Auth token'ı Chrome extension storage'da tutulur ve süresi dolduğunda otomatik yenilenir.
- Eklenti ElektraWEB'den oda doluluk durumu ve misafir adını okur; bu alanlar housekeeping uygulamasının mevcut oda veri akışıyla aynı şekilde Supabase oda kaydına gönderilir.
- Geniş `<all_urls>` content script izni, Chrome'un dinamik host izinlerini kullanmadan farklı ElektraWEB kurulumlarında çalışabilmek için kullanılmıştır; DOM eşleşmesi yoksa hiçbir işlem yapılmaz.
