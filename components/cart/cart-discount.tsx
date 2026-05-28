"use client"

interface Props {
  discount: number
  label?: string
}

const formatPrice = (price: number) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  }).format(price)

export function CartDiscount({ discount, label }: Props) {
  if (!discount || discount <= 0) return null

  return (
    <div className="flex justify-between text-sm items-center">
      <span className="text-white/50 flex items-center gap-2">
        Descuento
        {label && (
          <span className="text-9px text-emerald-400/80 tracking-wide">
            {label}
          </span>
        )}
      </span>

      <span className="text-emerald-400 font-medium tracking-wide">
        -{formatPrice(discount)}
      </span>
    </div>
  )
}