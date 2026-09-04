import http from "node:http";
/* nodemailer artık runtime.ts içinde: taşıyıcı ayara göre kurulur */
import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import { render, renderDb, knownTemplates, type DbTemplate, type Brand } from "./templates/index.js";
import { loadRuntimeConf, getTransport, fromAdresi, closeTransport, type RuntimeConf } from "./runtime.js";
import { imapSync } from "./imap.js";
import { ekleriIndir } from "./ekler.js";
import {
  handleSend, handleResetRequest, handleResetVerify, handleResetConfirm,
  handleDeleteUser,
  handleAutoConfirm, handleCheckEmail, type Sender,
} from "./api.js";
import { safeKeyMatch } from "./security.js";

/**
 * KUZEYBATI HABER — MAİL SERVİSİ
 *
 * Ayrı bir Docker servisi. Yaptığı iş tek: Supabase'deki
 * `mail_queue` tablosundan iş alır, SMTP ile gönderir, sonucu
 * yazar.
 *
 * NEDEN AYRI SERVİS
 *   • SMTP kimliği siteye hiç girmez — site sızsa bile mail
 *     hesabı ele geçirilemez
 *   • Site trafiğinden bağımsız ölçeklenir
 *   • Mail sağlayıcısı değişince yalnızca bu servis güncellenir
 *
 * GÜVENLİK
 *   • Dışarıya AÇIK UÇ YOK. Yalnızca `/health` var ve o da
 *     sadece "ayakta mıyım" der; kuyruk sayısı bile vermez.
 *   • Servis kimseden istek KABUL ETMEZ; kuyruğu kendisi çeker.
 *     Böylece saldırı yüzeyi sıfıra yakın.
 *   • Alıcı adresi kuyruktan gelir, dışarıdan gelen veriyle
 *     mail gönderilemez (mail bombası riski yok).
 *   • Şablon adı beyaz listede; bilinmeyen şablon başarısız
 *     işaretlenir, gönderilmez.
 */

