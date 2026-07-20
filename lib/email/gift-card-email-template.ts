import { formatARS } from "@/lib/customer-credit"

export interface GiftCardEmailTemplateData {
  recipientName: string
  senderName: string
  amount: number
  message?: string | null
  displayCode: string
  expiresAt?: string | null
  actionUrl: string
  siteUrl: string
  recipientHasAccount: boolean
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatDate(value?: string | null) {
  if (!value) return null
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

export function buildGiftCardEmailTemplate(data: GiftCardEmailTemplateData) {
  const recipientName = data.recipientName.trim() || "Cliente BEYONIX"
  const senderName = data.senderName.trim() || "BEYONIX"
  const message = data.message?.trim() || "Espero que disfrutes mucho este regalo."
  const amount = formatARS(data.amount)
  const expiresAt = formatDate(data.expiresAt)
  const subject = `${senderName} te regaló ${amount} en BEYONIX`
  const safe = {
    recipientName: escapeHtml(recipientName),
    senderName: escapeHtml(senderName),
    message: escapeHtml(message).replace(/\r?\n/g, "<br>"),
    amount: escapeHtml(amount),
    displayCode: escapeHtml(data.displayCode),
    actionUrl: escapeHtml(data.actionUrl),
    siteUrl: escapeHtml(data.siteUrl),
    expiresAt: expiresAt ? escapeHtml(expiresAt) : null,
  }
  const accountCopy = data.recipientHasAccount
    ? "El saldo ya está acreditado en tu cuenta y listo para usar."
    : "Creá o iniciá sesión con este mismo email para acreditar el regalo."

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#050a10;color:#fff;font-family:Montserrat,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${safe.senderName} te regaló una Gift Card BEYONIX de ${safe.amount}.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#050a10"><tr><td align="center" style="padding:32px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:660px">
<tr><td style="padding:0 8px 22px;text-align:center"><div style="font-size:30px;font-weight:900;letter-spacing:8px">BEYONIX</div><div style="margin-top:7px;color:#8ccfff;font-size:10px;font-weight:800;letter-spacing:3px;text-transform:uppercase">Tecnología que va con vos</div></td></tr>
<tr><td style="border:1px solid #315879;border-radius:24px;background:#091725;padding:9px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0">
<tr><td style="border-radius:18px;background:#112A43;background-image:linear-gradient(135deg,#244f72 0%,#112A43 52%,#091725 100%);padding:30px 28px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font-size:16px;font-weight:900;letter-spacing:3px">BEYONIX</td><td align="right"><span style="display:inline-block;border:1px solid #5e88a8;border-radius:999px;padding:7px 12px;color:#b9e4ff;font-size:9px;font-weight:800;letter-spacing:2px">GIFT CARD</span></td></tr>
<tr><td colspan="2" style="padding-top:44px"><div style="color:#9db7ca;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase">Un regalo para vos</div><div style="margin-top:8px;font-size:44px;font-weight:900;line-height:1">${safe.amount}</div></td></tr>
<tr><td colspan="2" style="padding-top:26px"><div style="height:1px;background:#527691"></div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding-top:15px;color:#9db7ca;font-size:10px;letter-spacing:1.5px;text-transform:uppercase">Para<br><strong style="color:#fff;font-size:14px;letter-spacing:0;text-transform:none">${safe.recipientName}</strong></td><td align="right" style="padding-top:15px;color:#9db7ca;font-size:10px;letter-spacing:1.5px;text-transform:uppercase">Código completo<br><strong style="color:#fff;font-size:13px;letter-spacing:1px">${safe.displayCode}</strong></td></tr></table></td></tr></table>
</td></tr>
<tr><td style="padding:32px 28px 8px;text-align:center"><div style="font-size:23px;font-weight:900">¡Tenés un regalo, ${safe.recipientName}!</div><div style="margin-top:10px;color:#bdcad5;font-size:15px;line-height:1.65"><strong style="color:#fff">${safe.senderName}</strong> eligió sorprenderte con una Gift Card BEYONIX.</div></td></tr>
<tr><td style="padding:18px 28px"><div style="border-left:3px solid #71c7ff;border-radius:4px 14px 14px 4px;background:#0d2032;padding:19px 21px"><div style="color:#7fcfff;font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase">Dedicatoria de ${safe.senderName}</div><div style="margin-top:10px;color:#f5f9fc;font-size:17px;font-style:italic;line-height:1.6">“${safe.message}”</div></div></td></tr>
<tr><td style="padding:8px 28px 14px;text-align:center"><div style="color:#b6c4cf;font-size:14px;line-height:1.65">${accountCopy}<br>También podés ingresar el código de la tarjeta durante el checkout.</div><a href="${safe.actionUrl}" style="display:inline-block;margin-top:21px;border-radius:12px;background:#2a6c9f;color:#fff;text-decoration:none;font-size:14px;font-weight:900;padding:15px 28px">Usar mi Gift Card</a></td></tr>
<tr><td style="padding:18px 28px 30px;text-align:center;color:#7f96a8;font-size:11px;line-height:1.7">${safe.expiresAt ? `Válida hasta el ${safe.expiresAt}. ` : ""}Podés usar el saldo en una o varias compras hasta agotarlo.<br><a href="${safe.siteUrl}" style="color:#8fd3ff">Ir a BEYONIX</a></td></tr>
</table></td></tr>
<tr><td style="padding:22px 18px 0;text-align:center;color:#5f7484;font-size:10px;line-height:1.7">Este correo fue enviado porque ${safe.senderName} indicó esta dirección como destinataria.<br>No compartas tu código. © ${new Date().getFullYear()} BEYONIX.</td></tr>
</table></td></tr></table></body></html>`

  const text = [
    "BEYONIX — Gift Card",
    "",
    `¡Tenés un regalo, ${recipientName}!`,
    `${senderName} te regaló ${amount}.`,
    `Dedicatoria: “${message}”`,
    `Código completo: ${data.displayCode}`,
    expiresAt ? `Válida hasta el ${expiresAt}.` : null,
    accountCopy,
    "Podés ingresar el código durante el checkout o usar el siguiente enlace:",
    data.actionUrl,
    "",
    `Visitar BEYONIX: ${data.siteUrl}`,
  ].filter(Boolean).join("\n")

  return { subject, html, text }
}

