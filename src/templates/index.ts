import { env } from "../env.js";
/**
 * MAİL ŞABLONLARI
 *
 * Değerler HTML'e girmeden önce kaçırılır: kullanıcı adı gövdeye
 * yazılıyor, kaçırılmazsa HTML enjeksiyonu olur.
 */
export interface Payload { [k: string]: unknown }
export interface Rendered { subject: string; html: string; text: string }

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/*
 * ⚠ VARSAYILAN AÇIK TEMA.
 *
 * Şablon eskiden koyu temaya sabitti. Posta kutularının çoğu
 * beyaz zeminli açılıyor ve koyu bir kart orada yamalı
 * duruyordu. Ayrıca Gmail ve Outlook koyu modda renkleri
 * kendileri çeviriyor; iki kat çevrim okunmaz sonuç veriyordu.
 *
 * Artık taban açık; koyu mod `prefers-color-scheme` ile
 * destekleyen istemcilerde devreye giriyor.
 */
const C = {
  bg: "#F4F5F7", card: "#FFFFFF", text: "#0F1214",
  muted: "#6B7580", accent: "#B3221E", border: "#E3E6E9",
  codeBg: "#F7F8F9",
};

/* Koyu mod karşılıkları */
const D = {
  bg: "#0B0D0F", card: "#141719", text: "#F2F4F5",
  muted: "#9AA3A8", border: "#23282B", codeBg: "#0B0D0F",
};

/*
 * Koyu mod kuralları.
 *
 * Satır içi stil `!important` olmadan ezilemiyor; e-posta
 * istemcilerinde sınıf tabanlı geçiş bu yüzden zorunlu.
 */
const DARK_CSS = `
@media (prefers-color-scheme: dark) {
  .kb-body  { background:${D.bg} !important; }
  .kb-card  { background:${D.card} !important; border-color:${D.border} !important; }
  .kb-text  { color:${D.text} !important; }
  .kb-muted { color:${D.muted} !important; }
  .kb-code  { background:${D.codeBg} !important; border-color:${D.border} !important; }
  .kb-logo  { filter: invert(1) brightness(1.9); }
}`;

/*
 * BAŞLIK
 *
 * ⚠ METİN DEĞİL LOGO.
 * Başlıkta "Kuzeybatı Haber" yazıyordu; panelden logo
 * değiştirilince mailler eski markayla kalıyordu. Artık
 * panelin açık tema logosu basılıyor.
 *
 * Logo tanımlı değilse hiçbir şey basılmıyor — yazıya geri
 * dönmek, düzeltmeye çalıştığımız soruna geri dönmek olurdu.
 */
function header(): string {
  if (!env.logoUrl) return "";
  return `  <tr><td style="padding:0 0 24px;text-align:center;">
    <img class="kb-logo" src="${esc(env.logoUrl)}" alt="" height="30"
         style="height:30px;width:auto;display:inline-block;border:0;">
  </td></tr>
`;
}

/**
 * ORTAK DÜZEN
 *
 * Tek sütun, tek kart, altta ince bir alt bilgi. Bütün
 * şablonlar bunu kullanıyor ki mailler arasında biçim farkı
 * olmasın.
 */
function layout(title: string, body: string, footer?: string): string {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(title)}</title>
<style>${DARK_CSS}</style></head>
<body class="kb-body" style="margin:0;padding:30px 12px;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;">
${header()}  <tr><td class="kb-card" style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:34px 30px;">
    ${body}
  </td></tr>
  <tr><td class="kb-muted" style="padding:18px 8px 0;text-align:center;color:${C.muted};font-size:11.5px;line-height:1.6;">
    ${footer ?? ""}
  </td></tr>
