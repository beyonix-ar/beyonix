// Presentación del wizard de resolución (Etapa 6). Las reglas viven en la API
// de Etapa 5: acá sólo se ordenan sus respuestas en pasos humanos.
import type {
  FinancialChoice, FinancialHumanStatus, FinancialOption, FinancialProductOutcome,
  FinancialReceptionState, FinancialResolutionMode, MerchandiseSituation, ReturnMoneyDecision, ReturnPhysicalState,
} from "./financial-resolution.ts"
import { financialHumanStatus, MERCHANDISE_SITUATION_COPY } from "./financial-resolution.ts"

export type FinancialResolutionView = {
  mode: FinancialResolutionMode
  amount: number
  status: FinancialHumanStatus
  financialOptions: FinancialOption[]
  receptionOptions: FinancialOption[]
  product: FinancialProductOutcome
  reception: FinancialReceptionState
  notice: string | null
  /** Situación real de la mercadería (MERCHANDISE_SITUATION_COPY). */
  merchandise: MerchandiseSituation
  /** Cancelación ya despachada: el dinero exige inspección y decisión. */
  returnInspectionRequired: boolean
  returnInspection: {
    physicalState: ReturnPhysicalState
    decision: ReturnMoneyDecision
    reason: string | null
    customerMessage: string | null
    inspectedAt: string
  } | null
  resolution: { id: string; type: FinancialChoice; status: string; amount: number; detail: string | null; mpRefundId?: string | null
    /** Reintegro ya enviado (o ambiguo) en Mercado Pago, todavía sin confirmar. */
    refundPending?: boolean } | null
}

export type FinancialWizardStep = "money" | "reception" | "review"

export type FinancialWizardState = {
  step: FinancialWizardStep
  product: FinancialProductOutcome | null
  choice: FinancialChoice | null
  receptionAnswer: "yes" | "no" | null
  exception: boolean
  exceptionReason: string
}

export type FinancialWizardAction =
  | { type: "product"; value: FinancialProductOutcome }
  | { type: "choice"; value: FinancialChoice }
  | { type: "reception"; value: "yes" | "no" }
  | { type: "exception" }
  | { type: "reason"; value: string }
  | { type: "next" }
  | { type: "back" }

export const EXCEPTION_REASON_MIN_LENGTH = 10

export const FINANCIAL_STEP_LABELS: Record<FinancialWizardStep, string> = {
  money: "Dinero", reception: "Recepción", review: "Revisar",
}

export const FINANCIAL_CHOICE_COPY: Record<FinancialChoice, { label: string; short: string; description: string }> = {
  beyonix_credit: { label: "Saldo a favor", short: "Saldo a favor", description: "Se acredita en la cuenta BEYONIX del cliente al confirmar." },
  mercadopago_refund: { label: "Reintegrar por Mercado Pago", short: "Mercado Pago", description: "BEYONIX ejecuta el reintegro en Mercado Pago al confirmar, sin salir del sistema." },
  manual_refund: { label: "Reintegro externo", short: "Reintegro externo", description: "Transferí el dinero al cliente y registrá el comprobante después." },
}

export const RETURN_DECISION_COPY: Record<ReturnMoneyDecision, string> = {
  approved: "Aprobar devolución del dinero",
  rejected: "Rechazar devolución del dinero",
}

/** El producto ya lo determinó BEYONIX (view.product): el asistente arranca en el dinero. */
export function initialFinancialWizardState(view: FinancialResolutionView): FinancialWizardState {
  return { step: "money", product: view.product, choice: null, receptionAnswer: null, exception: false, exceptionReason: "" }
}

export function getMerchandiseSituationLabel(view: Pick<FinancialResolutionView, "merchandise">) {
  return MERCHANDISE_SITUATION_COPY[view.merchandise]
}

/** Sólo una devolución inspeccionada tiene una decisión de dinero para mostrar. */
export function getReturnDecisionLabel(view: Pick<FinancialResolutionView, "returnInspection">) {
  return view.returnInspection ? RETURN_DECISION_COPY[view.returnInspection.decision] : null
}

