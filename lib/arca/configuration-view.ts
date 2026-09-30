import type { ArcaConfigurationStatus } from "./configuration.ts"

/** Etiquetas y bloqueo de emisión para Admin (sin lógica de servidor). */

export type ArcaEnvironmentLabel = "Producción" | "Homologación" | "Configuración inválida"

export function arcaEnvironmentLabel(status: ArcaConfigurationStatus): ArcaEnvironmentLabel {
  if (!status.configured || !status.environment) return "Configuración inválida"
  return status.environment === "production" ? "Producción" : "Homologación"
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(value))
}

export function arcaCertificateLabel(status: ArcaConfigurationStatus) {
  const type =
    status.certificateType === "production"
      ? "Producción"
      : status.certificateType === "homologation"
        ? "Homologación"
        : "No válido"
  return status.certificateExpiresAt ? `${type} · vence ${formatDate(status.certificateExpiresAt)}` : type
}

/**
 * Motivo por el que Admin NO puede emitir, o null si puede. Sin estado
 * confirmado se bloquea (fail-closed); el servidor igual repite el guard.
 */
export function getArcaIssueBlockReason(
  status: ArcaConfigurationStatus | null,
  loadError = "",
): string | null {
  if (!status) {
    return loadError
      ? "No se pudo verificar la configuración de ARCA: la emisión queda bloqueada hasta confirmarla."
      : "Verificando la configuración de ARCA..."
  }
  if (!status.configured) {
    return `Emisión bloqueada por configuración de ARCA inválida. ${status.errors.join(" ")}`.trim()
  }
  return null
}
