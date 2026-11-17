/**
 * Layout HTML de los emails transaccionales de BEYONIX. Replica la identidad
 * de los templates de Supabase Auth (supabase/email-templates/*.html): fondo
 * negro, tarjeta #0A0A0A, ícono y botón #112A43, wordmark BEYONIX y pie
 * "correo automático".
 *
 * Compatibilidad: tablas + estilos inline (el <style> sólo agrega ajustes
 * mobile), colores en hex sólido (Outlook de escritorio ignora rgba) y botón
 * "bulletproof" (celda con color sólido, sin imágenes).
 *
 * Seguridad: todo texto se escapa acá; las URLs sólo se aceptan https (o
 * http://localhost en desarrollo) y también se escapan. Quien llama nunca
 * arma HTML a mano.
 */

const FONT = "'Montserrat',Arial,Helvetica,sans-serif"
const COLORS = {
  page: "#000000",
  card: "#0A0A0A",
  cardBorder: "#1F282F",
  brand: "#112A43",
  brandBorder: "#2E3F4B",
  buttonBorder: "#487192",
  accent: "#8CC8F2",
  panel: "#050505",
  title: "#F8FAFC",
  body: "#ACADAF",
  muted: "#787879",
  divider: "#1E1E1E",
  footer: "#4F5051",
  footerMuted: "#3A3A3B",
} as const

export interface BeyonixEmailDetail {
  label: string
  value: string
}

export interface BeyonixEmailLink {
  label: string
  url: string
}

export interface BeyonixEmailContent {
  /** Título visible y `<title>` del documento. */
  title: string
  /** Texto de vista previa en la bandeja de entrada (oculto en el cuerpo). */
  preheader: string
  /** Code point Unicode del ícono (p. ej. 0x1F4E6 = 📦). */
  icon: number
  greetingName?: string | null
  paragraphs: readonly string[]
  /** Código visible del pedido (BX-…), destacado en un panel propio. */
  orderCode?: string
  details?: readonly BeyonixEmailDetail[]
  /** Botón principal. Se omite si la URL no es segura. */
  action?: BeyonixEmailLink | null
  /** Enlace secundario de texto (p. ej. seguimiento externo). Se omite si la URL no es segura. */
  secondaryLink?: BeyonixEmailLink | null
  /** Nota final dentro de la tarjeta, sobre el separador. */
  note?: string
}

export function escapeEmailHtml(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/** URL apta para un enlace de email: https, o http sólo hacia localhost. `null` en cualquier otro caso. */
export function toSafeEmailUrl(value: string | null | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.username || parsed.password) return null
  const isLocalHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)
  if (parsed.protocol !== "https:" && !isLocalHttp) return null
  return parsed.href
}

const text = (style: string, content: string) =>
  `<p style="margin:0;font-family:${FONT};${style}">${content}</p>`

function renderOrderPanel(orderCode: string | undefined, details: readonly BeyonixEmailDetail[]) {
  if (!orderCode && !details.length) return ""
  const rows = details
    .filter((detail) => detail.value.trim())
    .map((detail) => `
                    <tr>
                      <td align="center" style="padding-top:12px;">
                        ${text(`font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;color:${COLORS.muted};`, escapeEmailHtml(detail.label))}
                        ${text(`font-size:14px;line-height:20px;font-weight:600;color:${COLORS.title};word-break:break-all;`, escapeEmailHtml(detail.value))}
                      </td>
                    </tr>`)
    .join("")
  return `
              <tr>
                <td style="padding-bottom:28px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td align="center" bgcolor="${COLORS.panel}" style="background-color:${COLORS.panel};border:1px solid ${COLORS.cardBorder};border-radius:12px;padding:18px 20px;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                          ${orderCode ? `<tr>
                            <td align="center">
                              ${text(`font-size:11px;line-height:16px;letter-spacing:0.12em;text-transform:uppercase;color:${COLORS.muted};`, "Número de pedido")}
                              ${text(`padding-top:4px;font-size:24px;line-height:30px;font-weight:800;letter-spacing:0.04em;color:${COLORS.accent};`, escapeEmailHtml(orderCode))}
                            </td>
                          </tr>` : ""}${rows}
                        </table>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`
}

