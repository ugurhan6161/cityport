# Checkout push backend

`POST /api/send-push` endpoint'i harici bir scheduler tarafından çağrılır. Vercel Cron kullanılmaz. Scheduler'ın her gün Istanbul saatine göre çalıştırılması önerilir; endpoint kendi tarih kontrolünü de `Europe/Istanbul` ile yapar.

## Supabase housekeeping verileri

Oda, personel profili, sorun, misafir talebi, cafe ürünü, otel ayarı, rezervasyon, push aboneliği ve bildirim geçmişi müşteri uygulamasının kullandığı Supabase projesinde tutulur. Firebase Authentication personel girişinde, Firebase Cloud Messaging (FCM) ise bildirim teslimatında kullanılır. Firebase Realtime Database kullanılmaz.

Vercel'de `SUPABASE_URL` ve yalnızca sunucuda saklanacak `SUPABASE_SERVICE_ROLE_KEY` değişkenlerini tanımlayın. İkisi de müşteri uygulamasının kullandığı aynı Supabase projesine ait olmalıdır. Supabase Dashboard → SQL Editor'da önce müşteri uygulamasının ana `supabase/schema.sql` dosyasını, ardından bu proje içindeki `supabase-housekeeping.sql` dosyasını çalıştırın. Ana şema `hotel_rooms` ve `hotel_records` tablolarını; ek şema housekeeping profilleri, ayarları, rezervasyonları ve push gönderim kayıtları için `housekeeping_records` tablosunu hazırlar. Browser'a service role key eklemeyin.

Eski Firebase Realtime Database dışa aktarımınızdan `users`, `settings`, `reservations` ve `manual_notification_logs` alanlarını alıp aşağıdaki RPC'yi çalıştırarak bu kayıtları içe aktarın. Aynı kimliğe sahip kayıtlar güncellenir. Oda, sorun, misafir talebi, cafe ürünü ve push abonelikleri müşteri uygulamasının `hotel_rooms`/`hotel_records` tablolarını kullanır; henüz taşınmadıysa müşteri uygulamasının Firebase içe aktarma adımlarını önce tamamlayın. Eski Firebase push token'larını `hotel_records` tablosunun `push_subscriptions` koleksiyonuna taşıyın.

```sql
select public.import_legacy_housekeeping_export($firebase_export$
{
  "users": {},
  "settings": {},
  "reservations": {},
  "manual_notification_logs": {}
}
$firebase_export$::jsonb);
```

## Environment variables

- `SUPABASE_URL`: müşteri uygulamasının kullandığı Supabase proje URL'si.
- `SUPABASE_SERVICE_ROLE_KEY`: housekeeping API'sinin sunucu tarafı Supabase erişimi; gizli tutulmalı.

- `PUSH_API_SECRET`: Endpoint Bearer secret. Sadece backend ortamında tutulur.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase Admin service-account JSON'u. Frontend'e eklenmez.
- `FIREBASE_SERVICE_ACCOUNT_BASE64`: Alternatif olarak service-account JSON'unun Base64 kodlanmış hali. JSON değişkeninde satır sonu sorunu yaşanırsa bunu kullanın.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`: JSON yapıştırmak sorun çıkarırsa servis hesabını üç ayrı değişken olarak tanımlamak için alternatif yöntem.

`FIREBASE_SERVICE_ACCOUNT_JSON` içindeki `private_key` alanında gerçek satır sonları yerine `\\n` bulunması desteklenir. Değişkenleri Vercel'de **Production** ortamına ekledikten sonra yeni deployment yapılmalıdır.

Kurulum:

1. Firebase Console > Project settings > Service accounts > **Generate new private key** ile JSON dosyasını indirin.
2. Vercel Project > Settings > Environment Variables bölümünde `FIREBASE_SERVICE_ACCOUNT_JSON` adında yeni değişken oluşturun.
3. JSON dosyasının tamamını tek değer olarak yapıştırın ve en az **Production** ortamını seçin.
4. Vercel'de **Redeploy** yapın. Ortam değişkenleri yeni deployment'tan önce çalışan fonksiyona uygulanmaz.

Değer `FIREBASE_SERVICE_ACCOUNT_JSON` alanına yapıştırılırken dosyanın tamamı `{` ile başlayıp `}` ile bitmelidir. Dosyayı açıp sadece `private_key` değerini veya dosya yolunu yapıştırmayın. En sorunsuz yöntem, JSON dosyasını bir metin editöründe açıp tamamını kopyalamaktır.

Servis hesabı JSON'unu GitHub'a, frontend dosyalarına veya tarayıcı konsoluna koymayın. JSON yapıştırılamıyorsa şu üç Production değişkenini kullanabilirsiniz: `FIREBASE_PROJECT_ID` değerine `project_id`, `FIREBASE_CLIENT_EMAIL` değerine `client_email`, `FIREBASE_PRIVATE_KEY` değerine `private_key` alanının tamamını yapıştırın. `private_key` içindeki `\\n` karakterlerini silmeyin.

## Firebase notification data contract

Checkout rezervasyonları Supabase `housekeeping_records` tablosundaki `reservations` koleksiyonundan okunur. Her kayıt `room` veya `roomNumber`, `checkoutDate` (`YYYY-MM-DD`) ve isteğe bağlı `status`/`active` alanları içerebilir. `cancelled`, `completed`, `checked_out` ve `closed` kayıtları aktif sayılmaz.

FCM token'ları Supabase `hotel_records` tablosunda `collection = 'push_subscriptions'` olarak tutulur. Her kayıt `token`, `roomNumber`, `guestName` ve isteğe bağlı `active` alanlarını içerir. Housekeeping uygulaması yalnızca ilgili odanın aktif token'larına bildirim yollar; geçersiz ya da süresi dolmuş token Supabase kaydında `active: false` yapılır.

Gönderim data-only FCM mesajı olarak yapılır; misafir uygulamasının service worker'ı bildirimi tek kez gösterir. Başlık `Cityport Hotel` olarak sabitlenmiştir.

Otomatik gönderim kaydı Supabase `housekeeping_records` tablosunda `collection = 'push_send_logs'` olarak tutulur. Oda ve tarih için benzersiz kayıt aynı gün ikinci gönderimi engeller. Manuel gönderim geçmişi `manual_notification_logs` koleksiyonundadır.

## Request

```json
{
  "room": "502",
  "title": "Cityport Hotel",
  "body": "TR: Bugün çıkış gününüz. Lütfen odanızı saat 12:00'ye kadar boşaltmanız ricadır.\n\nEN: Today is your checkout day. Please vacate your room by 12:00.",
  "url": "/"
}
```

`room` gönderilmezse endpoint bugün checkout olan tüm aktif odaları tarar. Scheduler genellikle body göndermeden endpoint'i çağırabilir; varsayılan iki dilli mesaj üretilir. Backend Firebase Admin SDK ile FCM'e gönderir; `VAPID_PRIVATE_KEY` ve `VAPID_SUBJECT` kullanılmaz.

Admin kullanıcıları aynı endpoint'i Firebase ID token ile çağırarak manuel bildirim gönderebilir. Bu çağrı `PUSH_API_SECRET` kullanmaz; backend token içindeki kullanıcıyı doğrular ve rolünü Supabase `housekeeping_records` tablosundaki `users/{uid}` profilinden kontrol eder:

```json
{
  "manual": true,
  "room": "502",
  "title": "Cityport Hotel",
  "body": "Odanızla ilgili önemli bir duyuru var.",
  "url": "/"
}
```