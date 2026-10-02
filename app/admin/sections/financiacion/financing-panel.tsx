"use client"

import { useState, type ReactNode } from "react"
import Link from "next/link"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Clock,
  Check,
  CreditCard,
  Hand,
  History,
  Minus,
  Pencil,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Wallet,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  INSTALLMENT_COUNTS,
  MAX_INTEREST_FREE_INSTALLMENTS,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "@/lib/products/installments"
import {
  resolveInstallmentsFinancing,
  type MercadoPagoCostChangeEvent,
  type MercadoPagoCostModality,
  type MercadoPagoCostObservation,
  type MercadoPagoCostSource,
  type MercadoPagoCostsMode,
} from "@/lib/mercadopago/observed-costs"
import {
  DEFAULT_INTEREST_FREE_POLICY,
  getConfirmedInterestFreeMax,
} from "@/lib/mercadopago/interest-free-policy"
import { REFERENCE_PROBE_MAX_AMOUNT } from "@/lib/mercadopago/interest-free-reference"
import { getInterestFreeMessage } from "@/lib/pricing/interest-free-communication"
import {
  DEFAULT_FINANCED_PRICE_POLICY,
  FINANCED_PRICE_POLICIES,
  FINANCED_PRICE_POLICY_LABELS,
  SAME_AS_CASH_WARNING,
  type FinancedPricePolicy,
} from "@/lib/pricing/financed-price-policy"
import { formatArgentinaDateTime } from "@/lib/commercial-events/argentina-time"
import { ADMIN_ROUTES } from "@/lib/admin/admin-routes"
import {
  DEFAULT_INSTALLMENTS_FINANCING_SETTINGS,
  type FinancingPolicyEventSummary,
  type MercadoPagoCostsOverview,
  type StoredInstallmentsFinancingSettings,
} from "@/lib/site-settings"
import { AdminSecondaryButton, AdminTextInput } from "../../components/admin-controls"
import {
  ConfigChip,
  ConfigDisclosure,
  ConfigSaveActions,
  ConfigSection,
  ConfigStat,
  ConfigStats,
  formatARS,
  formatDateTime,
  formatPercent,
  parsePercentage,
  sanitizePercentInput,
  withInputSymbol,
  type ConfigFeedback,
  type ConfigTone,
} from "../modificaciones/config-ui"

export const MANUAL_MODE_WARNING =
  "Estás usando valores manuales. BEYONIX dejará de usar automáticamente los costos observados hasta volver al modo Automático."

/** Eventos de historial visibles antes de "Ver historial completo". */
const HISTORY_PREVIEW = 5

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  credit_card: "tarjeta de crédito",
  debit_card: "débito",
  account_money: "dinero en cuenta",
  prepaid_card: "prepaga",
}

const MODALITY_LABELS: Record<MercadoPagoCostModality, string> = {
  credit_1: "Crédito 1 pago",
  credit_2: "2 cuotas",
  credit_3: "3 cuotas",
  credit_6: "6 cuotas",
  debit_1: "Débito",
  account_money_1: "Dinero en cuenta",
}

const BRAND_LABELS: Record<string, string> = { visa: "Visa", master: "Mastercard" }

interface Draft {
  mode: MercadoPagoCostsMode
  base: string
  iva: string
  surcharge: Record<InstallmentCount, string>
  interestFreeEnabled: boolean
  financedPricePolicy: FinancedPricePolicy
}

function toDraft(overview: MercadoPagoCostsOverview | null): Draft {
  const manual = overview?.manual ?? DEFAULT_INSTALLMENTS_FINANCING_SETTINGS
  const policy = overview?.interestFreePolicy ?? DEFAULT_INTEREST_FREE_POLICY
  return {
    financedPricePolicy: overview?.financedPricePolicy ?? DEFAULT_FINANCED_PRICE_POLICY,
    mode: overview?.mode ?? "manual",
    base: String(manual.baseProcessingPercent),
    iva: String(manual.ivaPercent),
    surcharge: {
      2: String(manual.surchargePercentByCount[2]),
      3: String(manual.surchargePercentByCount[3]),
      6: String(manual.surchargePercentByCount[6]),
    },
    interestFreeEnabled: policy.enabled,
  }
}

function toStored(draft: Draft): StoredInstallmentsFinancingSettings {
  return {
    mode: draft.mode,
    baseProcessingPercent: parsePercentage(draft.base),
    ivaPercent: parsePercentage(draft.iva),
    surchargePercentByCount: {
      2: parsePercentage(draft.surcharge[2]),
      3: parsePercentage(draft.surcharge[3]),
      6: parsePercentage(draft.surcharge[6]),
    },
    interestFreePolicy: { enabled: draft.interestFreeEnabled },
  }
}

