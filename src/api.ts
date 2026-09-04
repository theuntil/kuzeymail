import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { env } from "./env.js";
import { render, knownTemplates } from "./templates/index.js";
import { safeKeyMatch, RateLimiter, validEmail, readBody } from "./security.js";

/**
 * HTTP API
 *
 * DOĞRUDAN GÖNDERİM. Doğrulama ve şifre sıfırlama kodları
 * kullanıcının EKRANDA BEKLEDİĞİ maillerdir; kuyruğa atıp 15
 * saniye beklemek yanlıştı. İstek geldiğinde SMTP'ye anında
 * verilir ve sonuç yanıtta döner.
 *
 * Kuyruk yalnızca toplu gönderim (bülten) için duruyor.
 */
const MAX_BODY = 16 * 1024;
const limiter = new RateLimiter(env.apiRateMax, env.apiRateWindowMs);
/** Şifre sıfırlama daha sıkı: adres taramasını zorlaştırır */
const resetLimiter = new RateLimiter(5, 60_000);

export interface Sender {
  send(input: {
    to: string; toName: string | null;
    subject: string; html: string; text: string;
  }): Promise<void>;
  enabled(): Promise<boolean>;
  /** Hatayı servis loguna yazar */
  onError?(err: unknown, to: string, template: string): void;
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** Ortak kapı: anahtar, IP listesi, hız sınırı */
function guard(
  req: IncomingMessage,
  res: ServerResponse,
  lim: RateLimiter,
): { ok: false } | { ok: true; ip: string } {
  if (!env.apiKey) { json(res, 404, { error: "not_found" }); return { ok: false }; }
  if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return { ok: false }; }

  const ip = clientIp(req);
  if (env.apiAllowIps.length && !env.apiAllowIps.includes(ip)) {
    json(res, 403, { error: "forbidden" });
    return { ok: false };
  }

  const key = req.headers["x-api-key"];
  if (!safeKeyMatch(typeof key === "string" ? key : undefined, env.apiKey)) {
    lim.check(ip);                       // yanlış anahtar da sayılsın
    json(res, 401, { error: "unauthorized" });
    return { ok: false };
  }

  const rate = lim.check(ip);
  if (!rate.ok) {
    res.setHeader("Retry-After", String(rate.retryAfter));
    json(res, 429, { error: "rate_limited", retry_after: rate.retryAfter });
    return { ok: false };
  }
  return { ok: true, ip };
}

async function parse<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  try {
    const raw = await readBody(req, MAX_BODY);
    return JSON.parse(raw || "{}") as T;
  } catch (err) {
    const big = err instanceof Error && err.message === "payload_too_large";
    json(res, big ? 413 : 400, { error: big ? "payload_too_large" : "invalid_json" });
    return null;
  }
}

/* ============================================================
   POST /api/send — doğrudan gönderim
   ============================================================ */
export async function handleSend(
  req: IncomingMessage, res: ServerResponse, sender: Sender,
): Promise<void> {
  const g = guard(req, res, limiter);
  if (!g.ok) return;

  const body = await parse<{
    template?: unknown; to?: unknown; to_name?: unknown;
    payload?: unknown; locale?: unknown;
  }>(req, res);
  if (!body) return;

  const template = typeof body.template === "string" ? body.template : "";
  if (!knownTemplates.includes(template)) {
    json(res, 400, { error: "unknown_template", allowed: knownTemplates });
    return;
  }
  if (!validEmail(body.to)) { json(res, 400, { error: "invalid_email" }); return; }

  /**
   * MAİL KAPALIYSA 200 DÖNMEZ.
   *
   * Eskiden `200 {status:"skipped"}` dönüyordu; çağıran taraf
   * `res.ok` kontrolüyle bunu BAŞARI sayıp kullanıcıya
   * "gönderildi" diyordu ama hiçbir mail çıkmıyordu.
   *
   * Artık 503 dönüyor: çağıran hatayı görmezden gelemez.
   */
  if (!(await sender.enabled())) {
    json(res, 503, { error: "mail_disabled",
      hint: "Yönetim paneli → Mail bölümünden servisi aç" });
    return;
  }

  const payload =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>) : {};

  const view = render(template, payload, env.siteUrl);
  if (!view) { json(res, 400, { error: "render_failed" }); return; }

  try {
    await sender.send({
      to: body.to,
      toName: typeof body.to_name === "string" ? body.to_name.slice(0, 80) : null,
      subject: view.subject, html: view.html, text: view.text,
    });
    json(res, 200, { status: "sent" });
  } catch (err) {
    // Servis loguna yaz: "loglarda hiçbir şey yok" olmasın
    sender.onError?.(err, String(body.to), template);
    json(res, 502, {
      error: "send_failed",
      detail: err instanceof Error ? err.message : "bilinmeyen hata",
    });
  }
}

/* ============================================================
   POST /api/password-reset/request
   ============================================================ */