function renderButton(action: BeyonixEmailLink | null | undefined) {
  const url = toSafeEmailUrl(action?.url)
  if (!action || !url) return ""
  return `
              <tr>
                <td align="center" style="padding-bottom:18px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                    <tr>
                      <td align="center" bgcolor="${COLORS.brand}" style="border-radius:12px;background-color:${COLORS.brand};border:1px solid ${COLORS.buttonBorder};">
                        <a href="${escapeEmailHtml(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 36px;font-family:${FONT};font-size:15px;font-weight:700;color:${COLORS.title};text-decoration:none;border-radius:12px;">${escapeEmailHtml(action.label)}</a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>`
}

function renderSecondaryLink(link: BeyonixEmailLink | null | undefined) {
  const url = toSafeEmailUrl(link?.url)
  if (!link || !url) return ""
  return `
              <tr>
                <td align="center" style="padding-bottom:18px;">
                  ${text(`font-size:13px;line-height:20px;`, `<a href="${escapeEmailHtml(url)}" target="_blank" rel="noopener" style="color:${COLORS.accent};text-decoration:underline;">${escapeEmailHtml(link.label)}</a>`)}
                </td>
              </tr>`
}

export function renderBeyonixEmail(content: BeyonixEmailContent): string {
  const title = escapeEmailHtml(content.title)
  const name = content.greetingName?.trim()
  const greeting = name ? `Hola ${escapeEmailHtml(name)},` : "Hola,"
  const paragraphs = [greeting, ...content.paragraphs.map((paragraph) => escapeEmailHtml(paragraph))]
    .map((paragraph, index, all) => `
              <tr>
                <td align="center" style="padding-bottom:${index === all.length - 1 ? 24 : 10}px;">
                  ${text(`font-size:14px;line-height:22px;color:${COLORS.body};`, paragraph)}
                </td>
              </tr>`)
    .join("")
  const note = content.note
    ? `
              <tr>
                <td style="border-top:1px solid ${COLORS.divider};padding-top:20px;">
                  ${text(`font-size:12px;line-height:19px;color:${COLORS.muted};text-align:center;`, escapeEmailHtml(content.note))}
                </td>
              </tr>`
    : ""
  const icon = Number.isInteger(content.icon) && content.icon > 0 ? `&#${content.icon};` : "&#9993;"

  return `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="dark" />
<meta name="supported-color-schemes" content="dark" />
<title>${title} — BEYONIX</title>
<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>table, td { border-collapse: collapse; }</style>
<![endif]-->
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  body { margin: 0; padding: 0; width: 100% !important; height: 100% !important; }
  @media screen and (max-width: 480px) {
    .beyonix-email-card { padding: 28px 20px !important; }
    .beyonix-email-wrapper { padding: 24px 12px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.page};opacity:0;">${escapeEmailHtml(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.page}" style="background-color:${COLORS.page};">
  <tr>
    <td align="center" class="beyonix-email-wrapper" style="padding:32px 16px;">
      <!--[if mso]><table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:480px;">
        <tr>
          <td align="center" style="padding-bottom:28px;">
            <span style="font-family:${FONT};font-size:24px;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;color:${COLORS.title};">BEYONIX</span>
          </td>
        </tr>
        <tr>
          <td class="beyonix-email-card" bgcolor="${COLORS.card}" style="background-color:${COLORS.card};border:1px solid ${COLORS.cardBorder};border-radius:16px;padding:36px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="padding-bottom:20px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                    <tr>
                      <td width="52" height="52" bgcolor="${COLORS.brand}" style="width:52px;height:52px;border-radius:14px;background-color:${COLORS.brand};border:1px solid ${COLORS.brandBorder};text-align:center;vertical-align:middle;">
                        <span style="font-size:22px;line-height:52px;">${icon}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-bottom:16px;">
                  <h1 style="margin:0;font-family:${FONT};font-size:20px;line-height:26px;font-weight:800;letter-spacing:0.03em;text-transform:uppercase;color:${COLORS.title};">${title}</h1>
                </td>
              </tr>${paragraphs}${renderOrderPanel(content.orderCode, content.details ?? [])}${renderButton(content.action)}${renderSecondaryLink(content.secondaryLink)}${note}
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-top:24px;">
            ${text(`margin:0 0 4px 0;font-size:11px;line-height:16px;color:${COLORS.footer};`, "&copy; BEYONIX")}
            ${text(`font-size:10px;line-height:15px;color:${COLORS.footerMuted};`, "Este es un correo automático, no es necesario responderlo.")}
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`
}
