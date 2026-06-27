"use client"

import { MessageCircle } from "lucide-react"

export function WhatsAppButton() {
  const phoneNumber = "5491112345678" // Replace with actual WhatsApp number
  const message = encodeURIComponent("¡Hola! Me interesa conocer más sobre sus productos.")
  const whatsappUrl = `https://wa.me/${phoneNumber}?text=${message}`

  return (
    <a
      href={whatsappUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-6 right-6 z-50 size-14 rounded-full bg-whatsapp text-white flex items-center justify-center shadow-lg hover:scale-110 transition-transform"
      aria-label="Contactar por WhatsApp"
    >
      <MessageCircle className="size-6 fill-current" />
    </a>
  )
}
