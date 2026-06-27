interface SendOrderStatusEmailPayload {
  to?: string | null
  subject: string
  html: string
}

export async function sendOrderStatusEmail({
  to,
  subject,
  html,
}: SendOrderStatusEmailPayload) {
  const apiKey = process.env.RESEND_API_KEY
  const from =
    process.env.STORE_EMAIL_FROM ||
    process.env.RESEND_FROM_EMAIL ||
    process.env.RESEND_EMAIL_FROM ||
    process.env.EMAIL_FROM

  if (!apiKey || !from || !to) {
    console.log("Email omitido: Resend no configurado o destinatario faltante")
    return
  }

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
        subject,
        html,
      }),
    })

    if (!response.ok) {
      console.log("No se pudo enviar email de pedido", await response.text())
    }
  } catch (error) {
    console.log("Error enviando email de pedido", error)
  }
}
