"use client"

import { useState } from "react"
import { Activity, CreditCard, Hand } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  getEffectiveInstallmentPercent,
  INSTALLMENT_COUNTS,
  type InstallmentCount,
  type InstallmentsFinancingConfig,
} from "@/lib/products/installments"
import { getFinancedPrice, getInstallmentAmount } from "@/lib/pricing/financed-pricing"
import {
  MERCADOPAGO_OBSERVATION_MAX_AGE_DAYS,
  resolveInstallmentsFinancing,
  type MercadoPagoCostObservation,
  type MercadoPagoCostSource,
  type MercadoPagoCostsMode,
} from "@/lib/mercadopago/observed-costs"
import {
  DEFAULT_INSTALLMENTS_FINANCING_SETTINGS,
  type MercadoPagoCostsOverview,
  type StoredInstallmentsFinancingSettings,
} from "@/lib/site-settings"
import { AdminTextInput } from "../../components/admin-controls"
import {
  ConfigSaveActions,
  ConfigSection,
  ConfigSummary,
  formatARS,
  formatDateTime,
  formatPercent,
  parsePercentage,
  sanitizePercentInput,
  withInputSymbol,
  type ConfigFeedback,
  type ConfigTone,
} from "./config-ui"

const PREVIEW_CASH_AMOUNT = 75_000
const DIFFERENCE_THRESHOLD = 0.01

const PAYMENT_TYPE_LABELS: Record<string, string> = {
  credit_card: "tarjeta de crédito",
  debit_card: "débito",
  account_money: "dinero en cuenta",
  prepaid_card: "prepaga",
}

type CostKey = "base" | InstallmentCount

interface Draft {
  mode: MercadoPagoCostsMode
  base: string
  iva: string
  surcharge: Record<InstallmentCount, string>
}

function toDraft(overview: MercadoPagoCostsOverview | null): Draft {
  const manual = overview?.manual ?? DEFAULT_INSTALLMENTS_FINANCING_SETTINGS
  return {
    mode: overview?.mode ?? "manual",
    base: String(manual.baseProcessingPercent),
    iva: String(manual.ivaPercent),
    surcharge: {
      2: String(manual.surchargePercentByCount[2]),
      3: String(manual.surchargePercentByCount[3]),
      6: String(manual.surchargePercentByCount[6]),
    },
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
  }
}

function sameStored(a: StoredInstallmentsFinancingSettings, b: StoredInstallmentsFinancingSettings) {
  return (
    a.mode === b.mode &&
    a.baseProcessingPercent === b.baseProcessingPercent &&
    a.ivaPercent === b.ivaPercent &&
    INSTALLMENT_COUNTS.every((count) => a.surchargePercentByCount[count] === b.surchargePercentByCount[count])
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
    `${formatPercent(observation.percentWithIva, 3)} con IVA`,
    formatDateTime(observation.observedAt),
    medium && (observation.installments > 1 ? `${medium} en ${observation.installments} cuotas` : medium),
    observation.releaseDays != null && `liberación ${observation.releaseDays} días`,
  ]
    .filter(Boolean)
    .join(" · ")
}

interface ModeOptionProps {
  mode: MercadoPagoCostsMode
  selected: boolean
  saved: boolean
  disabled: boolean
  onSelect: (mode: MercadoPagoCostsMode) => void
}