/** Cancelación despachada sin inspección: el asistente empieza por la mercadería. */
export function needsReturnInspection(view: FinancialResolutionView) {
  return view.returnInspectionRequired && !view.returnInspection && !view.resolution
}

export function isReturnMoneyRejected(view: FinancialResolutionView) {
  return view.returnInspection?.decision === "rejected"
}

/** Sólo la respuesta que coincide con lo registrado en BEYONIX es elegible. */
export function isProductOptionAvailable(view: FinancialResolutionView, value: FinancialProductOutcome) {
  return view.product === value
}

function needsReceptionStep(view: FinancialResolutionView, product: FinancialProductOutcome | null) {
  return product === "return" && view.reception === "pending"
}

export function getFinancialWizardSteps(view: FinancialResolutionView, state: Pick<FinancialWizardState, "product">): FinancialWizardStep[] {
  return needsReceptionStep(view, state.product) ? ["money", "reception", "review"] : ["money", "review"]
}

/** Opciones devueltas por la API; con recepción pendiente, las que se habilitan al recibir o con excepción. */
export function getFinancialMoneyOptions(view: FinancialResolutionView, product: FinancialProductOutcome | null): FinancialOption[] {
  if (!product || !isProductOptionAvailable(view, product)) return []
  return needsReceptionStep(view, product) ? view.receptionOptions : view.financialOptions
}

export function canContinueFinancialWizard(view: FinancialResolutionView, state: FinancialWizardState) {
  if (state.step === "money") return getFinancialMoneyOptions(view, state.product).some((option) => option.type === state.choice)
  if (state.step === "reception") return state.receptionAnswer === "no" && state.exception &&
    state.exceptionReason.trim().length >= EXCEPTION_REASON_MIN_LENGTH
  return false
}

export function reduceFinancialWizard(state: FinancialWizardState, action: FinancialWizardAction, view: FinancialResolutionView): FinancialWizardState {
  switch (action.type) {
    case "product": {
      if (!isProductOptionAvailable(view, action.value) || state.product === action.value) return state
      const options = getFinancialMoneyOptions(view, action.value)
      return { ...state, product: action.value, choice: options.some((option) => option.type === state.choice) ? state.choice : null,
        receptionAnswer: null, exception: false, exceptionReason: "" }
    }
    case "choice":
      return getFinancialMoneyOptions(view, state.product).some((option) => option.type === action.value) ? { ...state, choice: action.value } : state
    case "reception":
      return action.value === state.receptionAnswer ? state : { ...state, receptionAnswer: action.value, exception: false, exceptionReason: "" }
    case "exception":
      return state.receptionAnswer === "no" ? { ...state, exception: true } : state
    case "reason":
      return state.exception ? { ...state, exceptionReason: action.value.slice(0, 1000) } : state
    case "next": {
      if (!canContinueFinancialWizard(view, state)) return state
      const steps = getFinancialWizardSteps(view, state)
      return { ...state, step: steps[Math.min(steps.indexOf(state.step) + 1, steps.length - 1)] }
    }
    case "back": {
      const steps = getFinancialWizardSteps(view, state)
      return { ...state, step: steps[Math.max(steps.indexOf(state.step) - 1, 0)] }
    }
  }
}

export function getFinancialReceptionLabel(view: FinancialResolutionView, state: FinancialWizardState) {
  if (state.product !== "return") return "No aplica"
  if (view.reception === "received") return "Recibido"
  if (view.reception === "exception") return "Excepción registrada"
  return state.exception ? "Pendiente (excepción)" : "Pendiente"
}

export function buildFinancialResolvePayload(view: FinancialResolutionView, state: FinancialWizardState) {
  if (!state.choice) throw new Error("Elegí cómo resolver el dinero.")
  const exception = needsReceptionStep(view, state.product) && state.exception
  return { action: "resolve" as const, choice: state.choice, confirmed: true as const,
    ...(exception ? { receptionExceptionReason: state.exceptionReason.trim() } : {}) }
}

