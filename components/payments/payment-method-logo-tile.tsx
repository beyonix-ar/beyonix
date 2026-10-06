import type { PublicPaymentMethodLogo } from "@/lib/payments/payment-method-logos"
import { cn } from "@/lib/utils"

const TILE_SIZES = {
  sm: "h-7 w-11 p-1",
  md: "h-9 w-14 p-1.5",
} as const

/**
 * Tarjeta uniforme para cualquier logo (SVG o PNG): mismo tamaño, fondo
 * blanco y padding fijos; la imagen se ajusta con object-contain, nunca se
 * deforma ni se recorta.
 */
export function PaymentMethodLogoTile({
  name,
  imageUrl,
  size = "sm",
  className,
}: {
  name: string
  imageUrl: string
  size?: keyof typeof TILE_SIZES
  className?: string
}) {
  return (
    <span
      data-payment-logo-tile
      title={name}
      className={cn(
        "beyonix-payment-logo-tile inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-black/10 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12)]",
        TILE_SIZES[size],
        className,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- SVG/PNG públicos de Storage, tamaño fijo */}
      <img src={imageUrl} alt={name} loading="lazy" decoding="async" className="block size-full object-contain" />
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
