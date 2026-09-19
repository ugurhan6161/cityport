# Checkout push backend

`POST /api/send-push` endpoint'i harici bir scheduler tarafından çağrılır. Vercel Cron kullanılmaz. Scheduler'ın her gün Istanbul saatine göre çalıştırılması önerilir; endpoint kendi tarih kontrolünü de `Europe/Istanbul` ile yapar.

## Environment variables

- `PUSH_API_SECRET`: Endpoint Bearer secret. Sadece backend ortamında tutulur.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Firebase Admin service-account JSON'u. Frontend'e eklenmez.
- `FIREBASE_SERVICE_ACCOUNT_BASE64`: Alternatif olarak service-account JSON'unun Base64 kodlanmış hali. JSON değişkeninde satır sonu sorunu yaşanırsa bunu kullanın.
- `FIREBASE_DATABASE_URL`: İsteğe bağlı; varsayılan proje database URL'sidir.

`FIREBASE_SERVICE_ACCOUNT_JSON` içindeki `private_key` alanında gerçek satır sonları yerine `\\n` bulunması desteklenir. Değişkenleri Vercel'de **Production** ortamına ekledikten sonra yeni deployment yapılmalıdır.

## Firebase data contract

Rezervasyonlar `reservations` altında tutulur. Her kayıt `room` veya `roomNumber`, `checkoutDate` (`YYYY-MM-DD`) ve isteğe bağlı `status`/`active` alanları içerebilir. `cancelled`, `completed`, `checked_out` ve `closed` kayıtları aktif sayılmaz.

Firebase Cloud Messaging registration token'ları oda bazında `fcmTokens/{room}/{id}`, `fcm_tokens/{room}/{id}` veya `pushTokens/{room}/{id}` altında `{ "token": "...", "active": true }` olarak tutulur. String token değeri de desteklenir. Geçersiz ya da süresi dolmuş FCM token'ları `active: false` yapılır.

Gönderim kaydı `push_send_logs/{checkoutDate}/{room}` altında tutulur. Aynı tarih ve oda kaydı varsa ikinci gönderim yapılmaz. Kayıtta `room`, `checkoutDate`, `sentAt` ve `result` alanları bulunur.

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

Admin kullanıcıları aynı endpoint'i Firebase ID token ile çağırarak manuel bildirim gönderebilir. Bu çağrı `PUSH_API_SECRET` kullanmaz; backend token içindeki kullanıcıyı ve Firebase `users/{uid}.role == admin` kaydını doğrular:

```json
{
  "manual": true,
  "room": "502",
  "title": "Cityport Hotel",
  "body": "Odanızla ilgili önemli bir duyuru var.",
  "url": "/"
}
```