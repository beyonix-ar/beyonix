// Muestra de color de la variante (bicolor = dos mitades).
export function LabelSwatch({ colorHex, colorHexSecondary }: { colorHex: string | null; colorHexSecondary: string | null }) {
  if (!colorHex) return <span aria-hidden="true" className="size-4 shrink-0" />
  const background = colorHexSecondary ? `linear-gradient(135deg, ${colorHex} 50%, ${colorHexSecondary} 50%)` : colorHex
  return <span aria-hidden="true" className="size-4 shrink-0 rounded-full shadow-[0_0_0_1px_rgba(148,163,184,0.55)]" style={{ background }} />
}
