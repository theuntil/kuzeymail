import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

/**
 * MAİL EKLERİ — R2'DEN İNDİR
 *
 * Panel ek dosyaları R2'ye yüklüyor ve kuyruğa yalnızca ANAHTAR
 * yazıyor. Servis gönderim anında indirip mesaja ekliyor.
 *
 * ┌─ NEDEN BASE64 DEĞİL ⚠️ ──────────────────────────────────┐
 * │ 20 MB'lık bir dosyayı base64 olarak `mail_queue` satırına │
 * │ gömmek satırı ~27 MB yapardı. Kuyruk sorguları her turda  │
 * │ o satırı okuyor; liste görünümleri kullanılamaz hâle       │
 * │ gelirdi. Anahtar 60 bayt.                                   │
 * └────────────────────────────────────────────────────────────┘
 *
 * ┌─ İNDİRME BAŞARISIZ OLURSA ⚠️ ────────────────────────────┐
 * │ Mail EKSİZ GİTMEZ. Ek beklenen bir mailin eki olmadan     │
 * │ gitmesi, hiç gitmemesinden kötü: alıcı "boş mail attın"   │
 * │ der, gönderen fark etmez. Hata fırlatılır, iş kuyrukta    │
 * │ kalır ve yeniden denenir.                                  │
 * └────────────────────────────────────────────────────────────┘
 */

export interface EkTanim {
  key: string;
  name?: string;
  size?: number;
  type?: string;
}

export interface HazirEk {
  filename: string;
  content: Buffer;
  contentType: string;
}

/** Sağlayıcıların çoğu 25 MB'ı reddediyor; güvenli tavan */
const TOPLAM_LIMIT = 24 * 1024 * 1024;

let client: S3Client | null = null;

function r2(): S3Client {
  if (client) return client;

  const endpoint = process.env.S3_ENDPOINT;
  const key = process.env.S3_ACCESS_KEY_ID;
  const secret = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !key || !secret) {
    throw new Error(
      "R2 ayarları eksik (S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY). " +
      "Mail ekleri indirilemez.",
    );
  }

  client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint,
    credentials: { accessKeyId: key, secretAccessKey: secret },
    forcePathStyle: true,
  });
  return client;
}

async function govdeyiOku(body: unknown): Promise<Buffer> {
  const parcalar: Buffer[] = [];
  // Node akışı: `for await` ile parça parça okunuyor
  for await (const p of body as AsyncIterable<Uint8Array>) {
    parcalar.push(Buffer.from(p));
  }
  return Buffer.concat(parcalar);
}

export async function ekleriIndir(
  ham: unknown,
  log: (...a: unknown[]) => void,
): Promise<HazirEk[]> {
  if (!Array.isArray(ham) || ham.length === 0) return [];

  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET tanımlı değil — mail ekleri indirilemez");

  const cikti: HazirEk[] = [];
  let toplam = 0;

  for (const e of ham as EkTanim[]) {
    const anahtar = String(e?.key ?? "");

    /*
     * ⚠ ANAHTAR DOĞRULAMASI.
     * Kuyruktan gelen veriye güvenilmez: yalnızca `mail/`
     * önekindeki dosyalar indirilir. Yoksa bucket'taki herhangi
     * bir dosya (haber medyası, avatar) mail eki olarak
     * gönderilebilirdi.
     */
    if (!/^mail\/[A-Za-z0-9._/-]{3,200}$/.test(anahtar) || anahtar.includes("..")) {
      throw new Error(`Geçersiz ek anahtarı: ${anahtar.slice(0, 60)}`);
    }

    const res = await r2().send(new GetObjectCommand({ Bucket: bucket, Key: anahtar }));
    const içerik = await govdeyiOku(res.Body);

    toplam += içerik.length;
    if (toplam > TOPLAM_LIMIT) {
      throw new Error(
        `Ek toplamı ${Math.round(toplam / 1048576)} MB — sağlayıcı sınırı aşıldı`,
      );
    }

    cikti.push({
      filename: e.name ?? anahtar.split("/").pop() ?? "dosya",
      content: içerik,
      contentType: e.type ?? res.ContentType ?? "application/octet-stream",
    });
  }

  log(`ekler indirildi: ${cikti.length} dosya, ${Math.round(toplam / 1024)} KB`);
  return cikti;
}