export async function handleResetRequest(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient, sender: Sender,
): Promise<void> {
  const g = guard(req, res, resetLimiter);
  if (!g.ok) return;

  const body = await parse<{ email?: unknown }>(req, res);
  if (!body) return;
  if (!validEmail(body.email)) { json(res, 400, { error: "invalid_email" }); return; }

  /**
   * E-POSTANIN VARLIĞI SIZDIRILMAZ.
   *
   * Kayıt olmayan adres için de aynı yanıt döner. Aksi hâlde
   * adres listesi taranarak hangi e-postaların kayıtlı olduğu
   * öğrenilebilirdi.
   */
  const ipHash = createHash("sha256").update(g.ip).digest("hex").slice(0, 32);

  const { data, error } = await sb.rpc("create_password_reset", {
    p_email: body.email,
    p_ip_hash: ipHash,
  });

  if (error) { json(res, 502, { error: "db_error" }); return; }

  const row = Array.isArray(data) ? data[0] : null;
  if (row && (await sender.enabled())) {
    const view = render("password_reset", { code: row.code, name: row.name }, env.siteUrl);
    if (view) {
      try {
        await sender.send({
          to: row.email, toName: row.name ?? null,
          subject: view.subject, html: view.html, text: view.text,
        });
      } catch (err) {
        // Kullanıcıya sızdırılmaz ama LOGA yazılır
        sender.onError?.(err, row.email, "password_reset");
      }
    }
  }

  json(res, 200, { status: "ok" });
}

/* ============================================================
   POST /api/auth/autoconfirm — KAYIT SONRASI OTOMATİK ONAY

   Supabase'de "Confirm email" açıksa `signUp` oturum döndürmez
   ve kullanıcı giriş ekranına atılır. Bizim kendi doğrulama
   sistemimiz olduğu için Supabase'inki gereksiz.

   GÜVENLİK: yalnızca SON 2 DAKİKADA açılmış ve henüz
   onaylanmamış hesaplar onaylanır (`can_autoconfirm` kontrol
   ediyor). Bu uç ele geçirilse bile eski hesaplar onaylanamaz.
   ============================================================ */
export async function handleAutoConfirm(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
): Promise<void> {
  const g = guard(req, res, limiter);
  if (!g.ok) return;

  const body = await parse<{ email?: unknown }>(req, res);
  if (!body) return;
  if (!validEmail(body.email)) { json(res, 400, { error: "invalid_email" }); return; }

  const { data: userId, error } = await sb.rpc("can_autoconfirm", {
    p_email: body.email,
  });

  if (error) { json(res, 502, { error: "db_error" }); return; }
  // Uygun değil: zaten onaylı ya da eski hesap
  if (!userId) { json(res, 200, { status: "skipped" }); return; }

  const { error: updErr } = await sb.auth.admin.updateUserById(
    String(userId),
    { email_confirm: true },
  );

  if (updErr) { json(res, 502, { error: "confirm_failed", detail: updErr.message }); return; }
  json(res, 200, { status: "ok" });
}

/* ============================================================
   POST /api/password-reset/check-email — KAYITLI MI

   Kayıtsız adresle şifre sıfırlama akışına devam edilmemeli.

   Bu bir SAYIM ORACLE'ı: adres listesi taranarak kimlerin üye
   olduğu öğrenilebilir. Bu yüzden `resetLimiter` (dakikada 5)
   ve IP yasağı uygulanıyor; sınırsız tarama mümkün değil.
   ============================================================ */
export async function handleCheckEmail(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
): Promise<void> {
  const g = guard(req, res, resetLimiter);
  if (!g.ok) return;

  const body = await parse<{ email?: unknown }>(req, res);
  if (!body) return;
  if (!validEmail(body.email)) { json(res, 400, { error: "invalid_email" }); return; }

  const ipHash = createHash("sha256").update(g.ip).digest("hex").slice(0, 32);

  const { data, error } = await sb.rpc("email_registered", {
    p_email: body.email,
    p_ip_hash: ipHash,
  });

  if (error) { json(res, 502, { error: "db_error" }); return; }
  json(res, 200, { status: "ok", registered: data === true });
}

/* ============================================================
   POST /api/password-reset/verify — KOD DOĞRULAMA
   
   Kod BURADA kontrol edilir. Doğruysa tek kullanımlık bilet
   döner ve kullanıcı şifre adımına geçer. Yanlışsa geçemez.
   Eskiden kod ancak şifre yazıldıktan sonra kontrol ediliyordu.
   ============================================================ */
export async function handleResetVerify(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
): Promise<void> {
  const g = guard(req, res, resetLimiter);
  if (!g.ok) return;

  const body = await parse<{ email?: unknown; code?: unknown }>(req, res);
  if (!body) return;

  if (!validEmail(body.email)) { json(res, 400, { error: "invalid_email" }); return; }
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code.trim())) {
    json(res, 400, { error: "invalid_code" });
    return;
  }

  const ipHash = createHash("sha256").update(g.ip).digest("hex").slice(0, 32);

  const { data: ticket, error } = await sb.rpc("check_password_reset", {
    p_email: body.email,
    p_code: body.code.trim(),
    p_ip_hash: ipHash,
  });

  if (error) { json(res, 502, { error: "db_error" }); return; }
  if (!ticket) { json(res, 400, { error: "invalid_code" }); return; }

  json(res, 200, { status: "ok", ticket });
}

