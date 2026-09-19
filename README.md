# Kuzeybatı Haber — Mail Servisi

SMTP ile mail gönderen bağımsız Docker servisi.

## Nasıl çalışır

```
Site / panel  ──►  Supabase mail_queue  ──►  bu servis  ──►  SMTP
                          ▲                      │
                          └──── sonucu yazar ────┘
```

Servis kuyruğu **kendisi çeker** (15 saniyede bir). İsteğe bağlı
olarak HTTP ucu da açılabilir; o da maili aynı kuyruğa atar.

## Dokploy kurulumu

1. **Application Type:** Compose
2. **Compose Type:** `docker-compose`
3. **Compose File:** `./docker-compose.yml` (varsayılan, dosya kökte)
4. **Environment** sekmesine aşağıdaki değerleri gir
5. Alan adı bağlamak istersen: **Domains** → port `8080`

> `.env` dosyası depoya konmaz. Dokploy'un Environment sekmesi
> değerleri konteynere geçirir.

## Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
|---|---|---|
| `SUPABASE_URL` | ✔ | Supabase proje adresi |
| `SUPABASE_SERVICE_KEY` | ✔ | **service_role** anahtarı — yalnızca burada bulunur |
| `SMTP_HOST` | ✔ | |
| `SMTP_PORT` | | 587 (varsayılan) veya 465 |
| `SMTP_USER` | ✔ | |
| `SMTP_PASS` | ✔ | |
| `SMTP_SECURE` | | 465 kullanıyorsan `true` |
| `SITE_URL` | | Maillerdeki bağlantılar bu adresle kurulur |
| `MAIL_API_KEY` | | **Boşsa HTTP ucu hiç açılmaz** |
| `API_RATE_MAX` | | IP başına dakikada istek (varsayılan 60) |
| `API_ALLOW_IPS` | | Virgülle ayrılmış IP listesi |
| `POLL_MS` | | Kuyruk kontrol aralığı (varsayılan 15000) |

Anahtar üretmek:

```bash
openssl rand -hex 32
```

## HTTP API

`MAIL_API_KEY` tanımlıysa açılır. Tanımlı değilse uç **yoktur**
ve servis yalnızca kuyruktan çalışır — en güvenli kurulum budur.

### `POST /api/send`

```bash
curl -X POST https://mail.kuzeybati.cloud/api/send \
  -H "X-Api-Key: ANAHTARIN" \
  -H "Content-Type: application/json" \
  -d '{
    "template": "welcome",
    "to": "okur@ornek.com",
    "to_name": "Ahmet",
    "payload": { "name": "Ahmet" },
    "locale": "tr"
  }'
```

```json
{ "status": "queued", "id": "..." }
```

Mail panelden kapalıysa:

```json
{ "status": "skipped", "reason": "mail_disabled_or_duplicate" }
```

| Kod | Anlamı |
|---|---|
| `202` | Kuyruğa alındı |
| `400` | Bilinmeyen şablon ya da geçersiz e-posta |
| `401` | Anahtar yok veya yanlış |
| `403` | IP listede değil |
| `405` | POST dışı yöntem |
| `413` | Gövde 16 KB'den büyük |
| `429` | Hız sınırı |

**Bu uç maili KUYRUĞA ATAR, doğrudan göndermez.** Böylece yeniden
deneme, günlük tavan ve panelden kapatma HTTP'den gelen maillerde
de geçerli olur.

### `GET /health`

Kimlik gerektirmez, bilgi sızdırmaz. Docker ve Dokploy sağlık
kontrolü bunu kullanır.

### `GET /status`

Ayrıntılı durum. `X-Api-Key` gerektirir; anahtar yanlışsa **404**
döner — ucun varlığı bile sızdırılmaz.

## Şablonlar

| Ad | Ne zaman |
|---|---|
| `verify_email` | E-posta doğrulama (isteğe bağlı) |
| `welcome` | Kayıt sonrası |
| `newsletter_confirm` | Bülten çift onayı |
| `article_status` | Editöre haber onay/red bildirimi |

Bilinmeyen şablon adı **reddedilir**.

## Güvenlik

| Önlem | Neden |
|---|---|
| `timingSafeEqual` | Dize karşılaştırması ilk farklı karakterde durur; saldırgan süreyi ölçerek anahtarı çözebilir |
| Hız sınırı | Anahtar sızsa bile sınırsız gönderim olmasın |
| IP listesi | İkinci katman; anahtar sızsa bile başka yerden kullanılamaz |
| 16 KB gövde sınırı | Sınırsız okuma bellek tüketme saldırısına açık |
| Şablon beyaz listesi | Rastgele içerik gönderilemez |
| HTML kaçırma | Kullanıcı adı gövdeye giriyor; kaçırılmazsa HTML enjeksiyonu |
| Günlük tavan | Sağlayıcı kotası korunur |
| `skip locked` | İki kopya aynı maili iki kez göndermez |
| `USER node` | Konteyner ele geçirilse bile yetki dar |
| `/status` 404 döner | Yanlış anahtarda ucun varlığı sızdırılmaz |

Doğrulanan davranış:

```
anahtarsız              401
yanlış anahtar          401
GET metodu              405
doğru anahtar           202
bilinmeyen şablon       400
geçersiz e-posta        400
20 KB gövde             413
hız sınırı              429
zamanlama farkı         0.22 ms  (sızıntı yok)
```

## Ölçekleme

Birden fazla kopya çalıştırabilirsin; `mail_claim_jobs`
`for update skip locked` kullandığı için aynı mail iki kez
gönderilmez. Her kopyaya farklı `WORKER_NAME` ver.
