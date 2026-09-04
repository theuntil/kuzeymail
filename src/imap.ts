import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConf } from "./runtime.js";

/**
 * IMAP SENKRONU
 *
 * Gelen kutusunu okur ve yeni mailleri `mail_messages` tablosuna
 * yazar. Panel oradan okur.
 *
 * ┌─ ARTAN OKUMA (UID) ⚠️ ────────────────────────────────────┐
 * │ Her turda tüm kutuyu okumak, 5.000 mailli bir hesapta her  │
 * │ 15 saniyede 5.000 mail indirmek demek. Bunun yerine son    │
 * │ işlenen UID veritabanında tutuluyor ve yalnızca ondan       │
 * │ büyükler çekiliyor.                                          │
 * │                                                              │
 * │ UID'ler kutu başına artan ve TEKRAR KULLANILMAZ — IMAP      │
 * │ standardı bunu garanti eder. Sunucu kutuyu sıfırlarsa       │
 * │ UIDVALIDITY değişir; o durumda baştan okunur.                │
 * └──────────────────────────────────────────────────────────────┘
 *
 * ┌─ İLK ÇALIŞTIRMADA TÜM KUTU ÇEKİLMEZ ⚠️ ────────────────────┐
 * │ `last_uid = 0` iken tüm geçmiş indirilirse ilk tur          │
 * │ saatlerce sürer ve sağlayıcı bağlantıyı keser. İlk turda    │
 * │ yalnızca son `ILK_TUR_LIMIT` mail alınır; geri kalan geçmiş │
 * │ zaten posta istemcisinde duruyor.                            │
 * └──────────────────────────────────────────────────────────────┘
 */

/** Tek turda en fazla kaç mail — sağlayıcıyı boğmamak için */
const TUR_LIMIT = 40;
/** İlk çalıştırmada geriye dönük kaç mail alınsın */
const ILK_TUR_LIMIT = 25;
/** Gövde kırpma sınırları — devasa HTML satırı listeyi yavaşlatır */
const HTML_LIMIT = 900_000;
const TEXT_LIMIT = 200_000;

export interface SyncSonuc {
  yeni: number;
  okunan: number;
  sonUid: number;
  hata: string | null;
}

function kisalt(s: string | undefined, n: number): string | undefined {
  if (!s) return undefined;
  return s.length > n ? s.slice(0, n) : s;
}

/** Listede görünecek kısa metin */
function onizleme(text: string | undefined, html: string | undefined): string {
  const kaynak = text ?? (html ?? "").replace(/<[^>]+>/g, " ");
  return kaynak.replace(/\s+/g, " ").trim().slice(0, 280);
}

type Adres = { address?: string; name?: string };

function adresListesi(v: unknown): string[] | undefined {
  const o = v as { value?: Adres[] } | undefined;
  const list = o?.value?.map((a) => a.address).filter(Boolean) as string[] | undefined;
  return list && list.length ? list : undefined;
}

