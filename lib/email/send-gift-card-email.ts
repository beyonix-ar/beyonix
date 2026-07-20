import "server-only"

import { getPublicSiteUrl, isValidGiftCardEmail } from "@/lib/customer-gift-cards"
import { buildGiftCardEmailTemplate } from "@/lib/email/gift-card-email-template"

type AdminClient = ReturnType<typeof import("@/lib/supabase/admin").createAdminClient>

type GiftCardRow = {
  id: string
  recipient_email: string
  recipient_name: string
  sender_name: string
  initial_amount: number | string
  message: string | null
  display_code: string
  status: "sent" | "claimed" | "expired" | "cancelled"
  expires_at: string | null
  email_status: "pending" | "sending" | "sent" | "error"
}

export type GiftCardDeliveryResult = {
  ok: boolean
  status: "sent" | "pending" | "sending" | "error"
  message: string
  providerId?: string
}

function safeErrorMessage(value: unknown) {
  const message = value instanceof Error ? value.message : String(value ?? "Error desconocido")
  return message.replace(/re_[A-Za-z0-9_-]+/g, "[API_KEY]").slice(0, 500)
}

async function loadCard(admin: AdminClient, giftCardId: string) {
  const { data, error } = await admin
    .from("customer_gift_cards")
    .select("id, recipient_email, recipient_name, sender_name, initial_amount, message, display_code, status, expires_at, email_status")
    .eq("id", giftCardId)
    .maybeSingle()

  if (error || !data) throw new Error(error?.message || "La Gift Card no existe.")
  return data as GiftCardRow
}

function validateCard(card: GiftCardRow) {
  if (!isValidGiftCardEmail(card.recipient_email)) throw new Error("El email de destino no es válido.")
  if (!card.display_code.trim()) throw new Error("La Gift Card no tiene un código válido.")
  if (Number(card.initial_amount) <= 0) throw new Error("La Gift Card no tiene un importe válido.")
  if (!(["sent", "claimed"] as string[]).includes(card.status)) throw new Error("La Gift Card no está disponible para enviar.")
  if (card.expires_at && new Date(card.expires_at).getTime() <= Date.now()) throw new Error("La Gift Card está vencida.")
}

export async function buildGiftCardEmailPreview(admin: AdminClient, giftCardId: string) {
  const card = await loadCard(admin, giftCardId)
  validateCard(card)
  const siteUrl = getPublicSiteUrl()
  return buildGiftCardEmailTemplate({
    recipientName: card.recipient_name,
    senderName: card.sender_name,
    amount: Number(card.initial_amount),
    message: card.message,
    displayCode: card.display_code,
    expiresAt: card.expires_at,
    actionUrl: `${siteUrl}/cuenta`,
    siteUrl,
    recipientHasAccount: card.status === "claimed",
  })
}

export async function deliverGiftCardEmail(admin: AdminClient, giftCardId: string): Promise<GiftCardDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.STORE_EMAIL_FROM

  let card = await loadCard(admin, giftCardId)
  validateCard(card)
  if (card.email_status === "sent") {
    return { ok: true, status: "sent", message: "El correo ya había sido enviado." }
  }

  const { data: reservation, error: reservationError } = await admin.rpc("reserve_customer_gift_card_email_delivery", { p_gift_card_id: giftCardId })
  if (reservationError) throw new Error(reservationError.message || "No se pudo reservar el envío.")
  const reserved = Array.isArray(reservation) ? reservation[0] : reservation
  if (!reserved?.reserved) {
    const currentStatus = String(reserved?.current_status || card.email_status)
    return {
      ok: currentStatus === "sent",
      status: currentStatus === "sent" ? "sent" : "sending",
      message: currentStatus === "sent" ? "El correo ya había sido enviado." : "Ya hay un envío en curso.",
    }
  }

  const actionUrl = `${getPublicSiteUrl()}/cuenta`
  try {
    if (!apiKey || !from) throw new Error("Resend no está configurado en el servidor.")
    card = await loadCard(admin, giftCardId)
    const template = buildGiftCardEmailTemplate({
      recipientName: card.recipient_name,
      senderName: card.sender_name,
      amount: Number(card.initial_amount),
      message: card.message,
      displayCode: card.display_code,
      expiresAt: card.expires_at,
      actionUrl,
      siteUrl: getPublicSiteUrl(),
      recipientHasAccount: card.status === "claimed",
    })
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `gift-card/${giftCardId}`,
      },
      body: JSON.stringify({ from, to: [card.recipient_email], subject: template.subject, html: template.html, text: template.text }),
    })
    const responseData = (await response.json().catch(() => ({}))) as { id?: string; message?: string; name?: string }
    if (!response.ok || !responseData.id) throw new Error(responseData.message || responseData.name || `Resend respondió ${response.status}.`)

    const { error: completionError } = await admin.rpc("complete_customer_gift_card_email_delivery", {
      p_gift_card_id: giftCardId,
      p_success: true,
      p_provider_id: responseData.id,
      p_error: null,
    })
    if (completionError) {
      console.error("Gift Card email tracking update failed", { giftCardId, providerId: responseData.id, error: completionError.message })
    }
    return { ok: true, status: "sent", message: "Correo enviado correctamente.", providerId: responseData.id }
  } catch (error) {
    const safeMessage = safeErrorMessage(error)
    console.error("Gift Card email delivery failed", { giftCardId, error: safeMessage })
    await admin.rpc("complete_customer_gift_card_email_delivery", {
      p_gift_card_id: giftCardId,
      p_success: false,
      p_provider_id: null,
      p_error: safeMessage,
    })
    return { ok: false, status: "error", message: safeMessage }
  }
}
