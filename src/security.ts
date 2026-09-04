import { timingSafeEqual, createHash } from "node:crypto";

/**
 * API ANAHTARI DOĞRULAMA
 *
 * `a === b` KULLANILMAZ. Dize karşılaştırması ilk farklı
 * karakterde durur; saldırgan yanıt süresini ölçerek anahtarı
 * karakter karakter çözebilir (zamanlama saldırısı).
 *
 * `timingSafeEqual` her zaman aynı sürede çalışır. Uzunluk farkı
 * da bilgi sızdırdığı için önce iki taraf da SHA-256 ile sabit
 * uzunluğa indirilir.
 */
export function safeKeyMatch(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * IP BAŞINA HIZ SINIRI
 *
 * Anahtar sızsa bile sınırsız mail gönderilemesin. Bellekte
 * tutulur: tek konteyner için yeterli, kalıcılık gerekmiyor.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  check(key: string): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    const rec = this.hits.get(key);

    if (!rec || now > rec.reset) {
      this.hits.set(key, { count: 1, reset: now + this.windowMs });
      // Süresi geçmiş kayıtlar birikmesin
      if (this.hits.size > 10_000) {
        for (const [k, v] of this.hits) if (now > v.reset) this.hits.delete(k);
      }
      return { ok: true, retryAfter: 0 };
    }

    rec.count += 1;
    if (rec.count > this.max) {
      return { ok: false, retryAfter: Math.ceil((rec.reset - now) / 1000) };
    }
    return { ok: true, retryAfter: 0 };
  }
}

/** Basit e-posta biçim kontrolü */
export function validEmail(v: unknown): v is string {
  return typeof v === "string"
    && v.length <= 254
    && /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v);
}

/**
 * İstek gövdesini sınırlı boyutla oku.
 *
 * Sınırsız okuma bellek tüketme saldırısına açıktır: tek bir
 * istek gigabaytlarca veri gönderip servisi düşürebilir.
 */
export function readBody(
  req: NodeJS.ReadableStream,
  limitBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("payload_too_large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
