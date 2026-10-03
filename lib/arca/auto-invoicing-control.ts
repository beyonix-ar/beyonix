import type { ArcaConfigurationStatus } from "./configuration.ts"

export interface ArcaAutoInvoicingControl {
  enabled: boolean
  cutoff_at: string | null
  updated_at: string
}

export interface ArcaAutoInvoicingView {
  enabled: boolean
  controlEnabled: boolean
  canActivate: boolean
  cutoffAt: string | null
  serverEnabled: boolean
}

export function arcaAutoInvoicingView(
  control: ArcaAutoInvoicingControl,
  configuration: ArcaConfigurationStatus,
): ArcaAutoInvoicingView {
  const canActivate =
    configuration.configured &&
    configuration.environment === "production" &&
    configuration.autoInvoicingEnabled

  return {
    enabled: canActivate && control.enabled && Boolean(control.cutoff_at),
    controlEnabled: control.enabled,
    canActivate,
    cutoffAt: control.cutoff_at,
    serverEnabled: configuration.autoInvoicingEnabled,
  }
}
