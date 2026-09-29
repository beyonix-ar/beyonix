"use client"

import { useRef, useState } from "react"
import { Download, LoaderCircle, Lock, PackageCheck, RefreshCw, Search, Truck } from "lucide-react"

import { AdminButton, AdminDangerButton, AdminSecondaryButton, adminControlClassName } from "@/app/admin/components/admin-controls"
import { HelpTip } from "@/components/claims/help-tip"
import { getOrCreateIdempotencyAttempt, type IdempotencyAttempt } from "@/lib/business/idempotency-attempt"
import {
  CLAIM_INCIDENT_LABELS,
  CLAIM_UNIT_LOCATION_LABELS,
  getAdminClaimLogisticsView,
  type ClaimIncidentType,
  type ClaimUnitAction,
  type ClaimUnitActionOption,
  type ClaimUnitLocation,
} from "@/lib/orders/claim-shipment-view"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderClaim } from "@/lib/supabase/types"

type Pending = "request" | "create" | "sync" | "reconcile" | "cancel" | "exchange_not_completed" | "review_resolve" | "label" | "unit" | "branches"
type RequestKind = "cambio" | "devolucion" | "reemplazo"
type LegForm = "reconcile" | "cancel" | "exchange_not_completed" | "review_resolve"
/**
 * Qué parte de la logística muestra cada paso del wizard (una sola cosa por paso):
 *   method      -> elegir / corregir el método (nada más);
 *   logistics   -> la operación Andreani del método (cambio en sucursal o retiro);
 *   reception   -> lo que vuelve a BEYONIX: llegada, incidencias, producto nuevo devuelto;
 *   replacement -> reenvío del reemplazo (retiro + revisión + reenvío);
 *   all         -> todo junto (reclamos sin paso "Método": reintegros sin método, legacy).
 */
export type ClaimLogisticsPanelSection = "method" | "logistics" | "reception" | "replacement" | "all"

/** Sucursal tal como la devuelve el catálogo de Andreani (vía servidor). */
interface BranchOption {
  id: string
  name: string
  address: string | null
  locality: string
  province: string
  postalCode: string | null
}

const INCIDENT_TYPES = Object.keys(CLAIM_INCIDENT_LABELS) as ClaimIncidentType[]

const RESEND_REQUEST = {
  label: "Reenvío del reemplazo a sucursal",
  description: "Se reserva el reemplazo y Andreani lo lleva a la sucursal elegida, donde el cliente lo retira.",
}

const CONFIRM_LABELS: Record<RequestKind, string> = {
  cambio: "Confirmar cambio",
  devolucion: "Confirmar retiro",
  reemplazo: "Confirmar reenvío",
}

const RECEPTION_ACTIONS: ClaimUnitAction[] = ["arrival_original", "arrival_replacement", "inspect_replacement", "incident_open", "incident_resolve", "waive_original"]
const RESERVATION_ACTIONS: ClaimUnitAction[] = ["release_reservation", "deliver_manual"]

/** Texto corto del botón; el formulario muestra la descripción completa. */
function actionButtonLabel(option: ClaimUnitActionOption, multipleRoles: boolean) {
  const role = multipleRoles ? (option.role === "original" ? " (original)" : " (nuevo)") : ""
  switch (option.action) {
    case "arrival_original": return "Registrar llegada a BEYONIX"
    case "arrival_replacement": return option.noteMin ? "Corregir: el producto nuevo volvió" : "Registrar regreso del producto nuevo"
    case "inspect_replacement": return "Revisar producto nuevo devuelto"
    case "incident_open": return `Registrar incidencia${role}`
    case "incident_resolve": return `Resolver incidencia${role}`
    case "waive_original": return "El cliente conserva el original"
    case "release_reservation": return "Liberar reserva"
    case "deliver_manual": return "Entregado fuera de Andreani"
  }
}

function locationSummary(counts: Partial<Record<ClaimUnitLocation, number>>) {
  const entries = Object.entries(counts).filter(([, count]) => (count ?? 0) > 0) as Array<[ClaimUnitLocation, number]>
  return entries.length ? entries.map(([location, count]) => `${count} · ${CLAIM_UNIT_LOCATION_LABELS[location]}`).join(" | ") : "—"
}