function sameStored(a: StoredInstallmentsFinancingSettings, b: StoredInstallmentsFinancingSettings) {
  return (
    a.mode === b.mode &&
    a.baseProcessingPercent === b.baseProcessingPercent &&
    a.ivaPercent === b.ivaPercent &&
    INSTALLMENT_COUNTS.every((count) => a.surchargePercentByCount[count] === b.surchargePercentByCount[count]) &&
    a.interestFreePolicy.enabled === b.interestFreePolicy.enabled
  )
}

function withoutIva(percentWithIva: number, ivaPercent: number) {
  return Math.round((percentWithIva / (1 + ivaPercent / 100)) * 100) / 100
}

function describeObservation(observation: MercadoPagoCostObservation) {
  const medium = observation.paymentTypeId
    ? PAYMENT_TYPE_LABELS[observation.paymentTypeId] ?? observation.paymentTypeId
    : null
  return [
    formatDateTime(observation.observedAt),
    medium && (observation.installments > 1 ? `${medium} en ${observation.installments} cuotas` : medium),
    `pedido BX-${1000 + observation.orderId}`,
  ]
    .filter(Boolean)
    .join(" · ")
}

function brandsText(brands: string[] | undefined) {
  return brands?.length ? brands.map((brand) => BRAND_LABELS[brand] ?? brand).join(" · ") : null
}

const MODE_DESCRIPTIONS: Record<MercadoPagoCostsMode, string> = {
  automatic: "Usa lo que Mercado Pago cobró en pagos reales; donde todavía no hay datos, el respaldo manual.",
  manual: "Fuerza los valores cargados a mano. El cálculo deja de seguir los costos observados.",
}

/** Segmento del selector Automático / Manual (radio accesible). */
function ModeOption({
  mode,
  selected,
  disabled,
  onSelect,
}: {
  mode: MercadoPagoCostsMode
  selected: boolean
  disabled: boolean
  onSelect: (mode: MercadoPagoCostsMode) => void
}) {
  const automatic = mode === "automatic"
  const Icon = automatic ? Activity : Hand

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={() => onSelect(mode)}
      title={MODE_DESCRIPTIONS[mode]}
      data-mode={mode}
      data-selected={selected ? "true" : "false"}
      className="admin-config-mode-option flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none"
    >
      <Icon className="admin-config-mode-icon size-3.5 shrink-0" />
      <span className="text-12px font-black text-white">{automatic ? "Automático" : "Manual"}</span>
      <span className="admin-config-mode-hint hidden text-11px font-bold min-[420px]:inline">{automatic ? "Recomendado" : "Emergencia"}</span>
    </button>
  )
}

function SourcePill({ source, mode }: { source: MercadoPagoCostSource; mode: MercadoPagoCostsMode }) {
  const observed = source === "observed"
  return (
    <ConfigChip tone={observed ? "success" : mode === "manual" ? "warning" : "neutral"}>
      {observed ? "Observado" : mode === "manual" ? "Manual" : "Respaldo"}
    </ConfigChip>
  )
}

/** Celda chica "etiqueta / valor" de una fila de costos. */
function CostCell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="text-11px font-bold text-white/62">{label}</p>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-black text-white">{children}</div>
    </div>
  )
}