</table></body></html>`;
}

/**
 * KOD KUTUSU
 *
 * Rakamlar arası boşluk bilinçli: 6 haneli kod tek blok hâlinde
 * okunması zor. Seçilebilir olması da önemli — kullanıcı kopyalayıp
 * yapıştırabilmeli.
 */
function codeBox(code: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;">
    <tr><td class="kb-code" style="background:${C.codeBg};border:1px solid ${C.border};border-radius:14px;padding:18px 28px;">
      <span class="kb-text" style="font-size:34px;font-weight:800;letter-spacing:.32em;color:${C.text};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(code)}</span>
    </td></tr></table>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px auto;">
    <tr><td style="background:${C.accent};border-radius:12px;">
      <a href="${esc(href)}" style="display:inline-block;padding:13px 26px;color:#fff;font-size:15px;font-weight:700;text-decoration:none;">${esc(label)}</a>
    </td></tr></table>`;
}

const h = (t: string) =>
  `<h1 class="kb-text" style="margin:0 0 10px;font-size:21px;font-weight:800;color:${C.text};letter-spacing:-.02em;text-align:center;">${esc(t)}</h1>`;
const p = (t: string) =>
  `<p class="kb-muted" style="margin:0 0 12px;font-size:14.5px;line-height:1.6;color:${C.muted};text-align:center;">${esc(t)}</p>`;

type Renderer = (payload: Payload, siteUrl: string) => Rendered;

const templates: Record<string, Renderer> = {
  /** E-posta doğrulama — 6 haneli kod + bağlantı */
  verify_email: (pl, site) => {
    const name = String(pl.name ?? "");
    const code = String(pl.code ?? "");
    const link = `${site}/eposta-dogrula?token=${encodeURIComponent(String(pl.token ?? ""))}`;
    return {
      subject: `${code} — e-posta doğrulama kodun`,
      html: layout("E-posta doğrulama",
        h(name ? `Merhaba ${name}` : "Merhaba") +
        p("E-posta adresini doğrulamak için aşağıdaki kodu siteye gir.") +
        codeBox(code) +
        p("Kod 15 dakika geçerli.") +
        `<hr style="border:0;border-top:1px solid ${C.border};margin:22px 0;">` +
        p("Dilersen doğrudan bu bağlantıya da tıklayabilirsin:") +
        button(link, "E-postamı doğrula") +
        p("Doğrulama zorunlu değil; yapmasan da yorum yapabilir, haber kaydedebilirsin."),
        "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin."),
      text: `${name ? `Merhaba ${name},` : "Merhaba,"}\n\nDoğrulama kodun: ${code}\n\nKod 15 dakika geçerli.\nBağlantı: ${link}\n\nDoğrulama zorunlu değildir.`,
    };
  },

  /** Şifre sıfırlama — yalnızca kod, bağlantı YOK */
  password_reset: (pl) => {
    const code = String(pl.code ?? "");
    return {
      subject: `${code} — şifre değiştirme kodun`,
      html: layout("Şifre değiştirme",
        h("Şifre değiştirme") +
        p("Aşağıdaki kodu siteye gir.") +
        codeBox(code) +
        p("Kod 10 dakika geçerli."),
        "Bu isteği sen yapmadıysan şifreni değiştirme."),
      text: `Şifre değiştirme kodun: ${code}\n\nKod 10 dakika geçerli.\nBu isteği sen yapmadıysan şifreni değiştirme.`,
    };
  },

  welcome: (pl, site) => {
    const name = String(pl.name ?? "");
    return {
      subject: "Kuzeybatı Haber'e hoş geldin",
      html: layout("Hoş geldin",
        h(name ? `Hoş geldin ${name}` : "Hoş geldin") +
        p("Hesabın hazır. Artık haberleri kaydedebilir, yorum yapabilir ve şehrine göre hava durumu, namaz vakti ve nöbetçi eczane bilgisine ulaşabilirsin.") +
        button(site, "Siteye git")),
      text: `${name ? `Hoş geldin ${name},` : "Hoş geldin,"}\n\nHesabın hazır. ${site}`,
    };
  },

  newsletter_confirm: (pl, site) => {
    const link = `${site}/bulten-onay?token=${encodeURIComponent(String(pl.token ?? ""))}`;
    return {
      subject: "Bülten aboneliğini onayla",
      html: layout("Bülten onayı",
        h("Son bir adım") +
        p("Günün öne çıkan haberlerini almak için aboneliğini onayla.") +
        button(link, "Aboneliği onayla"),
        "Bu isteği sen yapmadıysan bu e-postayı yok sayabilirsin."),
      text: `Bülten aboneliğini onayla: ${link}`,
    };
  },

  article_status: (pl, site) => {
    const title = String(pl.title ?? "");
    const ok = Boolean(pl.approved);
    return {
      subject: ok ? "Haberin yayında" : "Haberin yayınlanmadı",
      html: layout("Haber durumu",
        h(ok ? "Haberin yayında" : "Haberin yayınlanmadı") +
        p(title) +
        p(ok ? "Gönderdiğin haber onaylandı ve yayına alındı."
             : "Gönderdiğin haber bu hâliyle yayınlanmadı. Düzenleyip yeniden gönderebilirsin.") +
        button(`${site}/hesabim?tab=articles`, "Haberlerime git"),
        "Bu bildirimi editör olduğun için aldın."),
      text: `${ok ? "Haberin yayında" : "Haberin yayınlanmadı"}: ${title}\n${site}/hesabim?tab=articles`,
    };
  },
};