function ModeOption({ mode, selected, saved, disabled, onSelect }: ModeOptionProps) {
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
          <span className="text-sm font-black text-white">{automatic ? "Automático" : "Manual"}</span>
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
            ? "Sigue lo que Mercado Pago cobró en los últimos pagos reales. Donde todavía no hay datos, usa el respaldo manual."
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

interface CostRowProps {
  label: string
  hint: string
  observation: MercadoPagoCostObservation | null
  observationUnavailableText?: string
  ivaPercent: number
  manualValue: string
  manualLabel: string
  manualInUse: boolean
  effectiveValue: number
  source: MercadoPagoCostSource
  mode: MercadoPagoCostsMode
  disabled: boolean
  onManualChange: (value: string) => void
}

function CostRow({
  label,
  hint,
  observation,
  observationUnavailableText = "Sin datos todavía",
  ivaPercent,
  manualValue,
  manualLabel,
  manualInUse,
  effectiveValue,
  source,
  mode,
  disabled,
  onManualChange,
}: CostRowProps) {
  const observedValue = observation ? withoutIva(observation.percentWithIva, ivaPercent) : null
  const manualNumber = parsePercentage(manualValue)
  const differs = observedValue !== null && Math.abs(observedValue - manualNumber) >= DIFFERENCE_THRESHOLD

  return (
    <div className="admin-config-cost-row grid grid-cols-2 items-center gap-x-3 gap-y-2 px-3 py-2.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,0.9fr)]">
      <div className="col-span-2 min-w-0 md:col-span-1">
        <p className="text-sm font-black text-white">{label}</p>
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
            <p className="text-12px leading-4 text-white/58">
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

function statusFor(
  draft: Draft,
  overview: MercadoPagoCostsOverview | null,
  observedCount: number,
  latestObservation: string | null,
): { tone: ConfigTone; title: string; text: string } {
  if (draft.mode === "manual") {
    return {
      tone: "warning",
      title: "Modo manual",
      text: "Los cálculos usan sólo los valores cargados a mano y no siguen los costos observados en Mercado Pago.",
    }
  }
  if (overview && overview.observed === null) {
    return {
      tone: "danger",
      title: "Automático sin lectura",
      text: "No se pudieron leer los pagos observados. Mientras tanto se usan los valores de respaldo.",
    }
  }
  if (observedCount === 0) {
    return {
      tone: "info",
      title: "Todavía no hay datos observados",
      text: "Se usarán los valores de respaldo hasta detectar pagos reales aprobados.",
    }
  }
  return {
    tone: "success",
    title: "Automático activo",
    text: `${observedCount} de 4 costos salen de pagos reales${latestObservation ? ` (última observación: ${formatDateTime(latestObservation)})` : ""}. El resto usa el respaldo manual.`,
  }
}

interface MercadoPagoCostsSectionProps {
  overview: MercadoPagoCostsOverview | null
  disabled: boolean
  saving: boolean
  feedback: ConfigFeedback | null
  onSave: (value: StoredInstallmentsFinancingSettings) => void
}

export function MercadoPagoCostsSection({
  overview,
  disabled,
  saving,
  feedback,
  onSave,
}: MercadoPagoCostsSectionProps) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(overview))
  const stored = toStored(draft)
  const saved = toStored(toDraft(overview))
  const dirty = !sameStored(stored, saved)
  const observed = overview?.observed ?? null
  const resolved = resolveInstallmentsFinancing(stored, draft.mode, observed)
  const effective: InstallmentsFinancingConfig = resolved.effective
  const inputsDisabled = disabled || saving

  const observations = observed
    ? [observed.base, ...INSTALLMENT_COUNTS.map((count) => observed.surchargeByCount[count])]
    : []
  const presentObservations = observations.filter(
    (observation): observation is MercadoPagoCostObservation => observation !== null,
  )
  const latestObservation = presentObservations.reduce<string | null>(
    (latest, observation) =>
      !latest || Date.parse(observation.observedAt) > Date.parse(latest) ? observation.observedAt : latest,
    null,
  )
  const status = statusFor(draft, overview, presentObservations.length, latestObservation)
  const manualLabel = draft.mode === "manual" ? "Manual" : "Respaldo manual"

  const setSurcharge = (count: InstallmentCount, value: string) =>
    setDraft((current) => ({ ...current, surcharge: { ...current.surcharge, [count]: value } }))

  const rows: Array<{ key: CostKey; label: string; hint: string }> = [
    { key: "base", label: "Comisión base", hint: "Tarjeta de crédito en 1 pago." },
    { key: 2, label: "+2 cuotas", hint: "Costo extra de cuotas sin interés." },
    { key: 3, label: "+3 cuotas", hint: "Costo extra de cuotas sin interés." },
    { key: 6, label: "+6 cuotas", hint: "Costo extra de cuotas sin interés." },
  ]

  return (
    <ConfigSection
      icon={<CreditCard className="size-3.5" />}
      eyebrow="Pagos"
      title="Costos de Mercado Pago"
      description="Costos internos para calcular el precio financiado. El cliente nunca ve estos porcentajes."
      feedback={feedback}
      actions={
        <ConfigSaveActions
          dirty={dirty}
          saving={saving}
          disabled={disabled}
          onSave={() => onSave(stored)}
        />
      }
    >
      <div role="radiogroup" aria-label="Origen de los costos de Mercado Pago" className="grid gap-2 md:grid-cols-2">
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

      <div
        className="admin-config-status mt-2.5 flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
        data-tone={status.tone}
        role="status"
      >
        <p className="text-12px leading-5 text-white/80">
          <strong className="text-white">{status.title}{draft.mode !== overview?.mode ? " (sin guardar)" : ""}.</strong>{" "}
          {status.text}
        </p>
        {draft.mode === "automatic" && observed ? (
          <p className="shrink-0 text-11px font-semibold text-white/58">
            {observed.analyzedPayments} pagos analizados · últimos {MERCADOPAGO_OBSERVATION_MAX_AGE_DAYS} días
          </p>
        ) : null}
      </div>

      <div className="admin-config-cost-table mt-2.5">
        <div className="admin-config-cost-head hidden gap-3 px-3 py-2 text-10px font-black uppercase tracking-widest text-white/55 md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,0.9fr)]">
          <span>Costo (sin IVA)</span>
          <span>Observado en Mercado Pago</span>
          <span>{manualLabel}</span>
          <span>En uso</span>
        </div>
        {rows.map((row) => {
          const isBase = row.key === "base"
          const source = isBase ? resolved.sources.base : resolved.sources.surchargeByCount[row.key as InstallmentCount]
          return (
            <CostRow
              key={row.key}
              label={row.label}
              hint={row.hint}
              observation={isBase ? observed?.base ?? null : observed?.surchargeByCount[row.key as InstallmentCount] ?? null}
              observationUnavailableText={
                isBase ? "Sin pagos con crédito en 1 pago todavía" : "Sin pagos con crédito en estas cuotas sin interés todavía"
              }
              ivaPercent={effective.ivaPercent}
              manualValue={isBase ? draft.base : draft.surcharge[row.key as InstallmentCount]}
              manualLabel={manualLabel}
              manualInUse={source === "manual"}
              effectiveValue={
                isBase ? effective.baseProcessingPercent : effective.surchargePercentByCount[row.key as InstallmentCount]
              }
              source={source}
              mode={draft.mode}
              disabled={inputsDisabled}
              onManualChange={(value) =>
                isBase
                  ? setDraft((current) => ({ ...current, base: value }))
                  : setSurcharge(row.key as InstallmentCount, value)
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
        <p data-observed-references className="mt-2 text-12px leading-5 text-white/62">
          <strong className="text-white/80">Referencia por medio (no se usa para calcular):</strong>{" "}
          {(["account_money", "debit_card"] as const)
            .map((type) => {
              const observation = observed.singlePaymentByType[type]
              const label = PAYMENT_TYPE_LABELS[type]
              return observation
                ? `${label[0].toUpperCase()}${label.slice(1)}: ${describeObservation(observation)}`
                : `${label[0].toUpperCase()}${label.slice(1)}: sin datos`
            })
            .join(" · ")}
        </p>
      ) : null}

      <ConfigSummary className="mt-2.5">
        <p className="mb-2 font-bold text-white">
          Impacto con los costos en uso · contado de {formatARS(PREVIEW_CASH_AMOUNT)}
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {INSTALLMENT_COUNTS.map((count) => {
            const financed = getFinancedPrice(PREVIEW_CASH_AMOUNT, count, effective)
            const installment = financed === null ? null : getInstallmentAmount(financed, count)
            return (
              <div key={count} className="admin-config-tile px-3 py-2" data-tone="neutral">
                <p className="text-10px font-black uppercase tracking-widest text-white/55">
                  Hasta {count} cuotas · costo {getEffectiveInstallmentPercent(count, effective)}%
                </p>
                <p className="mt-0.5 text-sm font-black text-beyonix-cyan">
                  {financed === null ? "—" : formatARS(financed)}
                </p>
                <p className="text-12px text-white/62">
                  {installment === null ? "" : `${count} × ${formatARS(installment)}`}
                </p>
              </div>
            )
          })}
        </div>
        <p className="mt-2 text-12px text-white/58">
          Los productos con &quot;Mismo precio en contado y cuotas&quot; no suben de precio: BEYONIX absorbe este costo.
        </p>
      </ConfigSummary>
    </ConfigSection>
  )
}
