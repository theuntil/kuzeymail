import nodemailer, { type Transporter } from "nodemailer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * ÇALIŞMA ANI YAPILANDIRMASI
 *
 * SMTP bilgileri artık ortam değişkeninde DEĞİL, veritabanında.
 * Panelden değiştirilince servis bir sonraki turda yeni ayarla
 * çalışır — deploy gerekmez.
 *
 * ┌─ ORTAM DEĞİŞKENİ YEDEK OLARAK DURUYOR ⚠️ ──────────────────┐
 * │ Veritabanında SMTP tanımlı değilse `.env` kullanılır.        │
 * │ Böylece bu sürüme geçiş sırasında servis çalışmaya devam    │
 * │ eder; panelden ayar girilince kendiliğinden ona döner.      │
 * └──────────────────────────────────────────────────────────────┘
 */

export interface SmtpConf {
  host: string; port: number; secure: boolean;
  user: string; pass: string;
}

export interface RuntimeConf {
  is_enabled: boolean;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  batch_size: number;
  daily_limit: number;
  smtp: SmtpConf;
  imap: {
    enabled: boolean; host: string | null; port: number; secure: boolean;
    user: string | null; pass: string | null;
    folder: string; sent_folder: string; trash_folder: string;
    save_sent: boolean; last_uid: number;
  };
  brand: {
    name: string | null; logo_url: string | null; site_url: string | null;
    footer_note: string | null; signature_html: string | null;
  };
}

/** `.env`'den kurulan yedek yapılandırma */
function envYedegi(): RuntimeConf {
  return {
    is_enabled: true,
    from_name: null, from_email: null, reply_to: null,
    batch_size: 10, daily_limit: 500,
    smtp: {
      host: env.smtpHost, port: env.smtpPort, secure: env.smtpSecure,
      user: env.smtpUser, pass: env.smtpPass,
    },
    imap: {
      enabled: false, host: null, port: 993, secure: true,
      user: null, pass: null, folder: "INBOX",
      sent_folder: "Sent", trash_folder: "Trash",
      save_sent: false, last_uid: 0,
    },
    brand: {
      name: null, logo_url: null, site_url: env.siteUrl,
      footer_note: null, signature_html: null,
    },
  };
}

export async function loadRuntimeConf(sb: SupabaseClient): Promise<RuntimeConf> {
  const { data, error } = await sb.rpc("mail_runtime_config");

  if (error || !data) {
    // Yama uygulanmamış ya da geçici hata: servis durmasın
    return envYedegi();
  }

  const c = data as RuntimeConf;

  /*
   * Veritabanındaki SMTP EKSİKSE ortam değişkenine dön.
   * Yarım yapılandırmayla bağlanmaya çalışmak, her turda
   * anlamsız bir hata logu üretir.
   */
  if (!c.smtp?.host || !c.smtp?.user || !c.smtp?.pass) {
    const y = envYedegi();
    return { ...c, smtp: y.smtp };
  }

  return c;
}

/**
 * Taşıyıcı önbelleği.
 *
 * Her turda yeni bağlantı kurmak pahalı: SMTP el sıkışması
 * saniyeler sürüyor. Ama ayar DEĞİŞİRSE eski bağlantı yanlış
 * sunucuya bağlı kalır — bu yüzden ayarın parmak izi tutuluyor.
 */
let cached: { key: string; tx: Transporter } | null = null;

function parmakIzi(s: SmtpConf): string {
  // Parola da dahil: parola dönünce bağlantı yenilensin.
  return `${s.host}:${s.port}:${s.secure}:${s.user}:${s.pass.length}:${s.pass.slice(-4)}`;
}

export function getTransport(s: SmtpConf): Transporter {
  const key = parmakIzi(s);
  if (cached && cached.key === key) return cached.tx;

  if (cached) {
    // Eski havuzu kapat; açık bırakılırsa sunucudaki bağlantı
    // sınırı zamanla dolar.
    try { cached.tx.close(); } catch { /* zaten kapalı olabilir */ }
  }

  const tx = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.secure,
    auth: { user: s.user, pass: s.pass },
    pool: true, maxConnections: 3, maxMessages: 50,
  });

  cached = { key, tx };
  return tx;
}

/**
 * GÖNDEREN ADRESİ
 *
 * Panelde girilen adres SMTP kullanıcısından farklıysa çoğu
 * sunucu reddediyor:
 *   553 5.7.1 Sender address rejected: not owned by user ...
 *
 * `MAIL_FROM` tanımlıysa o, değilse paneldeki adres, o da yoksa
 * SMTP kullanıcısı kullanılır. SMTP kullanıcısı tanım gereği
 * hesaba aittir; sunucu reddedemez.
 */
export function fromAdresi(c: RuntimeConf): { adres: string; uyari: string | null } {
  const adres = env.mailFrom ?? c.from_email ?? c.smtp.user;
  const uyari =
    adres.toLowerCase() !== c.smtp.user.toLowerCase()
      ? `Gönderen (${adres}) SMTP kullanıcısından (${c.smtp.user}) farklı — ` +
        "sunucu reddedebilir (553). Alias tanımlı değilse ikisini eşitle."
      : null;
  return { adres, uyari };
}

/** Kapanışta havuzu temizle — açık bağlantı bırakmayalım */
export function closeTransport(): void {
  if (!cached) return;
  try { cached.tx.close(); } catch { /* zaten kapalı */ }
  cached = null;
}