export type FinancialOutcome =
  | { kind: "processing" }
  | { kind: "completed" }
  | { kind: "manual_pending" }
  /** Mercado Pago tiene (o pudo recibir) el reintegro y falta su confirmación: no es un error. */
  | { kind: "refund_pending"; detail: string | null }
  | { kind: "requires_action"; detail: string | null }

export function getFinancialOutcome(resolution: NonNullable<FinancialResolutionView["resolution"]>): FinancialOutcome {
  if (resolution.status === "completed") return { kind: "completed" }
  if (resolution.status === "manual_pending") return { kind: "manual_pending" }
  if (resolution.status === "requires_action" && resolution.type === "mercadopago_refund" && resolution.refundPending) {
    return { kind: "refund_pending", detail: resolution.detail }
  }
  if (resolution.status === "requires_action") return { kind: "requires_action", detail: resolution.detail }
  return { kind: "processing" }
}

/**
 * Estado humano único para pendientes (Etapa 7). Esperar la recepción no es
 * una acción del Admin; un caso avanzado o un paso incompleto sí.
 */
export function getFinancialHumanState(view: FinancialResolutionView): FinancialHumanStatus {
  if (isReturnMoneyRejected(view)) return "Completado"
  if (view.resolution) {
    const outcome = getFinancialOutcome(view.resolution)
    if (outcome.kind === "completed") return "Completado"
    if (outcome.kind === "processing" || outcome.kind === "refund_pending") return "En proceso"
    return "Requiere acción"
  }
  if (needsReturnInspection(view) || view.mode === "advanced" || (view.mode === "wizard" && view.financialOptions.length > 0)) return "Requiere acción"
  return "Pendiente"
}

type FinancialResolution = NonNullable<FinancialResolutionView["resolution"]>
const FINANCIAL_CHOICES: readonly FinancialChoice[] = ["beyonix_credit", "mercadopago_refund", "manual_refund"]
const RESOLUTION_STATUSES = ["reserved", "processing", "manual_pending", "requires_action", "completed"]

/**
 * Resolución que devolvió el POST resolve/retry. Sólo se acepta una respuesta
 * completa y válida; ante cualquier duda la UI espera la relectura del GET.
 */
export function getResolutionFromResponse(data: unknown): FinancialResolution | null {
  if (!data || typeof data !== "object") return null
  const { status, resolution } = data as { status?: unknown; resolution?: unknown }
  if (typeof status !== "string" || !RESOLUTION_STATUSES.includes(status) || !resolution || typeof resolution !== "object") return null
  const { id, type, amount, detail, refundPending } = resolution as { id?: unknown; type?: unknown; amount?: unknown; detail?: unknown; refundPending?: unknown }
  if (typeof id !== "string" || !id || !FINANCIAL_CHOICES.includes(type as FinancialChoice)) return null
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) return null
  return { id, type: type as FinancialChoice, status, amount: value, detail: typeof detail === "string" ? detail : null, ...(refundPending === true ? { refundPending } : {}) }
}

/** Vista con la resolución ya confirmada por el backend (sin opciones para elegir otra). */
export function applyFinancialResolution(view: FinancialResolutionView, resolution: FinancialResolution): FinancialResolutionView {
  return { ...view, mode: "resolution", status: financialHumanStatus(resolution.status), financialOptions: [], receptionOptions: [], resolution }
}

/**
 * Una resolución nunca vuelve atrás: existe una por pedido (order_id único) y
 * "completed" es final. Una lectura vieja o en carrera no puede revivir el
 * wizard ni sacar de "Completado" lo que el backend ya confirmó.
 */
export function mergeFinancialResolutionView(known: FinancialResolutionView | null, fetched: FinancialResolutionView | null) {
  if (!known?.resolution) return fetched
  if (!fetched?.resolution || fetched.resolution.id !== known.resolution.id) return known
  if (known.resolution.status === "completed" && fetched.resolution.status !== "completed") return known
  return fetched
}