const BREAKDOWN_PERCENT_FORMAT = new Intl.NumberFormat("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const formatBreakdownPercent = (value: number) => `${BREAKDOWN_PERCENT_FORMAT.format(value)}%`

/**
 * Desglose SÓLO informativo de lo que cobra Mercado Pago por una modalidad,
 * con los mismos valores en uso de la fila: costo base + financiación =
 * total sin IVA, y ese total con IVA. No interviene en ningún cálculo de
 * precios (que siguen en lib/products/installments.ts).
 */
function CostBreakdown({ base, financing, ivaPercent }: { base: number; financing: number | null; ivaPercent: number }) {
  const totalWithoutIva = Math.round((base + (financing ?? 0)) * 100) / 100
  const totalWithIva = totalWithoutIva * (1 + ivaPercent / 100)
  const items: Array<{ key: string; label: string; value: number; operator?: string; strong?: boolean }> = [
    { key: "base", label: "Costo base MP", value: base },
    ...(financing === null
      ? []
      : [
          { key: "financing", label: "Financiación", value: financing, operator: "+" },
          { key: "total", label: "Total MP sin IVA", value: totalWithoutIva, operator: "=" },
        ]),
    { key: "total-iva", label: "Total final con IVA", value: totalWithIva, strong: true },
  ]
  return (
    <dl data-cost-breakdown className="admin-config-breakdown col-span-full flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-2.5 py-1.5 text-12px">
      {items.map((item) => (
        <div key={item.key} data-breakdown={item.key} className="flex items-baseline gap-1">
          {item.operator ? (
            <span aria-hidden="true" className="font-black text-white/62">
              {item.operator}
            </span>
          ) : null}
          <dt className="font-semibold text-white/72">{item.label}</dt>
          <dd className={cn("font-black text-white", item.strong && "admin-config-breakdown-total")}>
            {formatBreakdownPercent(item.value)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

interface CostRowProps {
  label: string
  /** `null` = 1 pago / IVA (sin disponibilidad propia); `false` = no disponible hoy en Mercado Pago. */
  available: boolean | null
  /** Nombre de lo que es `effectiveValue` (p. ej. "Financiación"): nunca se confunde con el total. */
  valueLabel: string
  /** Desglose base + financiación + IVA (1 pago y cuotas; el IVA no lleva). */
  breakdown?: { base: number; financing: number | null; ivaPercent: number }
  effectiveValue: number
  source: MercadoPagoCostSource
  mode: MercadoPagoCostsMode
  observation: MercadoPagoCostObservation | null
  observationUnavailableText: string
  ivaPercent: number
  showInput: boolean
  manualValue: string
  manualLabel: string
  disabled: boolean
  onManualChange: (value: string) => void
}

/**
 * Una modalidad: en uso + fuente y observado siempre a la vista; el valor
 * manual sólo cuando se edita (Manual, o "Editar respaldo manual"). Una
 * cuota no disponible hoy conserva su costo guardado e histórico.
 */
function CostRow({
  label,
  available,
  valueLabel,
  breakdown,
  effectiveValue,
  source,
  mode,
  observation,
  observationUnavailableText,
  ivaPercent,
  showInput,
  manualValue,
  manualLabel,
  disabled,
  onManualChange,
}: CostRowProps) {
  const observedValue = observation ? withoutIva(observation.percentWithIva, ivaPercent) : null
  return (
    <li
      data-cost-row={label}
      data-available={available === false ? "false" : "true"}
      className={cn(
        "grid grid-cols-2 items-center gap-x-3 gap-y-1.5 py-2",
        showInput
          ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)]"
          : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.3fr)]",
      )}
    >
      <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5 sm:col-span-1">
        <span className="text-sm font-black text-white">{label}</span>
        {available === false ? (
          <ConfigChip tone="neutral" data-availability="unavailable">
            No disponible hoy
          </ConfigChip>
        ) : null}
      </div>
      <CostCell label={available === false ? `${valueLabel} (guardado)` : `${valueLabel} en uso`}>
        <span data-cost-effective>{formatPercent(effectiveValue)}</span>
        <SourcePill source={source} mode={mode} />
      </CostCell>
      <CostCell label={breakdown ? `${valueLabel} observado` : "Observado"}>
        {observation && observedValue !== null ? (
          <span title={`${formatPercent(observation.percentWithIva, 3)} con IVA · ${describeObservation(observation)}`}>
            {formatPercent(observedValue)}
            <span className="ml-1.5 whitespace-nowrap text-12px font-semibold text-white/62">{formatDateTime(observation.observedAt)}</span>
          </span>
        ) : (
          <span className="text-12px font-semibold text-white/62" title={observationUnavailableText}>
            —
          </span>
        )}
      </CostCell>
      {showInput ? (
        <div className="col-span-2 min-w-0 sm:col-span-1">
          <p className="text-11px font-bold text-white/62">{manualLabel}</p>
          <AdminTextInput
            title={`${label} (${manualLabel.toLowerCase()})`}
            ariaLabel={`${label}: valor ${manualLabel.toLowerCase()}`}
            value={withInputSymbol(manualValue, "%")}
            placeholder="% 0"
            inputMode="decimal"
            className="mt-0.5 text-center text-sm font-bold"
            disabled={disabled}
            onChange={(value) => onManualChange(sanitizePercentInput(value))}
          />
        </div>
      ) : null}
      {breakdown ? <CostBreakdown {...breakdown} /> : null}
    </li>
  )
}

function historyStatusText(event: MercadoPagoCostChangeEvent) {
  return event.previousPercentWithIva === null ? "Primer costo observado" : "Aplicado automáticamente"
}

interface FinancingPanelProps {
  overview: MercadoPagoCostsOverview | null
  disabled: boolean
  saving: boolean
  checkingReference: boolean
  feedback: ConfigFeedback | null
  /** `policy` sólo cuando cambió la política de precio financiado (se guarda aparte). */
  onSave: (value: StoredInstallmentsFinancingSettings, policy: FinancedPricePolicy | null) => void
  onCheckReference: () => void
}

const POLICY_HELP: Record<FinancedPricePolicy, string> = {
  cover_costs: "El precio en cuotas incluye los costos de financiación.",
  same_as_cash: "BEYONIX absorbe el costo de financiación.",
}

/**
 * Política GLOBAL de precio financiado. Cambio manual inmediato (compras
 * futuras; lo histórico no cambia). Mientras un evento de Admin → Eventos la
 * controla no se edita acá: se ve el evento, cuándo termina y a qué vuelve.
 */
function FinancedPolicyControl({
  value,
  disabled,
  controllingEvent,
  upcomingEvent,
  onChange,
}: {
  value: FinancedPricePolicy
  disabled: boolean
  controllingEvent: FinancingPolicyEventSummary | null
  upcomingEvent: FinancingPolicyEventSummary | null
  onChange: (policy: FinancedPricePolicy) => void
}) {
  return (
    <div className="mt-3" data-financed-policy={value}>
      <p className="text-11px font-bold text-white/62">Política de precio financiado</p>
      {controllingEvent ? (
        <div className="admin-config-status mt-1 space-y-0.5 px-2.5 py-2 text-12px leading-4 text-white/80" data-tone="info" data-financed-policy-event>
          <p className="text-sm font-black text-white">{FINANCED_PRICE_POLICY_LABELS[value]}</p>
          <p>
            <Clock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />
            Controlado temporalmente por el evento <strong className="text-white">“{controllingEvent.name}”</strong>
            {controllingEvent.status === "error" ? " (con error al restaurar)" : ""}
          </p>
          <p>Finaliza: {formatArgentinaDateTime(controllingEvent.endsAt)}</p>
          {controllingEvent.previousPolicy ? (
            <p data-financed-policy-restore>Volverá a: {FINANCED_PRICE_POLICY_LABELS[controllingEvent.previousPolicy]}</p>
          ) : null}
          <Link href={ADMIN_ROUTES.eventos} className="admin-config-link inline-flex items-center gap-1 font-black underline-offset-2 hover:underline">
            Ver evento
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      ) : (
        <div role="radiogroup" aria-label="Política de precio financiado" className="mt-1 grid gap-1.5 sm:grid-cols-2">
          {FINANCED_PRICE_POLICIES.map((policy) => (
            <button
              key={policy}
              type="button"
              role="radio"
              aria-checked={value === policy}
              disabled={disabled}
              onClick={() => onChange(policy)}
              data-policy={policy}
              data-selected={value === policy ? "true" : "false"}
              className="admin-config-policy-option flex min-w-0 flex-col items-start gap-0.5 px-2.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="text-12px font-black text-white">{FINANCED_PRICE_POLICY_LABELS[policy]}</span>
              <span className="text-11px font-semibold leading-4 text-white/72">{POLICY_HELP[policy]}</span>
            </button>
          ))}
        </div>
      )}
      {value === "same_as_cash" ? (
        <p className="admin-config-status mt-1.5 flex items-start gap-1.5 px-2.5 py-1.5 text-12px font-semibold leading-4 text-white/85" data-tone="warning" data-same-as-cash-warning role="status">
          <AlertTriangle className="admin-config-warning-icon mt-px size-3.5 shrink-0" />
          {SAME_AS_CASH_WARNING}
        </p>
      ) : null}
      {!controllingEvent && upcomingEvent ? (
        <p className="mt-1.5 text-12px leading-4 text-white/72" data-financed-policy-upcoming>
          Programado: “{upcomingEvent.name}” · {formatArgentinaDateTime(upcomingEvent.startsAt)} → {formatArgentinaDateTime(upcomingEvent.endsAt)}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Admin → Financiación en 4 bloques: Estado, Cuotas disponibles, Costos e
 * Historial. "Lo importante se ve, lo técnico se despliega": detalle de
 * sincronización, reglas y referencias van colapsados.
 */
export function FinancingPanel({
  overview,
  disabled,
  saving,
  checkingReference,
  feedback,
  onSave,
  onCheckReference,
}: FinancingPanelProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(overview))
  const [editingBackup, setEditingBackup] = useState(false)
  const [showAllHistory, setShowAllHistory] = useState(false)
  const stored = toStored(draft)
  const savedPolicy = overview?.financedPricePolicy ?? DEFAULT_FINANCED_PRICE_POLICY
  const controllingEvent = overview?.financingPolicyEvent ?? null
  // Mientras un evento la controla, la política no forma parte del guardado.
  const policyDirty = !controllingEvent && draft.financedPricePolicy !== savedPolicy
  const dirty = !sameStored(stored, toStored(toDraft(overview))) || policyDirty
  const observed = overview?.observed ?? null
  const syncStatus = overview?.interestFreeStatus ?? null
  const reference = syncStatus?.reference ?? null
  const syncFailed = Boolean(syncStatus?.lastError)
  const enabled = draft.interestFreeEnabled
  // Máximo sin interés que confirma Mercado Pago (BEYONIX nunca pasa de 6).
  const confirmedMax = getConfirmedInterestFreeMax(reference)
  const publicMessage = getInterestFreeMessage(overview?.interestFreeOffer)
  const resolved = resolveInstallmentsFinancing(stored, draft.mode, observed)
  const effective: InstallmentsFinancingConfig = resolved.effective
  const inputsDisabled = disabled || saving
  const manual = draft.mode === "manual"
  // En Automático los costos se leen; el respaldo manual se edita a pedido.
  const showInputs = manual || editingBackup
  const manualLabel = manual ? "Manual" : "Respaldo"
  const history = observed?.history ?? []
  const visibleHistory = showAllHistory ? history : history.slice(0, HISTORY_PREVIEW)

  const setSurcharge = (count: InstallmentCount, value: string) =>
    setDraft((current) => ({ ...current, surcharge: { ...current.surcharge, [count]: value } }))

  const mercadoPagoStatus: { tone: ConfigTone; value: string; state: string } = !enabled
    ? { tone: "neutral", value: "En pausa", state: "paused" }
    : syncFailed
      ? { tone: "danger", value: "No se pudo verificar", state: "failed" }
      : reference
        ? { tone: "success", value: "Sincronizado", state: "synced" }
        : { tone: "info", value: "Sin comprobar", state: "unchecked" }

  const costRows: Array<{ key: "base" | InstallmentCount; label: string }> = [
    { key: "base", label: "1 pago" },
    { key: 2, label: "2 cuotas" },
    { key: 3, label: "3 cuotas" },
    { key: 6, label: "6 cuotas" },
  ]

  return (
    <div className="admin-financing-panel space-y-3" data-financing-mode={draft.mode}>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5" data-financing-toolbar>
        {feedback ? (
          <p
            role={feedback.tone === "danger" ? "alert" : "status"}
            className="admin-config-feedback mr-auto text-12px font-semibold"
            data-tone={feedback.tone}
          >
            {feedback.text}
          </p>
        ) : null}
        <ConfigSaveActions
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          onSave={() => onSave(stored, policyDirty ? draft.financedPricePolicy : null)}
        />
      </div>

      <div className="admin-config-cluster grid items-start gap-3 lg:grid-cols-2">
        {/* ── A. Estado ── */}
        <ConfigSection
          icon={<Activity className="size-3.5" />}
          title="Estado"
          className={cn(manual && "admin-financing-manual")}
          data-financing-block="estado"
          actions={
            <AdminSecondaryButton
              size="sm"
              disabled={disabled || checkingReference}
              onClick={onCheckReference}
              data-check-reference
            >
              <RefreshCw className={cn("size-3.5", checkingReference && "animate-spin")} />
              {checkingReference ? "Comprobando…" : "Comprobar ahora"}
            </AdminSecondaryButton>
          }
        >
          <ConfigStats className="admin-config-subpanel grid-cols-2 p-3">
            <ConfigStat
              label="Mercado Pago"
              tone={mercadoPagoStatus.tone}
              value={mercadoPagoStatus.value}
              data-mercadopago-status={mercadoPagoStatus.state}
            />
            <ConfigStat
              label="Última sincronización"
              value={reference ? formatDateTime(reference.checkedAt) : "Sin comprobar"}
              data-reference-checked={reference ? "true" : "false"}
            />
            <ConfigStat
              label="Modo"
              tone={manual ? "warning" : "success"}
              value={manual ? "Manual" : "Automático"}
              detail={draft.mode !== overview?.mode ? "Sin guardar" : undefined}
              data-mode-state={draft.mode}
            />
            <ConfigStat
              label="Cuotas sin interés"
              tone={enabled ? "success" : "neutral"}
              value={enabled ? "Activas" : "Inactivas"}
              data-interest-free-state={enabled ? "on" : "off"}
            />
          </ConfigStats>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div role="radiogroup" aria-label="Origen de los costos de Mercado Pago" className="admin-config-segmented flex w-full sm:inline-flex sm:w-auto">
              {(["automatic", "manual"] as const).map((mode) => (
                <ModeOption
                  key={mode}
                  mode={mode}
                  selected={draft.mode === mode}
                  disabled={inputsDisabled}
                  onSelect={(next) => setDraft((current) => ({ ...current, mode: next }))}
                />
              ))}
            </div>
            <AdminSecondaryButton
              size="sm"
              aria-label={enabled ? "Desactivar cuotas sin interés" : "Activar cuotas sin interés"}
              aria-pressed={enabled}
              disabled={inputsDisabled}
              onClick={() => setDraft((current) => ({ ...current, interestFreeEnabled: !current.interestFreeEnabled }))}
              data-interest-free-toggle
              className={cn("admin-toggle min-w-0 justify-start px-2.5", enabled && "admin-toggle-on")}
            >
              {enabled ? (
                <ToggleRight aria-hidden="true" className="admin-toggle-icon size-4" />
              ) : (
                <ToggleLeft aria-hidden="true" className="admin-toggle-icon size-4" />
              )}
              <span className="text-xs text-white">{enabled ? "Cuotas activadas" : "Cuotas desactivadas"}</span>
            </AdminSecondaryButton>
          </div>

          <FinancedPolicyControl
            value={controllingEvent ? savedPolicy : draft.financedPricePolicy}
            disabled={inputsDisabled}
            controllingEvent={controllingEvent}
            upcomingEvent={overview?.upcomingFinancingPolicyEvent ?? null}
            onChange={(financedPricePolicy) => setDraft((current) => ({ ...current, financedPricePolicy }))}
          />

          {manual ? (
            <p className="admin-config-status mt-2.5 flex items-start gap-1.5 px-2.5 py-1.5 text-12px font-semibold leading-4 text-white/85" data-tone="warning" data-manual-warning role="status">
              <AlertTriangle className="admin-config-warning-icon mt-px size-3.5 shrink-0" />
              {MANUAL_MODE_WARNING}
            </p>
          ) : null}

          {!enabled ? (
            <p className="mt-2.5 text-12px leading-4 text-white/72" data-interest-free-off role="status">
              Cuotas desactivadas: sólo Mercado Pago en 1 pago a precio contado, sin comunicar &quot;sin interés&quot;.
            </p>
          ) : syncFailed ? (
            <p className="admin-config-feedback mt-2.5 text-12px font-semibold leading-4" data-tone="danger" data-mercadopago-sync role="status">
              Sin promociones públicas hasta volver a verificar; el checkout sigue con 1 pago.
            </p>
          ) : null}

          {syncStatus && (reference || syncStatus.lastFailure) ? (
            <ConfigDisclosure summary="Ver detalle" className="mt-2" data-sync-detail>
              {syncFailed ? (
                <p data-sync-error>
                  Motivo: {syncStatus.lastError}
                  {syncStatus.lastAttemptAt ? ` Falló: ${formatDateTime(syncStatus.lastAttemptAt)}.` : ""}
                </p>
              ) : null}
              <p data-last-success>
                {reference ? `Última consulta exitosa: ${formatDateTime(reference.checkedAt)}.` : "Sin consultas exitosas todavía."}
              </p>
              {syncStatus.lastFailure && !syncFailed ? (
                <p data-last-failure>
                  Último fallo: {formatDateTime(syncStatus.lastFailure.at)} · {syncStatus.lastFailure.message}
                </p>
              ) : null}
              <p>Se sincroniza solo cada ~15 min; &quot;Comprobar ahora&quot; consulta en el momento.</p>
            </ConfigDisclosure>
          ) : null}
        </ConfigSection>

        {/* ── B. Cuotas disponibles ── */}
        <ConfigSection icon={<CreditCard className="size-3.5" />} title="Cuotas disponibles" data-financing-block="cuotas">
          <div className="admin-config-subpanel p-3" data-confirmed-max={confirmedMax && enabled ? String(confirmedMax.count) : "none"}>
            {!enabled ? (
              <>
                <p className="text-lg font-black leading-tight text-white">Cuotas desactivadas</p>
                <p className="mt-0.5 text-sm text-white/72">Sólo 1 pago a precio contado.</p>
              </>
            ) : !reference ? (
              <>
                <p className="text-lg font-black leading-tight text-white">Sin comprobar</p>
                <p className="mt-0.5 text-sm text-white/72">Usá “Comprobar ahora” para consultar a Mercado Pago.</p>
              </>
            ) : confirmedMax ? (
              <>
                <p className="flex flex-wrap items-center gap-2 text-lg font-black leading-tight text-white">
                  Hasta {confirmedMax.count} cuotas sin interés
                  {syncFailed ? <ConfigChip tone="warning">Último dato verificado</ConfigChip> : null}
                </p>
                <p className="mt-0.5 text-sm text-white/80">
                  Desde aprox. <strong className="text-white">{formatARS(confirmedMax.minimumAmount)}</strong>
                  {brandsText(confirmedMax.brands) ? (
                    <>
                      {" · "}
                      <span data-confirmed-brands>{brandsText(confirmedMax.brands)}</span>
                    </>
                  ) : null}
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-black leading-tight text-white">Sin cuotas sin interés</p>
                <p className="mt-0.5 text-sm text-white/72">
                  Mercado Pago no las confirma (probado hasta {formatARS(REFERENCE_PROBE_MAX_AMOUNT)}): sólo 1 pago.
                </p>
              </>
            )}
          </div>

          <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1" aria-label="Disponibilidad por cuota" data-availability-list>
            {INSTALLMENT_COUNTS.map((count) => {
              const minimum = reference?.minimumAmountByCount[count] ?? null
              const available = reference !== null && minimum !== null
              return (
                <li
                  key={count}
                  data-availability-row={count}
                  data-availability={reference ? (available ? "available" : "unavailable") : "unchecked"}
                  title={available ? `Desde aprox. ${formatARS(minimum)}${brandsText(reference?.brandsByCount[count]) ? ` · ${brandsText(reference?.brandsByCount[count])}` : ""}` : undefined}
                  className="flex items-center gap-1 text-12px font-semibold text-white/80"
                >
                  {available ? (
                    <Check aria-hidden="true" className="admin-config-check size-3.5" />
                  ) : (
                    <Minus aria-hidden="true" className="size-3.5 text-white/62" />
                  )}
                  {count} cuotas
                  <span className="sr-only">{available ? "disponible" : reference ? "no disponible" : "sin comprobar"}</span>
                </li>
              )
            })}
          </ul>

          <div className="admin-config-preview mt-3 px-3 py-2" data-public-message>
            <p className="text-11px font-bold text-white/62">Texto publicado</p>
            {publicMessage ? (
              <p className="mt-0.5 text-sm font-black text-white">“{publicMessage.text}”</p>
            ) : (
              <p className="mt-0.5 text-12px font-semibold text-white/72">Ninguno: no hay promoción verificada para comunicar.</p>
            )}
          </div>

          <ConfigDisclosure summary="Cómo funciona" className="mt-2.5" data-financing-rules>
            <ul className="list-disc space-y-0.5 pl-4">
              <li><strong className="text-white">1 pago</strong> = precio contado (crédito, débito o dinero en cuenta).</li>
              <li><strong className="text-white">Cuotas</strong> = un precio financiado con el costo del máximo confirmado; elegir menos cuotas no lo baja.</li>
              <li>Se ofrece exactamente lo que confirma Mercado Pago, desde el mismo monto. Máximo {MAX_INTEREST_FREE_INSTALLMENTS} (9, 12 o 18 nunca).</li>
              <li>Manda el <strong className="text-white">total final</strong>: productos + envío pagado − descuentos − saldo.</li>
              <li>Los montos &quot;desde&quot; se estiman con consultas reales: Mercado Pago no expone el umbral.</li>
            </ul>
          </ConfigDisclosure>
        </ConfigSection>
      </div>

      <div className="admin-config-cluster grid items-start gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* ── C. Costos ── */}
        <ConfigSection
          icon={<Wallet className="size-3.5" />}
          title="Costos"
          summary={
            <span className="text-12px font-semibold text-white/62">
              Comisiones sin IVA; el total final incluye IVA
            </span>
          }
          className={cn(manual && "admin-financing-manual")}
          data-financing-block="costos"
          actions={
            manual ? null : (
              <AdminSecondaryButton
                size="sm"
                aria-expanded={editingBackup}
                onClick={() => setEditingBackup((current) => !current)}
                data-edit-backup
              >
                <Pencil className="size-3.5" />
                {editingBackup ? "Ocultar respaldo manual" : "Editar respaldo manual"}
              </AdminSecondaryButton>
            )
          }
        >
          <ul className="admin-config-list" data-cost-list>
            {costRows.map((row) => {
              const isBase = row.key === "base"
              const count = row.key as InstallmentCount
              const source = isBase ? resolved.sources.base : resolved.sources.surchargeByCount[count]
              return (
                <CostRow
                  key={row.key}
                  label={row.label}
                  available={isBase || reference === null ? null : reference.minimumAmountByCount[count] !== null}
                  valueLabel={isBase ? "Costo base MP" : "Financiación"}
                  breakdown={{
                    base: effective.baseProcessingPercent,
                    financing: isBase ? null : effective.surchargePercentByCount[count],
                    ivaPercent: effective.ivaPercent,
                  }}
                  effectiveValue={isBase ? effective.baseProcessingPercent : effective.surchargePercentByCount[count]}
                  source={source}
                  mode={draft.mode}
                  observation={isBase ? observed?.base ?? null : observed?.surchargeByCount[count] ?? null}
                  observationUnavailableText={
                    isBase ? "Sin pagos con crédito en 1 pago todavía" : "Sin pagos con crédito en estas cuotas sin interés todavía"
                  }
                  ivaPercent={effective.ivaPercent}
                  showInput={showInputs}
                  manualValue={isBase ? draft.base : draft.surcharge[count]}
                  manualLabel={manualLabel}
                  disabled={inputsDisabled}
                  onManualChange={(value) =>
                    isBase ? setDraft((current) => ({ ...current, base: value })) : setSurcharge(count, value)
                  }
                />
              )
            })}
            <CostRow
              label="IVA"
              available={null}
              valueLabel="IVA"
              effectiveValue={effective.ivaPercent}
              source="manual"
              mode="manual"
              observation={null}
              observationUnavailableText="Mercado Pago no lo informa por separado: siempre se usa este valor."
              ivaPercent={effective.ivaPercent}
              showInput={showInputs}
              manualValue={draft.iva}
              manualLabel={manualLabel}
              disabled={inputsDisabled}
              onManualChange={(value) => setDraft((current) => ({ ...current, iva: value }))}
            />
          </ul>
          {observed ? (
            <p data-observed-references className="mt-1.5 text-12px leading-4 text-white/62">
              Referencia (no se usa para calcular):{" "}
              {(["debit_card", "account_money"] as const)
                .map((type) => {
                  const observation = observed.singlePaymentByType[type]
                  const label = PAYMENT_TYPE_LABELS[type]
                  const name = `${label[0].toUpperCase()}${label.slice(1)}`
                  return observation
                    ? `${name} ${formatPercent(withoutIva(observation.percentWithIva, effective.ivaPercent))}`
                    : `${name} sin datos`
                })
                .join(" · ")}
            </p>
          ) : (
            <p className="mt-1.5 text-12px leading-4 text-white/62">No se pudieron leer los pagos observados: se usa el respaldo.</p>
          )}
        </ConfigSection>

        {/* ── D. Historial ── */}
        <ConfigSection icon={<History className="size-3.5" />} title="Historial" data-financing-block="historial">
          {history.length > 0 ? (
            <>
              <ul className="admin-config-list" data-cost-history>
                {visibleHistory.map((event) => (
                  <li key={`${event.modality}-${event.orderId}-${event.observedAt}`} className="py-1.5">
                    <p className="flex items-baseline justify-between gap-2">
                      <span className="text-sm font-black text-white">{MODALITY_LABELS[event.modality]}</span>
                      <span className="shrink-0 text-12px text-white/62">{formatDateTime(event.observedAt)}</span>
                    </p>
                    <p className="text-sm font-bold text-white/85">
                      {event.previousPercentWithIva === null
                        ? formatPercent(withoutIva(event.percentWithIva, effective.ivaPercent))
                        : `${formatPercent(withoutIva(event.previousPercentWithIva, effective.ivaPercent))} → ${formatPercent(withoutIva(event.percentWithIva, effective.ivaPercent))}`}
                    </p>
                    <p className="text-12px leading-4 text-white/62">
                      Detectado en pago real · {historyStatusText(event)} · BX-{1000 + event.orderId}
                    </p>
                  </li>
                ))}
              </ul>
              {history.length > HISTORY_PREVIEW ? (
                <button
                  type="button"
                  className="admin-config-link mt-1.5 text-12px font-black underline-offset-2 hover:underline"
                  aria-expanded={showAllHistory}
                  onClick={() => setShowAllHistory((current) => !current)}
                  data-history-toggle
                >
                  {showAllHistory ? "Ver menos" : `Ver historial completo (${history.length})`}
                </button>
              ) : null}
            </>
          ) : (
            <p className="text-12px text-white/62">
              {observed ? "Todavía no hay cambios detectados en pagos reales." : "No se pudieron leer los pagos observados."}
            </p>
          )}
        </ConfigSection>
      </div>
    </div>
  )
}
