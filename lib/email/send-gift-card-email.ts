import { formatARS } from "@/lib/customer-credit"

interface SendGiftCardEmailPayload {
  to?: string | null
  recipientName: string
  senderName: string
  amount: number
  message?: string
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export async function sendGiftCardEmail({
  to,
  recipientName,
  senderName,
  amount,
  message,
}: SendGiftCardEmailPayload) {
  const apiKey = process.env.RESEND_API_KEY
  const from =
    process.env.STORE_EMAIL_FROM ||
    process.env.RESEND_FROM_EMAIL ||
    process.env.RESEND_EMAIL_FROM ||
    process.env.EMAIL_FROM
  const configuredSiteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.VERCEL_URL ||
    "https://beyonix.netlify.app"
  const siteUrl = configuredSiteUrl.startsWith("http")
    ? configuredSiteUrl
    : `https://${configuredSiteUrl}`

  if (!apiKey || !from || !to) {
    console.log("Email de Gift Card omitido: Resend no configurado o destinatario faltante")
    return
  }

  const safeRecipientName = escapeHtml(recipientName || "Cliente BEYONIX")
  const safeSenderName = escapeHtml(senderName || "BEYONIX")
  const safeMessage = escapeHtml(message?.trim() || "Tenés una Gift Card disponible para usar en tu próxima compra.")
  const amountText = formatARS(amount)
  const accountUrl = `${siteUrl.replace(/\/$/, "")}/cuenta?tab=saldo`

  const html = `
    <div style="margin:0;padding:0;background:#02060c;font-family:Arial,Helvetica,sans-serif;color:#ffffff;">
      <div style="max-width:640px;margin:0 auto;padding:32px 18px;">
        <div style="border:1px solid #17334d;border-radius:22px;background:#07111d;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,.35);">
          <p style="margin:0 0 18px;font-size:22px;font-weight:900;letter-spacing:.04em;">BEYONIX</p>
          <div style="overflow:hidden;border:1px solid rgba(125,205,255,.32);border-radius:18px;background:linear-gradient(135deg,#0c3156,#06101b 58%,#02060c);padding:22px;">
            <p style="margin:0;color:#8fd3ff;font-size:11px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;">Gift Card</p>
            <p style="margin:14px 0 4px;font-size:38px;line-height:1;font-weight:900;">${amountText}</p>
            <p style="margin:0;color:#b8c4d1;font-size:13px;">Crédito disponible para comprar en BEYONIX</p>
            <div style="height:1px;background:linear-gradient(90deg,transparent,#75cfff,transparent);margin:22px 0;"></div>
            <p style="margin:0 0 8px;color:#dce8f5;font-size:15px;font-weight:700;">Hola, ${safeRecipientName}</p>
            <p style="margin:0;color:#ffffff;font-size:17px;line-height:1.55;">${safeMessage}</p>
            <p style="margin:18px 0 0;color:#91a4b8;font-size:13px;">Enviada por ${safeSenderName}.</p>
          </div>
          <p style="margin:22px 0;color:#b8c4d1;font-size:14px;line-height:1.55;">
            La Gift Card ya fue acreditada en tu cuenta. Podés usarla como saldo disponible al finalizar una compra.
          </p>
          <a href="${accountUrl}" style="display:inline-block;border-radius:12px;background:#113a5f;color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;padding:13px 18px;">
            Ver mi Gift Card
          </a>
        </div>
      </div>
    </div>
  `

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: `Recibiste una Gift Card BEYONIX de ${senderName || "BEYONIX"}`,
        html,
      }),
    })

    if (!response.ok) {
      console.log("No se pudo enviar email de Gift Card", await response.text())
    }
  } catch (error) {
    console.log("Error enviando email de Gift Card", error)
  }
}