const sb = createClient(env.supabaseUrl, env.supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/*
 * SABİT TAŞIYICI KALDIRILDI.
 *
 * SMTP bilgileri artık veritabanından geliyor ve panelden
 * değişebiliyor. Taşıyıcı `getTransport()` içinde ayarın parmak
 * izine göre önbelleklenir: ayar aynıysa bağlantı yeniden
 * kullanılır, değişirse eski havuz kapatılıp yenisi kurulur.
 */

interface Job {
  id: string;
  to_email: string;
  to_name: string | null;
  template: string;
  payload: Record<string, unknown>;
  locale: string;
  attempts: number;
}

interface MailSettings {
  from_name: string;
  from_email: string;
  reply_to: string | null;
}

let running = false;
let lastTick: Date | null = null;
let lastError: string | null = null;
let sentCount = 0;

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

async function loadSettings(): Promise<RuntimeConf | null> {
  try {
    const c = await loadRuntimeConf(sb);
    if (!c.is_enabled) return null;     // panelden kapatılmış
    return c;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/**
 * Şablonu ÖNCE veritabanından dener.
 *
 * Bulamazsa koddaki yedeğe düşer — böylece yama-44
 * uygulanmamış kurulumlarda servis çalışmaya devam eder.
 */
async function sablonAl(
  template: string, locale: string,
): Promise<DbTemplate | null> {
  try {
    const { data, error } = await sb.rpc("mail_sablon_getir", {
      p_anahtar: template, p_locale: locale || "tr",
    });
    if (error || !data) return null;
    const r = Array.isArray(data) ? data[0] : data;
    return r && r.konu ? (r as DbTemplate) : null;
  } catch {
    return null;
  }
}

async function sendOne(job: Job, s: RuntimeConf): Promise<void> {
  const brand: Brand = {
    name: s.brand?.name ?? null,
    logo_url: s.brand?.logo_url ?? null,
    site_url: s.brand?.site_url ?? env.siteUrl,
    footer_note: s.brand?.footer_note ?? null,
    signature_html: s.brand?.signature_html ?? null,
  };

  // Panelden düzenlenen şablon öncelikli; yoksa koddaki yedek
  const db = await sablonAl(job.template, job.locale);
  const view = db
    ? renderDb(db, job.payload ?? {}, brand)
    : render(job.template, job.payload ?? {}, brand.site_url ?? env.siteUrl);

  if (!view) {
    // Bilinmeyen şablon: tekrar denemenin anlamı yok, kalıcı hata
    await sb.rpc("mail_finish_job", {
      p_id: job.id,
      p_ok: false,
      p_error: `Bilinmeyen şablon: ${job.template}. Tanımlı olanlar: ${knownTemplates.join(", ")}`,
    });
    log("şablon yok:", job.template);
    return;
  }

  const { adres, uyari } = fromAdresi(s);
  if (uyari) log("UYARI:", uyari);

  const pl = (job.payload ?? {}) as Record<string, unknown>;
  const mesajRef = typeof pl.message_ref === "string" ? pl.message_ref : null;

  /*
   * EKLER R2'DEN İNDİRİLİYOR.
   *
   * İndirme başarısız olursa mail EKSİZ GÖNDERİLMEZ — hata
   * fırlatılıp iş kuyrukta bırakılır. Ek beklenen bir mailin
   * eksiz gitmesi, hiç gitmemesinden kötü: alıcı "boş mail
   * attın" der, gönderen fark etmez.
   */
  let ekler: Awaited<ReturnType<typeof ekleriIndir>> = [];
  try {
    ekler = await ekleriIndir(pl.attachments, log);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb.rpc("mail_finish_job", { p_id: job.id, p_ok: false, p_error: `Ek indirilemedi: ${msg}` });
    if (mesajRef) {
      /* Sonuç yazılamazsa mail zaten gitmedi; sessizce geç */
      try {
        await sb.rpc("mail_message_result", {
          p_id: mesajRef, p_ok: false, p_error: `Ek indirilemedi: ${msg}`,
        });
      } catch { /* yok say */ }
    }
    log("ek hatası:", job.to_email, "|", msg);
    return;
  }

  /*
   * Yanıt zinciri başlıkları.
   *
   * `In-Reply-To` ve `References` olmadan yanıt, alıcının posta
   * kutusunda AYRI bir konuşma olarak görünüyor. Bu iki başlık
   * onu orijinal zincire bağlıyor.
   */
  const inReplyTo = typeof pl.in_reply_to === "string" ? pl.in_reply_to : undefined;

  try {
    await getTransport(s.smtp).sendMail({
      from: `"${s.from_name ?? brand.name ?? "Kuzeybatı Haber"}" <${adres}>`,
      replyTo: s.reply_to ?? undefined,
      to: job.to_name ? `"${job.to_name}" <${job.to_email}>` : job.to_email,
      subject: view.subject,
      text: view.text,
      html: view.html,
      attachments: ekler.length ? ekler : undefined,
      inReplyTo,
      references: inReplyTo ? [inReplyTo] : undefined,
      headers: {
        // Otomatik yanıt ve tatil mesajlarını engelle
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
      },
    });

    await sb.rpc("mail_finish_job", { p_id: job.id, p_ok: true });

    // Panelin "Giden postalar" listesindeki kaydı da güncelle
    if (mesajRef) {
      /* Sonuç yazılamazsa mail YİNE DE gitti — hata sayılmaz */
      try {
        await sb.rpc("mail_message_result", { p_id: mesajRef, p_ok: true });
      } catch { /* yok say */ }
    }

    sentCount += 1;
    log("gönderildi:", job.template, "→", job.to_email,
        ekler.length ? `(${ekler.length} ek)` : "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb.rpc("mail_finish_job", { p_id: job.id, p_ok: false, p_error: msg });
    if (mesajRef) {
      try {
        await sb.rpc("mail_message_result", { p_id: mesajRef, p_ok: false, p_error: msg });
      } catch { /* yok say */ }
    }
    log("hata:", job.template, "→", job.to_email, "|", msg);
  }
}

async function tick(): Promise<void> {
  if (running) return;           // önceki tur bitmeden yenisi başlamasın
  running = true;
  lastTick = new Date();

  try {
    const s = await loadSettings();
    if (!s) { running = false; return; }

    // Çöken bir kopyanın kilitli bıraktığı işleri serbest bırak
    await sb.rpc("mail_recover_stuck", { p_minutes: env.recoverMinutes });

    /*
     * GELEN KUTUSU
     *
     * Gönderimden ÖNCE çalışır: yeni gelen bir maile yanıt
     * yazılmışsa aynı turda gönderilebilsin.
     *
     * IMAP kapalıysa ya da yapılandırılmamışsa sessizce geçer.
     * Hata olursa kuyruk işlemeyi ENGELLEMEZ — gelen kutusu
     * çalışmıyor diye gönderim de durmasın.
     */
    try {
      await imapSync(sb, s, log);
    } catch (err) {
      log("IMAP turu başarısız (gönderim devam ediyor):",
          err instanceof Error ? err.message : err);
    }

    const { data, error } = await sb.rpc("mail_claim_jobs", {
      p_worker: env.workerName,
      p_limit: null,
    });

    if (error) {
      lastError = error.message;
      log("kuyruk okunamadı:", error.message);
      running = false;
      return;
    }

    const jobs = (data ?? []) as Job[];
    if (jobs.length === 0) { running = false; return; }

    log(`${jobs.length} iş alındı`);
    // Sıralı gönderim: sağlayıcı hız sınırını zorlamamak için
    for (const job of jobs) await sendOne(job, s);

    lastError = null;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    log("tur hatası:", lastError);
  } finally {
    running = false;
  }
}

/* ---------------- HTTP sunucu ---------------- */

/**
 * GÖNDERİCİ
 *
 * API uçları SMTP'yi doğrudan tanımaz; bu arayüzden geçer.
 * Böylece gönderim mantığı (ayar okuma, gönderen adı, başlıklar)
 * tek yerde kalır ve uçlar test edilebilir olur.
 */
const sender: Sender = {
  async enabled() {
    return (await loadSettings()) !== null;
  },
  async send({ to, toName, subject, html, text }) {
    const s = await loadSettings();
    if (!s) throw new Error("Mail servisi kapalı");

    /**
     * Gönderen adresi artık PANELDEN gelebiliyor.
     *
     * Öncelik: MAIL_FROM (ortam) → paneldeki from_email →
     * SMTP kullanıcısı. Son ikisi farklıysa `fromAdresi()`
     * uyarı döndürüyor ve loga yazılıyor; sunucu 553 verirse
     * sebebi loglarda hazır duruyor.
     */
    const { adres: fromAddress, uyari } = fromAdresi(s);
    if (uyari) log("uyarı:", uyari);

    await getTransport(s.smtp).sendMail({
      from: `"${s.from_name ?? "Kuzeybatı Haber"}" <${fromAddress}>`,
      replyTo: s.reply_to ?? undefined,
      to: toName ? `"${toName}" <${to}>` : to,
      subject, text, html,
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Auto-Response-Suppress": "All",
      },
    });

    sentCount += 1;
    log("gönderildi →", to, "|", subject);
  },
  onError: logSendError,
};

/**
 * Gönderim hatalarını LOGLA.
 *
 * API yolunda hata yalnızca yanıtta dönüyordu; servis loglarında
 * hiçbir iz kalmıyordu. Sorun yaşandığında "loglarda bir şey yok"
 * demek en kötü durum.
 */
function logSendError(err: unknown, to: string, template: string) {
  const msg = err instanceof Error ? err.message : String(err);
  lastError = msg;
  log("GÖNDERİM HATASI →", to, "|", template, "|", msg);
}

/* ---------------- HTTP sunucusu ---------------- */
const server = http.createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  /**
   * Sağlık ucu — kimlik gerektirmez ama BİLGİ SIZDIRMAZ.
   * Kuyruk uzunluğu, hata metni gibi ayrıntılar burada verilmez;
   * yalnızca "ayakta mıyım" sorusunu yanıtlar. Dokploy ve
   * Docker sağlık kontrolü bunu kullanır.
   */
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", worker: env.workerName }));
    return;
  }

  /** Ayrıntılı durum — yalnızca API anahtarıyla görülür */
  if (path === "/status") {
    const key = req.headers["x-api-key"];
    if (!env.apiKey || typeof key !== "string" || !safeKeyMatch(key, env.apiKey)) {
      // 401 yerine 404: ucun varlığı bile sızdırılmaz
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      worker: env.workerName,
      lastTick: lastTick?.toISOString() ?? null,
      sent: sentCount,
      lastError,
      templates: knownTemplates,
    }));
    return;
  }

  if (path === "/api/send") {
    void handleSend(req, res, sender);
    return;
  }
  if (path === "/api/password-reset/request") {
    void handleResetRequest(req, res, sb, sender);
    return;
  }
  if (path === "/api/auth/autoconfirm") {
    void handleAutoConfirm(req, res, sb);
    return;
  }
  if (path === "/api/password-reset/check-email") {
    void handleCheckEmail(req, res, sb);
    return;
  }
  if (path === "/api/password-reset/verify") {
    void handleResetVerify(req, res, sb);
    return;
  }
  if (path === "/api/password-reset/confirm") {
    void handleResetConfirm(req, res, sb);
    return;
  }
  if (path === "/api/auth/delete-user") {
    void handleDeleteUser(req, res, sb);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

async function main() {
  /*
   * AÇILIŞTA SMTP DOĞRULAMASI
   *
   * Ayar artık veritabanından geldiği için önce onu okuyoruz.
   * Okunamazsa `.env` yedeğine düşülür — servis yine de başlar.
   * Bağlantı sorunu geçici olabilir; her turda yeniden denenir
   * ve gönderim hataları kuyruğa yazılır.
   */
  try {
    const c = await loadRuntimeConf(sb);
    await getTransport(c.smtp).verify();
    log("SMTP bağlantısı doğrulandı:", c.smtp.host,
        c.smtp.host === env.smtpHost ? "(.env)" : "(panel)");

    const { uyari } = fromAdresi(c);
    if (uyari) log("UYARI:", uyari);

    if (!c.is_enabled) {
      log("═══ MAİL PANELDEN KAPALI ═══");
      log("Açmak için: panel → Mail ayarları → Mail servisi");
    }
  } catch (err) {
    log("SMTP doğrulanamadı (servis yine de başlıyor):",
        err instanceof Error ? err.message : err);
  }

  server.listen(env.port, () => {
    log(`sağlık ucu  :${env.port}/health`);
    log(env.apiKey
      ? `HTTP API   :${env.port}/send (anahtar tanımlı)`
      : "HTTP API   kapalı — yalnızca kuyruktan çalışıyor");
  });

  await tick();
  setInterval(() => { void tick(); }, env.pollMs);
  log(`servis çalışıyor — her ${env.pollMs / 1000} saniyede bir kuyruk kontrol edilecek`);
}

/** Dokploy konteyneri durdururken açık işleri bitirmeye çalış */
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`${sig} alındı, kapanıyor…`);
    server.close();
    /* Taşıyıcı önbellekte; kapanış onu da temizler. */
    closeTransport();
    setTimeout(() => process.exit(0), 2000);
  });
}

void main();