function branchLine(branch: BranchOption) {
  return [branch.name, branch.address, [branch.locality, branch.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
}

/**
 * Logística del reclamo (Admin): método elegido explícitamente (cambio directo
 * o retiro + revisión + reenvío, siempre por sucursal Andreani validada contra
 * el catálogo real), paradero de cada unidad, operación vigente y sólo las
 * acciones válidas del paso. Toda acción se vuelve a validar en servidor y
 * base; las que ceden una regla exigen motivo y confirmación.
 */
export function ClaimAndreaniShipmentPanel({
  claim,
  itemLabel,
  canManage,
  creditNoteActive = false,
  section = "all",
  onClaimChange,
}: {
  claim: SupabaseOrderClaim
  itemLabel: (orderItemId: number) => string
  canManage: boolean
  creditNoteActive?: boolean
  section?: ClaimLogisticsPanelSection
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState("")
  const [requestKind, setRequestKind] = useState<RequestKind | null>(null)
  const [branchQuery, setBranchQuery] = useState("")
  const [branchResults, setBranchResults] = useState<BranchOption[] | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<BranchOption | null>(null)
  const [branchPickerOpen, setBranchPickerOpen] = useState(false)
  const [suggestionLoading, setSuggestionLoading] = useState(false)
  const [requestNotes, setRequestNotes] = useState("")
  const [requestConfirming, setRequestConfirming] = useState(false)
  const [legForm, setLegForm] = useState<LegForm | null>(null)
  const [resolution, setResolution] = useState<"created" | "not_created">("created")
  const [envioId, setEnvioId] = useState("")
  const [legNotes, setLegNotes] = useState("")
  const [unitAction, setUnitAction] = useState<ClaimUnitActionOption | null>(null)
  const [quantity, setQuantity] = useState(1)
  const [restock, setRestock] = useState(1)
  const [unitNotes, setUnitNotes] = useState("")
  const [incidentType, setIncidentType] = useState<ClaimIncidentType | "">("")
  const [confirming, setConfirming] = useState(false)
  const inFlightRef = useRef(false)
  // Misma acción + mismos datos = misma clave: un reintento tras un timeout
  // nunca se aplica dos veces (la base guarda la clave).
  const unitAttemptRef = useRef<IdempotencyAttempt | null>(null)
  const requestSequenceRef = useRef(0)
  const branchSearchRef = useRef<HTMLInputElement>(null)

  const view = getAdminClaimLogisticsView({
    status: claim.status,
    resolution: claim.resolution,
    shipments: claim.order_claim_shipments ?? null,
    units: claim.order_claim_units ?? null,
    legacy: claim.logistics_legacy,
    creditNoteActive,
  })
  if (!view) return null
  const leg = view.leg
  const all = section === "all"
  const showMethod = all || section === "method"
  const reservationSection: ClaimLogisticsPanelSection = view.plan === "retiro_y_reenvio" ? "replacement" : "logistics"
  const legInSection = Boolean(leg) && (all ||
    (section === "logistics" && leg?.direction !== "reemplazo") ||
    (section === "replacement" && leg?.direction === "reemplazo"))
  const actionInSection = (option: ClaimUnitActionOption) => all ||
    (section === "reception" && RECEPTION_ACTIONS.includes(option.action)) ||
    (section === reservationSection && RESERVATION_ACTIONS.includes(option.action))
  const sectionActions = view.unitActions.filter(actionInSection)

  const withToken = async <T,>(action: Pending, work: (token: string) => Promise<T>): Promise<T | null> => {
    // Doble click: una sola solicitud en vuelo (la base además lo garantiza).
    if (inFlightRef.current) return null
    inFlightRef.current = true
    setPending(action)
    setError("")
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setError("La sesión administrativa venció.")
        return null
      }
      return await work(session.access_token)
    } catch {
      setError("No se pudo completar la operación.")
      return null
    } finally {
      inFlightRef.current = false
      setPending(null)
    }
  }

  const post = (action: Pending, payload: Record<string, unknown>, onDone?: () => void) =>
    withToken(action, async (token) => {
      const response = await fetch(`/api/admin/order-claims/${claim.id}/andreani-shipment`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = (await response.json().catch(() => ({}))) as { claim?: SupabaseOrderClaim; error?: string }
      if (!response.ok || !data.claim) {
        setError(data.error || "No se pudo completar la operación.")
        return
      }
      onDone?.()
      onClaimChange(data.claim)
    })

  const openLabel = (shipmentId: number) =>
    withToken("label", async (token) => {
      const response = await fetch(`/api/admin/order-claims/${claim.id}/andreani-shipment?shipmentId=${shipmentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        setError(data.error || "No se pudo obtener la etiqueta.")
        return
      }
      const url = URL.createObjectURL(await response.blob())
      window.open(url, "_blank", "noopener")
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    })

  const fetchBranches = (params: string) =>
    withToken("branches", async (token) => {
      const response = await fetch(`/api/admin/order-claims/${claim.id}/andreani-branches?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json().catch(() => ({}))) as { branches?: BranchOption[]; suggested?: BranchOption | null; error?: string }
      if (!response.ok) {
        setError(data.error || "No pudimos consultar las sucursales de Andreani.")
        return null
      }
      return data
    })

  const openRequest = async (kind: RequestKind) => {
    const sequence = ++requestSequenceRef.current
    setRequestKind(kind)
    setBranchQuery("")
    setBranchResults(null)
    setSelectedBranch(null)
    setBranchPickerOpen(false)
    setRequestNotes("")
    setRequestConfirming(false)
    setSuggestionLoading(true)
    // Sugerida por el servidor (tramo anterior o sucursal de BEYONIX), validada
    // contra el catálogo actual de Andreani. Si ya no existe, se elige otra.
    const data = await fetchBranches(`direction=${kind}`)
    if (sequence !== requestSequenceRef.current) return
    setSuggestionLoading(false)
    if (data?.suggested) setSelectedBranch(data.suggested)
    else setBranchPickerOpen(true)
  }

  const cancelRequest = () => {
    requestSequenceRef.current += 1
    setRequestKind(null)
    setRequestConfirming(false)
    setSuggestionLoading(false)
    setError("")
  }

  const searchBranches = async () => {
    const data = await fetchBranches(`q=${encodeURIComponent(branchQuery.trim())}`)
    if (data) setBranchResults(data.branches ?? [])
  }

  const pickBranch = (branch: BranchOption) => {
    setSelectedBranch(branch)
    setRequestConfirming(false)
    setBranchPickerOpen(false)
    setBranchResults(null)
    setBranchQuery("")
  }

  // Nuevo método (no reintento ni reenvío del mismo plan) con operación real previa: motivo.
  const reasonRequired = requestKind !== null && requestKind !== "reemplazo" && view.methodChangeRequiresReason &&
    view.methodOptions.some((option) => option.direction === requestKind)
  const submitRequest = () => {
    if (!requestKind || !selectedBranch) return
    // Corregir un método con operación Andreani previa: segunda confirmación.
    if (reasonRequired && !requestConfirming) {
      setRequestConfirming(true)
      return
    }
    void post("request", {
      action: "request",
      direction: requestKind,
      branchId: selectedBranch.id,
      notes: requestNotes.trim() || undefined,
    }, () => setRequestKind(null))
  }

  const openUnitAction = (option: ClaimUnitActionOption) => {
    setUnitAction(option)
    setQuantity(1)
    setRestock(1)
    setUnitNotes("")
    setIncidentType("")
    setConfirming(false)
  }

  const submitUnitAction = () => {
    if (!unitAction) return
    const override = ["release_reservation", "deliver_manual", "waive_original", "incident_resolve"].includes(unitAction.action) ||
      unitAction.label.startsWith("Corregir")
    if (override && !confirming) {
      setConfirming(true)
      return
    }
    const payload = {
      action: unitAction.action,
      role: unitAction.role,
      orderItemId: unitAction.orderItemId,
      quantity,
      restock: unitAction.action === "inspect_replacement" ? restock : undefined,
      writeOff: unitAction.action === "inspect_replacement" ? quantity - restock : undefined,
      incidentType: incidentType || undefined,
      notes: unitNotes.trim(),
    }
    const attempt = getOrCreateIdempotencyAttempt(unitAttemptRef.current, { claimId: claim.id, ...payload }, "claim-logistics")
    unitAttemptRef.current = attempt
    void post("unit", { ...payload, idempotencyKey: attempt.key }, () => {
      unitAttemptRef.current = null
      setUnitAction(null)
    })
  }

  const notesMin = unitAction
    ? Math.max(unitAction.noteMin, incidentType ? 5 : 0, unitAction.action === "inspect_replacement" && quantity - restock > 0 ? 3 : 0)
    : 0
  const legNotesMin = legForm === "reconcile" ? 5 : 10
  const incidentRequired = unitAction?.action === "incident_open"
  const summary = view.summary
  const lock = view.methodLock
  const methodName = `claim-${claim.id}-method-${section}`
  const requestInfo = requestKind === "reemplazo"
    ? RESEND_REQUEST
    : view.methodChoices.find((choice) => choice.direction === requestKind) ?? null
  // Cada formulario vive en su paso: el método en "Método", el reintento del
  // cambio en la operación y el reenvío en "Reenvío".
  const requestVisible = requestKind !== null && (all || (
    requestKind === "reemplazo" ? section === "replacement"
      : requestKind === "cambio" && view.canRetryExchange ? section === "logistics"
        : section === "method"
  ))
  const showItems = section === "reception" || section === reservationSection || all

  return (
    <section className="admin-claim-wizard-action admin-claim-logistics" data-claim-logistics data-claim-logistics-section={section}>
      {section !== "method" && (
        <>
          <h4 className="admin-claim-logistics-heading">
            <Truck className="size-4" aria-hidden="true" />
            Logística del reclamo
            {view.legacy && (
              <>
                <span className="admin-claim-method-badge">Reclamo anterior</span>
                <HelpTip label="Reclamo anterior" align="start">Se creó antes del circuito por sucursal. Si nunca tuvo movimientos podés elegir un método en el paso Método; si ya los tuvo, sigue su flujo original.</HelpTip>
              </>
            )}
          </h4>
          <dl className="admin-claim-logistics-summary" data-claim-logistics-summary>
            <div><dt>Método</dt><dd>{summary.method}</dd></div>
            <div><dt>Sucursal</dt><dd>{summary.branch}</dd></div>
            <div><dt>Andreani</dt><dd>{summary.andreani}</dd></div>
            <div><dt>Inspección</dt><dd>{summary.inspection}</dd></div>
            <div><dt>Incidencias</dt><dd>{summary.incidents}</dd></div>
            <div><dt>Intervención manual</dt><dd>{summary.manualIntervention ? "Sí" : "No"}</dd></div>
          </dl>
          {view.nextStep && (
            <p className={`admin-claim-logistics-next ${view.humanActionRequired ? "is-action" : ""}`} data-claim-logistics-next>
              <strong>{view.humanActionRequired ? "Acción recomendada:" : "Próximo paso:"}</strong> {view.nextStep}
            </p>
          )}
        </>
      )}

      {showMethod && view.methodChoices.length > 0 && (
        // Radios bloqueados sólo mientras se guarda (la consulta de sucursales no le quita el
        // foco al teclado); la ayuda (?) sigue accesible aunque el método no se pueda elegir.
        <fieldset className="admin-claim-method" data-claim-logistics-methods>
          <legend className="admin-claim-method-legend">Método logístico</legend>
          <div className="admin-claim-method-options">
            {view.methodChoices.map((choice) => {
              const inputId = `${methodName}-${choice.direction}`
              return (
                <div key={choice.direction} className="admin-claim-method-option" data-claim-logistics-method={choice.direction}>
                  <label htmlFor={inputId}
                    className={`admin-claim-method-card ${requestKind === choice.direction ? "is-selected" : ""} ${choice.current ? "is-current" : ""} ${choice.available ? "" : "is-disabled"}`}>
                    <input id={inputId} type="radio" name={methodName} value={choice.direction}
                      checked={requestKind === choice.direction}
                      disabled={!canManage || !choice.available || pending === "request"}
                      onChange={() => void openRequest(choice.direction)} />
                    <span className="admin-claim-method-title">{choice.label}</span>
                    {choice.current && <span className="admin-claim-method-badge">Actual</span>}
                  </label>
                  <HelpTip label={choice.label}>{choice.description}</HelpTip>
                </div>
              )
            })}
          </div>
        </fieldset>
      )}

      {showMethod && view.plan && (
        lock.status === "blocked" ? (
          <div role="status" className="admin-claim-method-lock" data-claim-method-lock="blocked">
            <p className="admin-claim-method-lock-title"><Lock className="size-3.5" aria-hidden="true" />El método no se puede cambiar directamente.</p>
            {lock.effects.length > 0 && <ul>{lock.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>}
            {lock.correction && <p>{lock.correction}</p>}
          </div>
        ) : lock.status === "reason" ? (
          <div role="status" className="admin-claim-method-lock is-reason" data-claim-method-lock="reason">
            <p className="admin-claim-method-lock-title">Cambiar el método requiere motivo y queda auditado.</p>
            {lock.effects.length > 0 && <ul>{lock.effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>}
          </div>
        ) : view.methodChoices.some((choice) => choice.available) ? (
          <p className="admin-claim-logistics-hint" data-claim-method-lock="free">Todavía no hay operaciones reales: podés cambiar el método.</p>
        ) : null
      )}

      {canManage && !requestKind && (
        ((all || section === "logistics") && view.canRetryExchange) || ((all || section === "replacement") && view.canAuthorizeResend)
      ) && (
        <div className="flex flex-wrap gap-2">
          {(all || section === "logistics") && view.canRetryExchange && (
            <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => void openRequest("cambio")}>Reintentar el cambio en sucursal</AdminSecondaryButton>
          )}
          {(all || section === "replacement") && view.canAuthorizeResend && (
            <AdminButton size="sm" variant="primary" disabled={pending !== null} onClick={() => void openRequest("reemplazo")}>Autorizar reemplazo y enviarlo a sucursal</AdminButton>
          )}
        </div>
      )}

      {canManage && requestKind && requestInfo && requestVisible && (
        <div className="admin-claim-method-form" data-claim-logistics-request={requestKind}>
          <p className="admin-claim-method-form-title">
            {requestInfo.label}
            <HelpTip label={requestInfo.label} align="start">{requestInfo.description}</HelpTip>
          </p>
          <div className="admin-claim-branch-current">
            <p className={`admin-claim-branch-selected ${selectedBranch || suggestionLoading ? "" : "is-empty"}`} data-claim-logistics-branch aria-live="polite">
              {suggestionLoading
                ? "Buscando la sucursal sugerida…"
                : selectedBranch
                  ? <>Sucursal: <strong>{branchLine(selectedBranch)}</strong></>
                  : "Elegí una sucursal Andreani para continuar."}
            </p>
            {selectedBranch && !branchPickerOpen && (
              <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => {
                setBranchPickerOpen(true)
                window.setTimeout(() => branchSearchRef.current?.focus(), 0)
              }}>Cambiar sucursal</AdminSecondaryButton>
            )}
          </div>
          {branchPickerOpen && (
            <div className="grid gap-1.5" data-claim-logistics-branch-picker>
              <div className="admin-claim-branch-search">
                <input className={`${adminControlClassName} admin-claim-compact-input`} value={branchQuery} maxLength={80}
                  placeholder="Localidad, dirección o sucursal" aria-label="Buscar sucursal Andreani" ref={branchSearchRef}
                  onChange={(event) => setBranchQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (branchQuery.trim().length >= 3) void searchBranches() } }} />
                <AdminSecondaryButton size="sm" disabled={pending !== null || branchQuery.trim().length < 3} onClick={() => void searchBranches()}>
                  {pending === "branches" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
                  Buscar
                </AdminSecondaryButton>
                {selectedBranch && (
                  <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => setBranchPickerOpen(false)}>Mantener</AdminSecondaryButton>
                )}
              </div>
              {branchResults && (
                branchResults.length === 0
                  ? <p className="admin-claim-logistics-hint">No encontramos sucursales con esa búsqueda.</p>
                  : (
                    <ul className="admin-claim-branch-results" data-claim-logistics-branches>
                      {branchResults.map((branch) => (
                        <li key={branch.id}>
                          <button type="button" className="admin-claim-branch-option" aria-pressed={selectedBranch?.id === branch.id}
                            disabled={pending !== null} onClick={() => pickBranch(branch)}>
                            {branchLine(branch)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
              )}
            </div>
          )}
          {requestKind !== "reemplazo" && (
            <label className="grid gap-1">
              <span className="admin-claim-logistics-label">Motivo{reasonRequired ? " (obligatorio, mínimo 10 caracteres)" : " (opcional)"}</span>
              <textarea className={`${adminControlClassName} admin-claim-compact-textarea`} value={requestNotes}
                onChange={(event) => setRequestNotes(event.target.value)} maxLength={1000} rows={2} />
            </label>
          )}
          {requestConfirming && selectedBranch && (
            <p role="alert" className="admin-claim-logistics-warning">
              Ya hubo una operación Andreani: el cambio de método queda auditado con tu usuario y el motivo. ¿Confirmás?
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <AdminButton size="sm" variant="primary" onClick={submitRequest}
              disabled={pending !== null || !selectedBranch || (reasonRequired && requestNotes.trim().length < 10)}>
              {pending === "request" ? "Guardando..." : requestConfirming ? "Sí, confirmar" : CONFIRM_LABELS[requestKind]}
            </AdminButton>
            <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={cancelRequest}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}

      {legInSection && leg && (
        <div className="admin-claim-logistics-leg" data-claim-logistics-leg={leg.direction}>
          <p className="font-semibold text-white">{leg.title} · {leg.statusLabel}{leg.legacy ? " · operación heredada" : ""}</p>
          {leg.outcomeLabel && <p className="font-semibold text-white">{leg.outcomeLabel}</p>}
          <dl className="grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
            {leg.tracking && <div><dt className="inline font-semibold">Seguimiento: </dt><dd className="inline">{leg.tracking}</dd></div>}
            {leg.andreaniEstado && <div><dt className="inline font-semibold">Estado Andreani: </dt><dd className="inline">{leg.andreaniEstado}</dd></div>}
            {leg.custodySince && <div><dt className="inline font-semibold">En sucursal desde (según Andreani): </dt><dd className="inline">{new Date(leg.custodySince).toLocaleDateString("es-AR")}</dd></div>}
            {leg.costKnown && <div><dt className="inline font-semibold">Costo: </dt><dd className="inline">{leg.costLabel}</dd></div>}
          </dl>
          {leg.review && <p role="alert" className="admin-claim-logistics-warning">Requiere revisión: {leg.review}. El avance automático está congelado.</p>}
          {leg.incident && <p role="status" className="admin-claim-logistics-warning">{leg.incident}</p>}
          {leg.error && <p role="alert" className="font-semibold text-red-200">{leg.error}</p>}
        </div>
      )}

      {canManage && legInSection && leg && (
        <div className="flex flex-wrap gap-2">
          {leg.canCreate && (
            <AdminButton size="sm" variant="primary" disabled={pending !== null} onClick={() => void post("create", { action: "create", shipmentId: leg.id })}>
              {pending === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Truck className="size-4" />}
              {pending === "create" ? "Generando..." : leg.direction === "cambio" ? "Generar cambio en sucursal" : leg.direction === "devolucion" ? "Generar retiro por sucursal" : "Generar envío a sucursal"}
            </AdminButton>
          )}
          {leg.canSync && (
            <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => void post("sync", { action: "sync", shipmentId: leg.id })}>
              {pending === "sync" ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {pending === "sync" ? "Consultando..." : "Consultar seguimiento"}
            </AdminSecondaryButton>
          )}
          {leg.labelAvailable && (
            <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => void openLabel(leg.id)}>
              {pending === "label" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
              Etiqueta
            </AdminSecondaryButton>
          )}
          {leg.canResolveReview && <AdminButton size="sm" variant="primary" disabled={pending !== null} onClick={() => { setLegForm("review_resolve"); setLegNotes("") }}>Registrar revisión del evento</AdminButton>}
          {leg.canReconcile && <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => { setLegForm("reconcile"); setLegNotes("") }}>Conciliar con Andreani</AdminSecondaryButton>}
          {leg.canMarkNotCompleted && <AdminDangerButton size="sm" disabled={pending !== null} onClick={() => { setLegForm("exchange_not_completed"); setLegNotes("") }}>Cambio no completado</AdminDangerButton>}
          {leg.canCancel && <AdminDangerButton size="sm" disabled={pending !== null} onClick={() => { setLegForm("cancel"); setLegNotes("") }}>Cancelar operación</AdminDangerButton>}
        </div>
      )}

      {canManage && legInSection && leg && legForm && (
        <div className="admin-claim-method-form" data-claim-logistics-leg-form={legForm}>
          {legForm === "reconcile" && (
            <>
              <label className="grid gap-1">
                <span className="admin-claim-logistics-label">¿La orden existe en Andreani?</span>
                <select className={`${adminControlClassName} admin-claim-compact-input`} value={resolution} onChange={(event) => setResolution(event.target.value as "created" | "not_created")}>
                  <option value="created">Sí, existe (vincular; se verifica en Andreani)</option>
                  <option value="not_created">No existe (permitir generarla de nuevo)</option>
                </select>
              </label>
              {resolution === "created" && (
                <label className="grid gap-1">
                  <span className="admin-claim-logistics-label">Número de orden Andreani</span>
                  <input className={`${adminControlClassName} admin-claim-compact-input`} value={envioId} onChange={(event) => setEnvioId(event.target.value)} maxLength={80} />
                </label>
              )}
            </>
          )}
          {legForm === "exchange_not_completed" && (
            <p>Registrá que el cliente no entregó el producto original. El producto nuevo queda en custodia de Andreani hasta volver a BEYONIX; se avisa al cliente.</p>
          )}
          {legForm === "cancel" && (
            <p>Cancelá sólo si Andreani nunca retiró el producto (o anuló la orden). Las unidades quedan disponibles para otra operación.</p>
          )}
          {legForm === "review_resolve" && (
            <p>Confirmá con Andreani qué pasó con el envío y dejá constancia. El avance se reanuda en la próxima consulta; los hechos físicos (llegada, cancelación) se registran con sus acciones.</p>
          )}
          <label className="grid gap-1">
            <span className="admin-claim-logistics-label">{legForm === "reconcile" ? "Cómo lo confirmaste" : "Motivo"} (mínimo {legNotesMin} caracteres)</span>
            <textarea className={`${adminControlClassName} admin-claim-compact-textarea`} value={legNotes} onChange={(event) => setLegNotes(event.target.value)} maxLength={1000} rows={2} />
          </label>
          <div className="flex gap-2">
            <AdminButton size="sm" variant="primary"
              disabled={pending !== null || legNotes.trim().length < legNotesMin || (legForm === "reconcile" && resolution === "created" && !envioId.trim())}
              onClick={() => void post(legForm, {
                action: legForm, shipmentId: leg.id, notes: legNotes.trim(),
                ...(legForm === "reconcile" ? { resolution, envioId: envioId.trim() } : {}),
              }, () => setLegForm(null))}>
              {pending === legForm ? "Guardando..." : "Confirmar"}
            </AdminButton>
            <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => setLegForm(null)}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}

      {showItems && view.items.length > 0 && (
        <ul className="admin-claim-logistics-units" data-claim-logistics-units>
          {view.items.map((item) => {
            const itemActions = canManage && !unitAction ? sectionActions.filter((option) => option.orderItemId === item.orderItemId) : []
            const multipleRoles = new Set(itemActions.map((option) => option.role)).size > 1
            return (
              <li key={item.orderItemId} data-claim-logistics-item={item.orderItemId}>
                <p className="font-semibold text-white">{itemLabel(item.orderItemId)}{item.incident ? ` · Incidencia: ${item.incident}` : ""}</p>
                <p>Original: {locationSummary(item.original)}</p>
                {Object.keys(item.replacement).length > 0 && <p>Nuevo: {locationSummary(item.replacement)}</p>}
                {itemActions.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5" data-claim-logistics-item-actions>
                    {itemActions.map((option) => (
                      <AdminSecondaryButton key={`${option.action}-${option.role}-${option.label}`} size="sm" disabled={pending !== null}
                        data-claim-unit-action={option.action}
                        aria-label={`${actionButtonLabel(option, multipleRoles)} · ${itemLabel(item.orderItemId)}`}
                        onClick={() => openUnitAction(option)}>
                        {actionButtonLabel(option, multipleRoles)}
                      </AdminSecondaryButton>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {error && <p role="alert" className="text-xs font-semibold text-red-200">{error}</p>}

      {canManage && unitAction && actionInSection(unitAction) && (
        <div className="admin-claim-method-form" data-claim-logistics-unit-form={unitAction.action}>
          <p className="font-semibold text-white"><PackageCheck className="mr-1 inline size-4" aria-hidden="true" />{unitAction.label} · {itemLabel(unitAction.orderItemId)}</p>
          {!unitAction.action.startsWith("incident") && (
            <label className="grid gap-1">
              <span className="admin-claim-logistics-label">Unidades (máximo {unitAction.max})</span>
              <input type="number" min={1} max={unitAction.max} className={`${adminControlClassName} admin-claim-compact-input`} value={quantity}
                onChange={(event) => setQuantity(Math.max(1, Math.min(unitAction.max, Math.trunc(Number(event.target.value) || 1))))} />
            </label>
          )}
          {unitAction.action === "inspect_replacement" && (
            <div className="grid gap-1">
              <span className="admin-claim-logistics-label">
                Vuelven a stock vendible
                <HelpTip label="Vuelven a stock vendible" align="start">El resto se da de baja. Un paquete vacío o un producto distinto nunca vuelven al stock.</HelpTip>
              </span>
              <input type="number" min={0} max={quantity} aria-label="Vuelven a stock vendible" className={`${adminControlClassName} admin-claim-compact-input`} value={Math.min(restock, quantity)}
                onChange={(event) => setRestock(Math.max(0, Math.min(quantity, Math.trunc(Number(event.target.value) || 0))))} />
            </div>
          )}
          {(unitAction.action.startsWith("arrival") || incidentRequired) && (
            <label className="grid gap-1">
              <span className="admin-claim-logistics-label">{incidentRequired ? "Resultado de la inspección" : "Al abrir el paquete"}</span>
              <select className={`${adminControlClassName} admin-claim-compact-input`} value={incidentType} onChange={(event) => setIncidentType(event.target.value as ClaimIncidentType | "")}>
                {!incidentRequired && <option value="">Sin novedad (queda pendiente de inspección)</option>}
                {incidentRequired && <option value="">Elegí la incidencia…</option>}
                {INCIDENT_TYPES.map((type) => <option key={type} value={type}>{CLAIM_INCIDENT_LABELS[type]}</option>)}
              </select>
            </label>
          )}
          <label className="grid gap-1">
            <span className="admin-claim-logistics-label">Observación{notesMin ? ` (mínimo ${notesMin} caracteres)` : " (opcional)"}</span>
            <textarea className={`${adminControlClassName} admin-claim-compact-textarea`} value={unitNotes} onChange={(event) => setUnitNotes(event.target.value)} maxLength={1000} rows={2} />
          </label>
          {confirming && <p role="alert" className="admin-claim-logistics-warning">Esta acción cede o cierra una regla del circuito y queda auditada con tu usuario y el motivo. ¿Confirmás?</p>}
          <div className="flex gap-2">
            <AdminButton size="sm" variant="primary" disabled={pending !== null || unitNotes.trim().length < notesMin || (incidentRequired && !incidentType)} onClick={submitUnitAction}>
              {pending === "unit" ? "Guardando..." : confirming ? "Sí, confirmar" : "Registrar"}
            </AdminButton>
            <AdminSecondaryButton size="sm" disabled={pending !== null} onClick={() => setUnitAction(null)}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}
    </section>
  )
}
