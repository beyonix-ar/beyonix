/**
 * Clave de caché/consulta de un monto (centavos exactos). Qué cuotas se
 * comunican lo decide `resolveFinancingTier` (lib/pricing/financed-pricing.ts).
 */
export function toInstallmentsAmountKey(amount: number | null | undefined): string | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null
  return String(Math.round(amount * 100) / 100)
}
