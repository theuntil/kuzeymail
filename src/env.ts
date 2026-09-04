/**
 * ORTAM DEĞİŞKENLERİ
 *
 * Eksik bir değişkenle başlamaz: yarım yapılandırmayla çalışıp
 * sessizce mail göndermemektense açılışta net hata vermek daha
 * iyi. Dokploy'da servis kırmızı yanar, sebebi loglarda yazar.
 */
function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[env] ${name} tanımlı değil — servis başlatılamıyor.`);
    process.exit(1);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const env = {
  // Supabase — kuyruğu okumak ve sonucu yazmak için
  supabaseUrl: need("SUPABASE_URL"),
  // SERVICE ROLE anahtarı: mail_claim_jobs yalnızca ona açık
  supabaseKey: need("SUPABASE_SERVICE_KEY"),

  // SMTP
  smtpHost: need("SMTP_HOST"),
  smtpPort: Number(opt("SMTP_PORT", "587")),
  smtpUser: need("SMTP_USER"),
  smtpPass: need("SMTP_PASS"),
  smtpSecure: opt("SMTP_SECURE", "false") === "true",

  /**
   * GÖNDEREN ADRESİ
   *
   * Çoğu SMTP sunucusu, `From` adresinin kimlik doğrulanan
   * hesaba ait olmasını ZORUNLU tutar:
   *
   *   553 5.7.1 <noreply@site.com>: Sender address rejected:
   *   not owned by user iletisim@site.com
   *
   * Bu yüzden gönderen adresi veritabanından DEĞİL, buradan
   * alınır. Tanımlı değilse SMTP kullanıcısının kendisi kullanılır
   * — o adres tanım gereği hesaba aittir, sunucu reddedemez.
   *
   * Sunucun takma ad (alias) destekliyorsa MAIL_FROM ile
   * değiştirebilirsin.
   */
  mailFrom: process.env.MAIL_FROM?.trim() || null,

  // Bağlantılarda kullanılacak site adresi
  siteUrl: opt("SITE_URL", "https://kuzeybatihaber.com.tr").replace(/\/+$/, ""),

  /*
   * Mail başlığındaki logo.
   *
   * ⚠ AÇIK TEMA LOGOSU KULLANILIYOR.
   * Mail gövdesi beyaz zeminli; koyu tema logosu (açık renkli
   * çizim) beyaz üstünde görünmez olurdu. Posta kutuları
   * `prefers-color-scheme`'i güvenilir biçimde desteklemediği
   * için tek logo, açık zemine göre seçiliyor.
   *
   * Değer panelin `logo_light_key` alanıyla aynı olmalı;
   * CDN adresi başına ekleniyor.
   */
  logoUrl: opt("MAIL_LOGO_URL", "").trim() || null,

  // Çalışma
  workerName: opt("WORKER_NAME", `mail-${process.pid}`),
  pollMs: Number(opt("POLL_MS", "15000")),
  recoverMinutes: Number(opt("RECOVER_MINUTES", "10")),

  // HTTP sunucusu
  port: Number(opt("PORT", "8080")),

  /**
   * HTTP API ANAHTARI — İSTEĞE BAĞLI
   *
   * TANIMLI DEĞİLSE `/api/send` ucu HİÇ AÇILMAZ; servis yalnızca
   * kuyruğu çeker. Bu en güvenli kurulum, saldırı yüzeyi sıfır.
   *
   * Tanımlarsan uç açılır ve yalnızca bu anahtarla çağrılabilir.
   * Anahtar üretmek için:  openssl rand -hex 32
   */
  apiKey: process.env.MAIL_API_KEY?.trim() || null,

  // Anahtar doğru olsa bile IP başına dakikada kaç istek
  apiRateMax: Number(opt("API_RATE_MAX", "60")),
  apiRateWindowMs: Number(opt("API_RATE_WINDOW_MS", "60000")),

  /**
   * İZİNLİ IP'LER — isteğe bağlı ikinci katman.
   *
   * Virgülle ayrılmış liste. Doluysa yalnızca bu adreslerden
   * gelen istek kabul edilir; anahtar sızsa bile başka yerden
   * kullanılamaz.
   */
  apiAllowIps: (process.env.API_ALLOW_IPS ?? "")
    .split(",").map((x) => x.trim()).filter(Boolean),
};
