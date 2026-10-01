"use client"

import { useState, type ReactNode } from "react"
import {
  Activity,
  AlertTriangle,
  CreditCard,
  Hand,
  History,
  ListChecks,
  Megaphone,
  RefreshCw,
  ToggleLeft,
  ToggleRight,
  Wallet,
} from "lucide-react"

import { cn } from "@/lib/utils"
import {
  INSTALLMENT_COUNTS,
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
import { MAX_INTEREST_FREE_INSTALLMENTS } from "@/lib/products/installments"
import { getInterestFreeMessage } from "@/lib/pricing/interest-free-communication"
import {
  DEFAULT_INSTALLMENTS_FINANCING_SETTINGS,
  type MercadoPagoCostsOverview,
  type StoredInstallmentsFinancingSettings,
} from "@/lib/site-settings"
import { AdminSecondaryButton, AdminTextInput } from "../../components/admin-controls"
import {
  ConfigSaveActions,
  ConfigSection,
  ConfigTile,
  formatARS,
  formatDateTime,
  formatPercent,
  parsePercentage,
  sanitizePercentInput,
  withInputSymbol,
  type ConfigFeedback,
  type ConfigTone,
} from "../modificaciones/config-ui"

const DIFFERENCE_THRESHOLD = 0.01

export const MANUAL_MODE_WARNING =
  "Estás usando valores manuales. BEYONIX dejará de usar automáticamente los costos observados hasta volver al modo Automático."

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

interface Draft {
  mode: MercadoPagoCostsMode
  base: string
  iva: string
  surcharge: Record<InstallmentCount, string>
  interestFreeEnabled: boolean
}

function toDraft(overview: MercadoPagoCostsOverview | null): Draft {
  const manual = overview?.manual ?? DEFAULT_INSTALLMENTS_FINANCING_SETTINGS
  const policy = overview?.interestFreePolicy ?? DEFAULT_INTEREST_FREE_POLICY
  return {
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

function ModeOption({
  mode,
  selected,
  saved,
  disabled,
  onSelect,
}: {
  mode: MercadoPagoCostsMode
  selected: boolean
  saved: boolean
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
      data-mode={mode}
      data-selected={selected ? "true" : "false"}
      className="admin-config-mode-option flex w-full items-start gap-2.5 px-3 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Icon className="admin-config-mode-icon mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-black text-white">{automatic ? "Automático" : "Manual / Emergencia"}</span>
          <span className="admin-config-chip text-10px font-black uppercase tracking-widest" data-tone={automatic ? "success" : "warning"}>
            {automatic ? "Recomendado" : "Emergencia"}
          </span>
          {saved ? (
            <span className="admin-config-chip text-10px font-black uppercase tracking-widest" data-tone="info">
              En uso
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-12px leading-4 text-white/62">
          {automatic
            ? "Usa lo que Mercado Pago cobró en pagos reales; donde todavía no hay datos, el respaldo manual."
            : "Fuerza los valores cargados a mano. El cálculo deja de seguir los costos observados."}
        </span>
      </span>
    </button>
  )
}

function SourcePill({ source, mode }: { source: MercadoPagoCostSource; mode: MercadoPagoCostsMode }) {
  const observed = source === "observed"
  return (
    <span
      className="admin-config-chip text-10px font-black uppercase tracking-widest"
      data-tone={observed ? "success" : mode === "manual" ? "warning" : "neutral"}
    >
      {observed ? "Observado" : mode === "manual" ? "Manual" : "Respaldo"}
    </span>
  )
}

const COST_GRID =
  "md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.85fr)_minmax(0,0.85fr)]"

function CostRow({
  label,
  hint,
  availability,
  observation,
  observationUnavailableText,
  ivaPercent,
  manualValue,
  manualLabel,
  manualInUse,
  effectiveValue,
  source,
  mode,
  disabled,
  onManualChange,
}: {
  label: string
  hint: string
  /** Disponibilidad actual en Mercado Pago (las cuotas no disponibles conservan su histórico de costos). */
  availability?: ReactNode
  observation: MercadoPagoCostObservation | null
  observationUnavailableText: string
  ivaPercent: number
  manualValue: string
  manualLabel: string
  manualInUse: boolean
  effectiveValue: number
  source: MercadoPagoCostSource
  mode: MercadoPagoCostsMode
  disabled: boolean
  onManualChange: (value: string) => void
}) {
  const observedValue = observation ? withoutIva(observation.percentWithIva, ivaPercent) : null
  const manualNumber = parsePercentage(manualValue)
  const differs = observedValue !== null && Math.abs(observedValue - manualNumber) >= DIFFERENCE_THRESHOLD

  return (
    <div
      data-cost-row={label}
      className={cn("admin-config-cost-row grid grid-cols-2 items-center gap-x-3 gap-y-2 px-3 py-2.5", COST_GRID)}
    >
      <div className="col-span-2 min-w-0 md:col-span-1">
        <p className="flex flex-wrap items-center gap-1.5 text-sm font-black text-white">
          {label}
          {availability}
        </p>
        <p className="text-12px leading-4 text-white/58">{hint}</p>
      </div>

      <div className="col-span-2 min-w-0 md:col-span-1">
        <p className="admin-config-cell-label text-10px font-black uppercase tracking-widest text-white/50 md:hidden">
          Observado en Mercado Pago
        </p>
        {observation && observedValue !== null ? (
          <>
            <p className="flex flex-wrap items-center gap-1.5 text-sm font-black text-emerald-200">
              {formatPercent(observedValue)}
              {differs ? (
                <span className="admin-config-chip text-10px font-black uppercase tracking-widest" data-tone="warning">
                  Manual: {formatPercent(manualNumber)}
                </span>
              ) : null}
            </p>
            <p className="text-12px leading-4 text-white/58" title={`${formatPercent(observation.percentWithIva, 3)} con IVA`}>
              {describeObservation(observation)}
            </p>
          </>
        ) : (
          <p className="text-12px font-semibold leading-4 text-white/52">{observationUnavailableText}</p>
        )}
      </div>

      <div className={cn("min-w-0", !manualInUse && "admin-config-muted")}>
        <p className="admin-config-cell-label text-10px font-black uppercase tracking-widest text-white/50 md:hidden">
          {manualLabel}
        </p>
        <AdminTextInput
          title={`${label} (${manualLabel.toLowerCase()})`}
          ariaLabel={`${label}: valor ${manualLabel.toLowerCase()}`}
          value={withInputSymbol(manualValue, "%")}
          placeholder="% 0"
          inputMode="decimal"
          className="text-center text-sm font-bold"
          disabled={disabled}
          onChange={(value) => onManualChange(sanitizePercentInput(value))}
        />
      </div>

      <div className="min-w-0">
        <p className="admin-config-cell-label text-10px font-black uppercase tracking-widest text-white/50 md:hidden">
          En uso
        </p>
        <p className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-black text-white">{formatPercent(effectiveValue)}</span>
          <SourcePill source={source} mode={mode} />
        </p>
      </div>
    </div>
  )
}

function Block({
  icon,
  title,
  help,
  children,
  className,
  ...rest
}: {
  icon: ReactNode
  title: string
  help?: string
  children: ReactNode
  className?: string
  [dataAttribute: `data-${string}`]: string | undefined
}) {
  return (
    <section className={cn("min-w-0", className)} {...rest}>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-11px font-black uppercase tracking-widest text-white/62">
        {icon}
        {title}
        {help ? (
          <span
            className="admin-config-chip cursor-help text-10px font-black normal-case tracking-normal"
            data-tone="neutral"
            title={help}
            aria-label={help}
          >
            ?
          </span>
        ) : null}
      </h3>
      {children}
    </section>
  )
}

function historyStatusText(event: MercadoPagoCostChangeEvent) {
  return event.previousPercentWithIva === null
    ? "Primer costo observado. Aplicado para ventas futuras."
    : "Aplicado automáticamente para ventas futuras."
}

const BRAND_LABELS: Record<string, string> = { visa: "Visa", master: "Mastercard" }

function brandsText(brands: string[] | undefined) {
  return brands?.length ? brands.map((brand) => BRAND_LABELS[brand] ?? brand).join(" · ") : null
}

function AvailabilityChip({ minimum, checked }: { minimum: number | null; checked: boolean }) {
  if (!checked) return null
  return (
    <span
      className="admin-config-chip text-10px font-black uppercase tracking-widest"
      data-tone={minimum === null ? "neutral" : "success"}
      data-availability={minimum === null ? "unavailable" : "available"}
    >
      {minimum === null ? "No disponible hoy" : `Desde aprox. ${formatARS(minimum)}`}
    </span>
  )
}

interface FinancingPanelProps {
  overview: MercadoPagoCostsOverview | null
  disabled: boolean
  saving: boolean
  checkingReference: boolean
  feedback: ConfigFeedback | null
  onSave: (value: StoredInstallmentsFinancingSettings) => void
  onCheckReference: () => void
}

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
  const stored = toStored(draft)
  const dirty = !sameStored(stored, toStored(toDraft(overview)))
  const observed = overview?.observed ?? null
  const syncStatus = overview?.interestFreeStatus ?? null
  const reference = syncStatus?.reference ?? null
  const syncFailed = Boolean(syncStatus?.lastError)
  // Máximo sin interés que confirma Mercado Pago (BEYONIX nunca pasa de 6).
  const confirmedMax = getConfirmedInterestFreeMax(reference)
  const publicMessage = getInterestFreeMessage(overview?.interestFreeOffer)
  const resolved = resolveInstallmentsFinancing(stored, draft.mode, observed)
  const effective: InstallmentsFinancingConfig = resolved.effective
  const inputsDisabled = disabled || saving
  const manual = draft.mode === "manual"
  const manualLabel = manual ? "Manual" : "Respaldo manual"

  const setSurcharge = (count: InstallmentCount, value: string) =>
    setDraft((current) => ({ ...current, surcharge: { ...current.surcharge, [count]: value } }))

  const mercadoPagoStatus: { tone: ConfigTone; value: string; detail: string } = !draft.interestFreeEnabled
    ? { tone: "neutral", value: "En pausa", detail: "Cuotas desactivadas: no se consulta a Mercado Pago." }
    : syncFailed
      ? {
          tone: "danger",
          value: "⚠ No se pudo verificar",
          detail: syncStatus?.lastAttemptAt ? `Falló ${formatDateTime(syncStatus.lastAttemptAt)}` : "Falló la última consulta",
        }
      : reference
        ? { tone: "success", value: "Sincronizado", detail: `Última comprobación ${formatDateTime(reference.checkedAt)}` }
        : { tone: "info", value: "Sin comprobar", detail: "Usá “Comprobar ahora”" }

  const costRows: Array<{ key: "base" | InstallmentCount; label: string; hint: string }> = [
    { key: "base", label: "1 pago", hint: "Crédito en 1 pago. 1 pago siempre se cobra a precio contado." },
    { key: 2, label: "2 cuotas", hint: "Se usa cuando el máximo confirmado es 2." },
    { key: 3, label: "3 cuotas", hint: "Se usa cuando el máximo confirmado es 3." },
    { key: 6, label: "6 cuotas", hint: "Se usa cuando el máximo confirmado es 6." },
  ]

  return (
    <ConfigSection
      icon={<CreditCard className="size-3.5" />}
      eyebrow="Centro de control"
      title="Costos y cuotas de Mercado Pago"
      description="Costos internos para calcular el precio financiado. El cliente nunca ve estos porcentajes."
      feedback={feedback}
      className={cn("admin-financing-panel", manual && "admin-financing-manual")}
      actions={
        <ConfigSaveActions
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          onSave={() => onSave(stored)}
        />
      }
    >
      <div className="space-y-4">
        <Block icon={<Activity className="size-3.5" />} title="Estado" data-financing-block="estado">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <ConfigTile
              label="Modo"
              value={manual ? "Manual / Emergencia" : "Automático"}
              tone={manual ? "warning" : "success"}
              detail={draft.mode !== overview?.mode ? "Sin guardar" : manual ? "Valores cargados a mano" : "Costos de pagos reales"}
            />
            <ConfigTile
              label="Cuotas sin interés"
              value={draft.interestFreeEnabled ? "Activas" : "Inactivas"}
              tone={draft.interestFreeEnabled ? "success" : "neutral"}
              action={
                <AdminSecondaryButton
                  size="sm"
                  aria-label={draft.interestFreeEnabled ? "Desactivar cuotas sin interés" : "Activar cuotas sin interés"}
                  aria-pressed={draft.interestFreeEnabled}
                  disabled={inputsDisabled}
                  onClick={() => setDraft((current) => ({ ...current, interestFreeEnabled: !current.interestFreeEnabled }))}
                  data-interest-free-toggle
                  className={cn("admin-toggle min-w-0 justify-start px-2.5", draft.interestFreeEnabled && "admin-toggle-on")}
                >
                  {draft.interestFreeEnabled ? (
                    <ToggleRight aria-hidden="true" className="admin-toggle-icon size-4" />
                  ) : (
                    <ToggleLeft aria-hidden="true" className="admin-toggle-icon size-4" />
                  )}
                  <span className="text-xs text-white">{draft.interestFreeEnabled ? "Activadas" : "Desactivadas"}</span>
                </AdminSecondaryButton>
              }
            />
            <ConfigTile
              label="Última actualización automática"
              value={observed?.lastAppliedAt ? formatDateTime(observed.lastAppliedAt) : "Sin datos todavía"}
              tone={observed ? (observed.lastAppliedAt ? "info" : "neutral") : "danger"}
              detail={observed ? `${observed.analyzedPayments} pagos aprobados analizados` : "No se pudieron leer los pagos: se usa el respaldo."}
            />
            <ConfigTile
              label="Sincronización MP"
              value={mercadoPagoStatus.value}
              tone={mercadoPagoStatus.tone}
              detail={mercadoPagoStatus.detail}
            />
          </div>

          <div role="radiogroup" aria-label="Origen de los costos de Mercado Pago" className="mt-2 grid gap-2 md:grid-cols-2">
            {(["automatic", "manual"] as const).map((mode) => (
              <ModeOption
                key={mode}
                mode={mode}
                selected={draft.mode === mode}
                saved={overview?.mode === mode}
                disabled={inputsDisabled}
                onSelect={(next) => setDraft((current) => ({ ...current, mode: next }))}
              />
            ))}
          </div>

          {manual ? (
            <div
              className="admin-config-status mt-2 flex items-start gap-2 px-3 py-2"
              data-tone="warning"
              data-manual-warning
              role="status"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
              <p className="text-12px font-semibold leading-5 text-white/85">{MANUAL_MODE_WARNING}</p>
            </div>
          ) : null}

          {!draft.interestFreeEnabled ? (
            <div className="admin-config-status mt-2 px-3 py-2" data-tone="info" data-interest-free-off role="status">
              <p className="text-12px leading-5 text-white/80">
                <strong className="text-white">Cuotas sin interés desactivadas.</strong> BEYONIX no comunica &quot;sin
                interés&quot; ni absorbe financiación: sólo ofrece Mercado Pago en 1 pago a precio contado.
              </p>
            </div>
          ) : null}
        </Block>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Block
            icon={<CreditCard className="size-3.5" />}
            title="Promoción actual"
            help="Lo que Mercado Pago confirma hoy para Checkout Pro. BEYONIX ofrece exactamente eso (máximo 6), desde el mismo monto."
            data-financing-block="promocion"
          >
            <div
              className="admin-config-status mb-2 space-y-0.5 px-3 py-2 text-12px leading-5 text-white/80"
              data-tone={syncFailed ? "danger" : confirmedMax ? "success" : "info"}
              data-mercadopago-sync
              role="status"
            >
              {syncFailed ? (
                <>
                  <p className="font-black text-white">⚠ Mercado Pago no pudo verificarse</p>
                  <p data-sync-error>
                    {syncStatus?.lastError}
                    {syncStatus?.lastAttemptAt ? ` Falló: ${formatDateTime(syncStatus.lastAttemptAt)}.` : ""}
                  </p>
                  <p data-last-success>
                    {reference
                      ? `Última consulta exitosa: ${formatDateTime(reference.checkedAt)}.`
                      : "Sin consultas exitosas todavía."}
                  </p>
                  <p>Mientras tanto la tienda no comunica ninguna promoción y el checkout sólo ofrece 1 pago a precio contado si Mercado Pago no confirma en vivo.</p>
                </>
              ) : reference ? (
                confirmedMax ? (
                  <dl data-confirmed-max className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
                    <dt className="text-white/62">Máximo confirmado:</dt>
                    <dd className="font-black text-white">{confirmedMax.count} cuotas sin interés</dd>
                    <dt className="text-white/62">Desde aprox.:</dt>
                    <dd className="font-black text-white">{formatARS(confirmedMax.minimumAmount)}</dd>
                    <dt className="text-white/62">Compatible:</dt>
                    <dd className="font-black text-white">{brandsText(confirmedMax.brands) ?? "Sin dato de marcas"}</dd>
                  </dl>
                ) : (
                  <p data-confirmed-max>
                    Mercado Pago no confirma cuotas sin interés para ningún monto probado (hasta{" "}
                    {formatARS(REFERENCE_PROBE_MAX_AMOUNT)}): sólo 1 pago a precio contado.
                  </p>
                )
              ) : (
                <p>Todavía no se comprobó Mercado Pago: no se comunica ninguna promoción.</p>
              )}
            </div>
            <div className="admin-config-cost-table">
              {INSTALLMENT_COUNTS.map((count) => {
                const minimum = reference?.minimumAmountByCount[count] ?? null
                return (
                  <div
                    key={count}
                    data-availability-row={count}
                    className="admin-config-cost-row flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2"
                  >
                    <span className="text-sm font-black text-white">{count} cuotas sin interés</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-12px text-white/70">
                      {reference ? (
                        <>
                          <AvailabilityChip minimum={minimum} checked />
                          {minimum !== null && brandsText(reference.brandsByCount[count]) ? (
                            <span data-reference-brands>{brandsText(reference.brandsByCount[count])}</span>
                          ) : null}
                        </>
                      ) : (
                        "Sin comprobar"
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-12px leading-5 text-white/58">
                {reference ? (
                  <p data-reference-checked>Última comprobación exitosa: {formatDateTime(reference.checkedAt)}</p>
                ) : null}
                {syncStatus?.lastFailure && !syncFailed ? (
                  <p data-last-failure>
                    Último fallo: {formatDateTime(syncStatus.lastFailure.at)} · {syncStatus.lastFailure.message}
                  </p>
                ) : null}
                <p>Mínimos estimados con consultas reales a Mercado Pago (no expone el umbral). Se sincroniza solo cada ~15 min.</p>
              </div>
              <AdminSecondaryButton
                size="sm"
                disabled={disabled || checkingReference}
                onClick={onCheckReference}
                data-check-reference
              >
                <RefreshCw className={cn("size-3.5", checkingReference && "animate-spin")} />
                {checkingReference ? "Comprobando…" : "Comprobar ahora"}
              </AdminSecondaryButton>
            </div>
          </Block>

          <div className="space-y-4">
            <Block icon={<Megaphone className="size-3.5" />} title="Comunicación pública" data-financing-block="comunicacion">
              <div
                className="admin-config-status px-3 py-2 text-12px leading-5 text-white/80"
                data-tone={publicMessage ? "success" : "neutral"}
                data-public-message
              >
                {publicMessage ? (
                  <p className="text-sm font-black text-white">“{publicMessage.text}”</p>
                ) : (
                  <p>Ninguna: no hay promoción confirmada y vigente para comunicar.</p>
                )}
                <p className="mt-0.5 text-white/62">Mismo texto en Home, categorías, tarjetas, ficha, carrito y checkout.</p>
              </div>
            </Block>

            <Block icon={<ListChecks className="size-3.5" />} title="Reglas activas" data-financing-block="reglas">
              <ul className="admin-config-summary space-y-1 px-3.5 py-3 text-12px leading-5 text-white/78">
                <li><strong className="text-white">1 pago</strong> → precio contado (crédito, débito o dinero en cuenta).</li>
                <li><strong className="text-white">Cuotas</strong> → un solo precio financiado con el costo del máximo confirmado (2, 3 o 6).</li>
                <li>Elegir menos cuotas no baja el precio.</li>
                <li>Se ofrece exactamente lo que confirma Mercado Pago, desde el mismo monto. Máximo {MAX_INTEREST_FREE_INSTALLMENTS} (9, 12 o 18 nunca).</li>
                <li>Cuenta el <strong className="text-white">monto final que cobra Mercado Pago</strong>: productos + envío pagado − descuentos − saldo.</li>
              </ul>
            </Block>
          </div>
        </div>

        <Block
          icon={<Wallet className="size-3.5" />}
          title="Costos"
          help="Porcentajes sin IVA. Observado = lo que Mercado Pago cobró en el último pago real y confiable de esa modalidad: una sola venta alcanza para actualizarlo."
          data-financing-block="costos"
        >
          <div className="admin-config-cost-table">
            <div className={cn("admin-config-cost-head hidden gap-3 px-3 py-2 text-10px font-black uppercase tracking-widest text-white/55 md:grid", COST_GRID)}>
              <span>Modalidad (sin IVA)</span>
              <span>Observado · última observación</span>
              <span>{manualLabel}</span>
              <span>En uso · fuente</span>
            </div>
            {costRows.map((row) => {
              const isBase = row.key === "base"
              const count = row.key as InstallmentCount
              const source = isBase ? resolved.sources.base : resolved.sources.surchargeByCount[count]
              return (
                <CostRow
                  key={row.key}
                  label={row.label}
                  hint={row.hint}
                  availability={
                    isBase ? null : (
                      <AvailabilityChip minimum={reference?.minimumAmountByCount[count] ?? null} checked={reference !== null} />
                    )
                  }
                  observation={isBase ? observed?.base ?? null : observed?.surchargeByCount[count] ?? null}
                  observationUnavailableText={
                    isBase ? "Sin pagos con crédito en 1 pago todavía" : "Sin pagos con crédito en estas cuotas sin interés todavía"
                  }
                  ivaPercent={effective.ivaPercent}
                  manualValue={isBase ? draft.base : draft.surcharge[count]}
                  manualLabel={manualLabel}
                  manualInUse={source === "manual"}
                  effectiveValue={isBase ? effective.baseProcessingPercent : effective.surchargePercentByCount[count]}
                  source={source}
                  mode={draft.mode}
                  disabled={inputsDisabled}
                  onManualChange={(value) =>
                    isBase ? setDraft((current) => ({ ...current, base: value })) : setSurcharge(count, value)
                  }
                />
              )
            })}
            <CostRow
              label="IVA"
              hint="Sobre las comisiones de Mercado Pago."
              observation={null}
              observationUnavailableText="Mercado Pago no lo informa por separado: siempre se usa este valor."
              ivaPercent={effective.ivaPercent}
              manualValue={draft.iva}
              manualLabel={manualLabel}
              manualInUse
              effectiveValue={effective.ivaPercent}
              source="manual"
              mode="manual"
              disabled={inputsDisabled}
              onManualChange={(value) => setDraft((current) => ({ ...current, iva: value }))}
            />
          </div>
          {observed ? (
            <p data-observed-references className="mt-1.5 text-12px leading-5 text-white/62">
              <strong className="text-white/80">Referencia (no se usa para calcular):</strong>{" "}
              {(["debit_card", "account_money"] as const)
                .map((type) => {
                  const observation = observed.singlePaymentByType[type]
                  const label = PAYMENT_TYPE_LABELS[type]
                  const name = `${label[0].toUpperCase()}${label.slice(1)}`
                  return observation
                    ? `${name}: ${formatPercent(withoutIva(observation.percentWithIva, effective.ivaPercent))}`
                    : `${name}: sin datos`
                })
                .join(" · ")}
            </p>
          ) : null}
        </Block>

        <Block icon={<History className="size-3.5" />} title="Historial" data-financing-block="historial">
          {observed && observed.history.length > 0 ? (
            <ul className="admin-config-cost-table" data-cost-history>
              {observed.history.slice(0, 8).map((event) => (
                <li
                  key={`${event.modality}-${event.orderId}-${event.observedAt}`}
                  className="admin-config-cost-row flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-3 py-2"
                >
                  <span className="text-sm font-black text-white">
                    {MODALITY_LABELS[event.modality]}{" "}
                    <span className="font-bold text-white/80">
                      {event.previousPercentWithIva === null
                        ? formatPercent(withoutIva(event.percentWithIva, effective.ivaPercent))
                        : `${formatPercent(withoutIva(event.previousPercentWithIva, effective.ivaPercent))} → ${formatPercent(withoutIva(event.percentWithIva, effective.ivaPercent))}`}
                    </span>
                  </span>
                  <span className="text-12px text-white/62">
                    Detectado en pago real · {formatDateTime(event.observedAt)} · BX-{1000 + event.orderId}
                  </span>
                  <span
                    className="admin-config-chip w-full whitespace-normal text-10px font-black normal-case tracking-normal sm:w-auto"
                    data-tone="success"
                  >
                    {historyStatusText(event)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-12px text-white/58">
              {observed ? "Todavía no hay cambios detectados en pagos reales." : "No se pudieron leer los pagos observados."}
            </p>
          )}
        </Block>
      </div>
    </ConfigSection>
  )
}