export function render(template: string, payload: Payload, siteUrl: string): Rendered | null {
  return templates[template]?.(payload, siteUrl) ?? null;
}

export const knownTemplates = Object.keys(templates);

/* ══════════════════════════════════════════════════════════════
   VERİTABANINDAN GELEN ŞABLON

   Panelden düzenlenen metin buraya gelir ve yukarıdaki
   `layout()` sarmalayıcısıyla birleştirilir. Böylece marka
   görünümü tek yerde kalır: logo ya da renk değişince beş
   şablonu tek tek düzenlemek gerekmez.

   ┌─ KAÇIRMA ⚠️ ─────────────────────────────────────────────┐
   │ Şablon metni PANELDEN geliyor ama değişken değerleri      │
   │ KULLANICIDAN geliyor (ad, haber başlığı). Değerler HTML'e │
   │ girmeden kaçırılır; kaçırılmazsa kullanıcı adına script   │
   │ yazan biri okurun posta kutusunda kod çalıştırabilir.     │
   └────────────────────────────────────────────────────────────┘
   ══════════════════════════════════════════════════════════════ */

export interface DbTemplate {
  konu: string;
  govde: string;
  buton: string | null;
  onizleme: string | null;
}

export interface Brand {
  name: string | null;
  logo_url: string | null;
  site_url: string | null;
  footer_note: string | null;
  signature_html: string | null;
}

/** {{degisken}} yerine değeri koyar — DEĞER KAÇIRILIR */
function doldur(metin: string, degerler: Payload): string {
  return metin.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k: string) =>
    esc(degerler[k] ?? ""));
}

/** Ham metni (kaçırılmış) HTML paragraflarına çevirir */
function paragraflar(metin: string): string {
  return metin
    .split(/\n{2,}/)
    .map((blok) => blok.trim())
    .filter(Boolean)
    .map((blok) => {
      /*
       * Tek başına duran 4-8 haneli sayı KOD KUTUSU olarak
       * çizilir. Doğrulama kodunu düz paragrafta göstermek
       * okunurluğu düşürüyordu ve kullanıcı seçip kopyalarken
       * yanındaki metni de alıyordu.
       */
      if (/^\d{4,8}$/.test(blok)) return codeBox(blok);
      return `<p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:${C.muted};">${
        blok.replace(/\n/g, "<br>")
      }</p>`;
    })
    .join("");
}

