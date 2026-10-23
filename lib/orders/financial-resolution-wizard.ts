// Presentación del wizard de resolución (Etapa 6). Las reglas viven en la API
// de Etapa 5: acá sólo se ordenan sus respuestas en pasos humanos.
import type {
  FinancialChoice, FinancialHumanStatus, FinancialOption, FinancialProductOutcome,
  FinancialReceptionState, FinancialResolutionMode,
} from "./financial-resolution.ts"
import { financialHumanStatus } from "./financial-resolution.ts"

export type FinancialResolutionView = {
  mode: FinancialResolutionMode
  amount: number
  status: FinancialHumanStatus
  financialOptions: FinancialOption[]
  receptionOptions: FinancialOption[]
  product: FinancialProductOutcome
  reception: FinancialReceptionState
  notice: string | null
  resolution: { id: string; type: FinancialChoice; status: string; amount: number; detail: string | null; mpRefundId?: string | null } | null
}

export type FinancialWizardStep = "product" | "money" | "reception" | "review"

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
  product: "Producto", money: "Dinero", reception: "Recepción", review: "Revisar",
}

export const FINANCIAL_CHOICE_COPY: Record<FinancialChoice, { label: string; short: string; description: string }> = {
  beyonix_credit: { label: "Saldo a favor", short: "Saldo a favor", description: "Se acredita en la cuenta BEYONIX del cliente al confirmar." },
  mercadopago_refund: { label: "Reintegrar por Mercado Pago", short: "Mercado Pago", description: "BEYONIX ejecuta el reintegro en Mercado Pago al confirmar, sin salir del sistema." },
  manual_refund: { label: "Reintegro externo", short: "Reintegro externo", description: "Transferí el dinero al cliente y registrá el comprobante después." },
}

export const FINANCIAL_PRODUCT_COPY: Record<FinancialProductOutcome, { label: string; description: string }> = {
  no_return: { label: "No vuelve", description: "El producto no sale o queda con el cliente." },
  return: { label: "Debe volver", description: "BEYONIX tiene que recibirlo antes de cerrar el reintegro." },
}

export function initialFinancialWizardState(view: FinancialResolutionView): FinancialWizardState {
  return { step: "product", product: view.product, choice: null, receptionAnswer: null, exception: false, exceptionReason: "" }
}

/** Sólo la respuesta que coincide con lo registrado en BEYONIX es elegible. */
export function isProductOptionAvailable(view: FinancialResolutionView, value: FinancialProductOutcome) {
  return view.product === value
}

function needsReceptionStep(view: FinancialResolutionView, product: FinancialProductOutcome | null) {
  return product === "return" && view.reception === "pending"
}

export function getFinancialWizardSteps(view: FinancialResolutionView, state: Pick<FinancialWizardState, "product">): FinancialWizardStep[] {
  return needsReceptionStep(view, state.product) ? ["product", "money", "reception", "review"] : ["product", "money", "review"]
}

/** Opciones devueltas por la API; con recepción pendiente, las que se habilitan al recibir o con excepción. */
export function getFinancialMoneyOptions(view: FinancialResolutionView, product: FinancialProductOutcome | null): FinancialOption[] {
  if (!product || !isProductOptionAvailable(view, product)) return []
  return needsReceptionStep(view, product) ? view.receptionOptions : view.financialOptions
}

export function canContinueFinancialWizard(view: FinancialResolutionView, state: FinancialWizardState) {
  if (state.step === "product") return !!state.product && isProductOptionAvailable(view, state.product) && getFinancialMoneyOptions(view, state.product).length > 0
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
  | { kind: "requires_action"; detail: string | null }

export function getFinancialOutcome(resolution: NonNullable<FinancialResolutionView["resolution"]>): FinancialOutcome {
  if (resolution.status === "completed") return { kind: "completed" }
  if (resolution.status === "manual_pending") return { kind: "manual_pending" }
  if (resolution.status === "requires_action") return { kind: "requires_action", detail: resolution.detail }
  return { kind: "processing" }
}

/**
 * Estado humano único para pendientes (Etapa 7). Esperar la recepción no es
 * una acción del Admin; un caso avanzado o un paso incompleto sí.
 */
export function getFinancialHumanState(view: FinancialResolutionView): FinancialHumanStatus {
  if (view.resolution) {
    const outcome = getFinancialOutcome(view.resolution)
    if (outcome.kind === "completed") return "Completado"
    if (outcome.kind === "processing") return "En proceso"
    return "Requiere acción"
  }
  if (view.mode === "advanced" || (view.mode === "wizard" && view.financialOptions.length > 0)) return "Requiere acción"
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
  const { id, type, amount, detail } = resolution as { id?: unknown; type?: unknown; amount?: unknown; detail?: unknown }
  if (typeof id !== "string" || !id || !FINANCIAL_CHOICES.includes(type as FinancialChoice)) return null
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) return null
  return { id, type: type as FinancialChoice, status, amount: value, detail: typeof detail === "string" ? detail : null }
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