/* ============================================================
   POST /api/password-reset/confirm
   ============================================================ */
export async function handleResetConfirm(
  req: IncomingMessage, res: ServerResponse, sb: SupabaseClient,
): Promise<void> {
  const g = guard(req, res, resetLimiter);
  if (!g.ok) return;

  const body = await parse<{ email?: unknown; ticket?: unknown; password?: unknown }>(req, res);
  if (!body) return;

  if (!validEmail(body.email)) { json(res, 400, { error: "invalid_email" }); return; }
  if (typeof body.ticket !== "string" || body.ticket.length < 32) {
    json(res, 400, { error: "invalid_ticket" });
    return;
  }
  if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 200) {
    json(res, 400, { error: "weak_password" });
    return;
  }

  // Bilet kod doğrulandığında verilmişti; kod burada tekrar sorulmaz
  const { data: userId, error } = await sb.rpc("finish_password_reset", {
    p_email: body.email,
    p_ticket: body.ticket,
  });

  if (error) { json(res, 502, { error: "db_error" }); return; }
  if (!userId) { json(res, 400, { error: "invalid_or_expired" }); return; }

  /**
   * Şifre Supabase Admin API ile değiştirilir.
   *
   * `auth.users` tablosuna doğrudan yazmak Supabase'in şifreleme
   * ve oturum mantığını atlar; kullanıcı bir daha giriş yapamaz.
   * Bu yüzden resmi API kullanılıyor.
   *
   * Bu işlem service_role gerektiriyor — ve service_role yalnızca
   * bu serviste var. Şifre sıfırlamanın burada olmasının sebebi
   * budur.
   */
  const { error: updErr } = await sb.auth.admin.updateUserById(
    String(userId),
    { password: body.password },
  );

  if (updErr) { json(res, 502, { error: "update_failed", detail: updErr.message }); return; }
  json(res, 200, { status: "ok" });
}

/* ══════════════════════════════════════════════════════════════
   POST /api/auth/delete-user — HESABI GERÇEKTEN SİL

   ┌─ KULLANICI SİLİNMİŞ GÖRÜNÜP SİLİNMİYORDU ⚠️ ──────────────┐
   │ Panel `admin_delete_user` RPC'sini çağırıyordu. O fonksiyon│
   │ profili ve tüm içeriği siliyor ama `auth.users` satırına   │
   │ KASITLI olarak dokunmuyor — SQL'den silmek Supabase'in     │
   │ oturum ve token mantığını bozar.                            │
   │                                                              │
   │ Fonksiyonun yorumunda "panel bunu auth.admin.deleteUser()  │
   │ ile yapıyor" yazıyordu ama O ÇAĞRI HİÇBİR YERDE YOKTU.     │
   │ Sonuç:                                                       │
   │   • Auth kaydı duruyor, kullanıcı giriş denemesi yapabiliyor│
   │   • Profili silindiği için giriş sonrası hata alıyor       │
   │   • Aynı e-posta ile yeniden kayıt olunamıyor ("zaten var")│
   │                                                              │
   │ Silme `service_role` gerektiriyor ve o anahtar YALNIZCA bu │
   │ serviste var — şifre sıfırlama da bu yüzden burada.        │
   └──────────────────────────────────────────────────────────────┘
   ══════════════════════════════════════════════════════════════ */
export async function handleDeleteUser(
  req: IncomingMessage,
  res: ServerResponse,
  sb: SupabaseClient,
): Promise<void> {
  const g = guard(req, res, resetLimiter);
  if (!g.ok) return;

  const body = await parse<{ user_id?: string }>(req, res);
  if (body === null) return;
  const id = String(body?.user_id ?? "").trim();

  /* UUID biçimi — rastgele metinle Admin API'yi yormayalım */
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    json(res, 400, { error: "invalid_user_id" });
    return;
  }

  /*
   * ⚠ PROFİL ZATEN SİLİNMİŞ OLMALI.
   *
   * Bu uç yalnızca auth kaydını temizliyor; içerik silme işini
   * `admin_delete_user` yapıyor ve önce o çağrılıyor. Profil
   * hâlâ duruyorsa panel sırayı bozmuş demektir — auth kaydını
   * silmek kullanıcıyı yetim profille bırakırdı.
   */
  const { data: profil } = await sb
    .from("profiles").select("id").eq("id", id).maybeSingle();

  if (profil) {
    json(res, 409, { error: "profile_still_exists" });
    return;
  }

  const { error } = await sb.auth.admin.deleteUser(id);

  if (error) {
    /*
     * Auth kaydı zaten yoksa bu bir hata değil: işin sonucu
     * istenen durumla aynı. Panel gereksiz hata göstermesin.
     */
    if (/not found/i.test(error.message)) {
      json(res, 200, { status: "ok", zaten_yoktu: true });
      return;
    }
    json(res, 502, { error: "delete_failed", detail: error.message });
    return;
  }

  json(res, 200, { status: "ok" });
}