export function renderDb(
  tpl: DbTemplate,
  payload: Payload,
  brand: Brand,
): Rendered {
  /*
   * `raw` = PANELDEN ELLE YAZILAN MAİL.
   *
   * Gövde şablonda değil, payload'da. Şablonun gövdesi
   * ("İçerik panelde yazılır.") yalnızca yer tutucu; onu
   * kullanırsak kullanıcının yazdığı metin kaybolur.
   */
  if (typeof payload.body === "string" && payload.body.trim()) {
    const htmlMi = payload.is_html === true;
    tpl = {
      ...tpl,
      konu: typeof payload.subject === "string" ? payload.subject : tpl.konu,
      govde: payload.body,
      // Elle yazılan mailde düğme yok
      buton: null,
    };
    if (htmlMi) {
      // HTML modunda gövde OLDUĞU GİBİ geçer, paragrafa bölünmez
      const konu = doldur(tpl.konu, { ...payload, marka: brand.name ?? "", site: brand.site_url ?? "" });
      let govde = payload.body;
      if (typeof payload.heading === "string" && payload.heading.trim()) {
        govde = h(payload.heading) + govde;
      }
      if (brand.signature_html) {
        govde += `<div style="margin-top:20px;font-size:14px;line-height:1.6;color:${C.muted};">${brand.signature_html}</div>`;
      }
      return {
        subject: konu,
        html: layoutMarka(konu, govde, brand, tpl.onizleme),
        text: payload.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      };
    }
  }

  const site = brand.site_url ?? "https://kuzeybatihaber.com.tr";
  const marka = brand.name ?? "Kuzeybatı Haber";

  // `marka` ve `site` her şablonda kullanılabilsin
  const degerler: Payload = { ...payload, marka, site };

  const konu = doldur(tpl.konu, degerler);

  // ⚠ Gövde ÖNCE doldurulur (değerler kaçırılır), SONRA
  // paragrafa çevrilir. Ters sırada yapılırsa kaçırılmış
  // değerdeki &amp; tekrar kaçırılır ve "&amp;amp;" görünür.
  const govdeMetin = doldur(tpl.govde, degerler);
  let govde = paragraflar(govdeMetin);

  if (tpl.buton) {
    const href = String(degerler.link ?? site);
    govde += button(href, doldur(tpl.buton, degerler));
  }
  if (brand.signature_html) {
    govde += `<div style="margin-top:20px;font-size:14px;line-height:1.6;color:${C.muted};">${brand.signature_html}</div>`;
  }

  const baslik = h(konu);
  const html = layoutMarka(konu, baslik + govde, brand, tpl.onizleme);

  // Düz metin sürümü: HTML okumayan istemciler için
  const text = govdeMetin.replace(/\s*\n\s*/g, "\n").trim();

  return { subject: konu, html, text };
}

/** Marka bilgisiyle sarmalayıcı — logo ve alt bilgi panelden gelir */
function layoutMarka(
  title: string, body: string, brand: Brand, onizleme: string | null,
): string {
  const marka = brand.name ?? "Kuzeybatı Haber";
  const bas = brand.logo_url
    ? `<img src="${esc(brand.logo_url)}" alt="${esc(marka)}" height="30" style="height:30px;width:auto;border:0;">`
    : `<span style="font-size:19px;font-weight:800;color:${C.text};letter-spacing:-.02em;">${esc(marka)}</span>`;

  /*
   * ÖN İZLEME SATIRI gizli bir div: posta kutusu listesinde
   * konunun yanında görünür. Gizlenmezse mailin başında
   * tekrar eden bir satır olarak da çıkar.
   */
  const gizli = onizleme
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(onizleme)}</div>`
    : "";

  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:24px 12px;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${gizli}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;">
  <tr><td style="padding:0 0 22px;text-align:center;">${bas}</td></tr>
  <tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:18px;padding:30px 26px;">
    ${body}
  </td></tr>
  <tr><td style="padding:20px 8px 0;text-align:center;color:${C.muted};font-size:12px;line-height:1.6;">
    ${esc(brand.footer_note ?? `Bu e-postayı ${marka} hesabın olduğu için aldın.`)}
  </td></tr>
</table></body></html>`;
}
