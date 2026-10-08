"use client"

import { useState } from "react"

import type { PublicPaymentMethodLogo } from "@/lib/payments/payment-method-logos"
import { cn } from "@/lib/utils"

const TILE_SIZES = {
  sm: "h-7 w-11 p-1",
  md: "h-9 w-14 p-1.5",
} as const

/** Sin imagen usable: misma altura y superficie, ancho según el nombre. */
const FALLBACK_SIZES = {
  sm: "h-7 min-w-11 max-w-36 px-1.5 text-10px",
  md: "h-9 min-w-14 max-w-40 px-2 text-11px",
} as const

/**
 * Tarjeta uniforme para cualquier logo (SVG, PNG, WEBP, JPG, de cualquier
 * tamaño o proporción): caja exterior, fondo blanco y padding fijos; la
 * imagen se ajusta con object-contain, nunca se deforma ni se recorta, así
 * que el archivo original no cambia el alto del bloque. Si la imagen falta o
 * no carga, muestra el nombre en la misma superficie (nunca imagen rota).
 */
export function PaymentMethodLogoTile({
  name,
  imageUrl,
  size = "sm",
  nameFallback = true,
  className,
}: {
  name: string
  imageUrl: string
  size?: keyof typeof TILE_SIZES
  /** false cuando el nombre ya se muestra al lado: si la imagen falla, no se duplica. */
  nameFallback?: boolean
  className?: string
}) {
  // Se guarda la URL que falló (no un booleano): si cambia la imagen, se reintenta.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = imageUrl.trim().length > 0 && failedUrl !== imageUrl
  if (!showImage && !nameFallback) return null

  return (
    <span
      data-payment-logo-tile
      data-logo-fallback={showImage ? undefined : "true"}
      title={name}
      className={cn(
        "beyonix-payment-logo-tile inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-black/10 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12)]",
        showImage ? TILE_SIZES[size] : FALLBACK_SIZES[size],
        className,
      )}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- logos públicos de Storage en caja fija
        <img
          src={imageUrl}
          alt={name}
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(imageUrl)}
          className="block size-full object-contain"
        />
      ) : (
        <span className="truncate font-bold leading-none text-[#14283d]">{name}</span>
      )}
    </span>
  )
}

/** Fila compacta de logos ("Medios de pago"). No renderiza nada sin logos. */
export function PaymentMethodLogoStrip({
  logos,
  label = "Medios de pago",
  max = 8,
  className,
}: {
  logos: ReadonlyArray<PublicPaymentMethodLogo>
  label?: string
  max?: number
  className?: string
}) {
  if (logos.length === 0) return null
  const shown = logos.slice(0, max)
  const hidden = logos.length - shown.length

  return (
    <div data-payment-logo-strip className={cn("flex flex-wrap items-center gap-x-2 gap-y-1.5", className)}>
      <span className="beyonix-modal-muted text-11px font-semibold uppercase tracking-[0.12em] text-white/55">{label}</span>
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={label}>
        {shown.map((logo) => (
          <li key={logo.key} className="flex">
            <PaymentMethodLogoTile name={logo.name} imageUrl={logo.imageUrl} />
          </li>
        ))}
        {hidden > 0 ? (
          <li className="beyonix-modal-muted text-11px font-semibold text-white/55">+{hidden}</li>
        ) : null}
      </ul>
    </div>
  )
}