export async function imapSync(
  sb: SupabaseClient,
  conf: RuntimeConf,
  log: (...a: unknown[]) => void,
): Promise<SyncSonuc> {
  const c = conf.imap;
  const sonuc: SyncSonuc = { yeni: 0, okunan: 0, sonUid: c.last_uid, hata: null };

  if (!c.enabled || !c.host || !c.user || !c.pass) {
    return sonuc;   // kapalı ya da yarım yapılandırma — sessizce geç
  }

  const client = new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    // imapflow kendi logunu basıyor; bizimkiyle karışmasın
    logger: false,
    // Sağlayıcı yanıt vermezse tur sonsuza kadar asılı kalmasın
    socketTimeout: 60_000,
    greetingTimeout: 15_000,
  });

  try {
    await client.connect();

    // `getMailboxLock` bırakılmazsa sonraki tur kilitte bekler
    const lock = await client.getMailboxLock(c.folder || "INBOX");
    try {
      const kutu = client.mailbox;
      if (!kutu || typeof kutu === "boolean") {
        throw new Error(`Klasör açılamadı: ${c.folder}`);
      }

      let baslangic = c.last_uid;

      /*
       * İLK TUR: son N maili al, tüm geçmişi değil.
       * `uidNext` bir sonraki verilecek UID; ondan geriye sayarız.
       */
      if (baslangic <= 0) {
        const next = Number(kutu.uidNext ?? 1);
        baslangic = Math.max(0, next - ILK_TUR_LIMIT - 1);
        log(`IMAP ilk tur: son ${ILK_TUR_LIMIT} mail alınacak (uid > ${baslangic})`);
      }

      const aralik = `${baslangic + 1}:*`;
      let islenen = 0;

      for await (const msg of client.fetch(
        aralik,
        { uid: true, envelope: true, source: true, flags: true },
        { uid: true },
      )) {
        const uid = Number(msg.uid);

        /*
         * `1:*` aralığı kutu boşsa SON maili döndürür — IMAP'ın
         * bilinen davranışı. Zaten işlediğimiz bir UID gelirse
         * atla, yoksa aynı mail her turda yeniden işlenir.
         */
        if (uid <= c.last_uid) continue;

        sonuc.okunan += 1;
        if (uid > sonuc.sonUid) sonuc.sonUid = uid;

        if (!msg.source) continue;

        const parsed = await simpleParser(msg.source);

        const from = parsed.from?.value?.[0] as Adres | undefined;
        const to = parsed.to as unknown;
        const toList = adresListesi(to);

        const html = typeof parsed.html === "string" ? parsed.html : undefined;
        const text = parsed.text ?? undefined;

        const ekler = (parsed.attachments ?? [])
          // Gövdeye gömülü resimler ek sayılmaz; kullanıcı onları
          // ek listesinde görünce kafası karışıyor.
          .filter((a) => a.contentDisposition !== "inline")
          .map((a) => ({
            filename: a.filename ?? null,
            size: a.size ?? 0,
            contentType: a.contentType ?? "application/octet-stream",
          }));

        const { error } = await sb.rpc("mail_inbox_save", {
          p: {
            subject: kisalt(parsed.subject, 500) ?? null,
            preview: onizleme(text, html),
            from_email: from?.address ?? null,
            from_name: from?.name ?? null,
            to_email: toList?.[0] ?? null,
            to_list: toList ?? null,
            cc_list: adresListesi(parsed.cc as unknown) ?? null,
            body_html: kisalt(html, HTML_LIMIT) ?? null,
            body_text: kisalt(text, TEXT_LIMIT) ?? null,
            has_attachments: ekler.length > 0,
            attachments: ekler,
            message_id: parsed.messageId ?? null,
            in_reply_to: parsed.inReplyTo ?? null,
            imap_uid: String(uid),
            folder: c.folder || "INBOX",
            received_at: (parsed.date ?? new Date()).toISOString(),
          },
        });

        if (error) {
          // Tek mail yüzünden tüm tur çökmesin
          log("IMAP kayıt hatası:", uid, error.message);
        } else {
          sonuc.yeni += 1;
        }

        islenen += 1;
        if (islenen >= TUR_LIMIT) {
          log(`IMAP tur limiti (${TUR_LIMIT}) doldu — kalanı sonraki turda`);
          break;
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    sonuc.hata = err instanceof Error ? err.message : String(err);
    log("IMAP hatası:", sonuc.hata);
    try { client.close(); } catch { /* zaten kapalı */ }
  }

  // Sonucu her durumda bildir: hata da panelde görünsün
  try {
    await sb.rpc("mail_imap_report", {
      p_last_uid: sonuc.sonUid,
      p_error: sonuc.hata,
    });
  } catch { /* rapor yazılamadıysa bir sonraki tur dener */ }

  if (sonuc.yeni > 0) log(`IMAP: ${sonuc.yeni} yeni mail (uid ${sonuc.sonUid})`);
  return sonuc;
}
