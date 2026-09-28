"use client"

import { useRef, useState } from "react"
import { Download, LoaderCircle, PackageCheck, RefreshCw, Search, Truck } from "lucide-react"

import { AdminButton, AdminDangerButton, AdminSecondaryButton, adminControlClassName } from "@/app/admin/components/admin-controls"
import { getOrCreateIdempotencyAttempt, type IdempotencyAttempt } from "@/lib/business/idempotency-attempt"
import {
  CLAIM_INCIDENT_LABELS,
  CLAIM_UNIT_LOCATION_LABELS,
  getAdminClaimLogisticsView,
  type ClaimIncidentType,
  type ClaimUnitActionOption,
  type ClaimUnitLocation,
} from "@/lib/orders/claim-shipment-view"
import { supabase } from "@/lib/supabase/client"
import type { SupabaseOrderClaim } from "@/lib/supabase/types"

type Pending = "request" | "create" | "sync" | "reconcile" | "cancel" | "exchange_not_completed" | "review_resolve" | "label" | "unit" | "branches"
type RequestKind = "cambio" | "devolucion" | "reemplazo"
type LegForm = "reconcile" | "cancel" | "exchange_not_completed" | "review_resolve"

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

function locationSummary(counts: Partial<Record<ClaimUnitLocation, number>>) {
  const entries = Object.entries(counts).filter(([, count]) => (count ?? 0) > 0) as Array<[ClaimUnitLocation, number]>
  return entries.length ? entries.map(([location, count]) => `${count} · ${CLAIM_UNIT_LOCATION_LABELS[location]}`).join(" | ") : "—"
}

function branchLine(branch: BranchOption) {
  return [branch.name, branch.address, [branch.locality, branch.province].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
}

/**
 * Logística del reclamo (Admin): método elegido explícitamente (cambio directo
 * o retiro + revisión + reenvío, siempre por sucursal Andreani elegida del
 * catálogo real), paradero de cada unidad, operación vigente, próximo paso y
 * sólo las acciones válidas. Toda acción se vuelve a validar en servidor y
 * base; las que ceden una regla exigen motivo y confirmación.
 */
export function ClaimAndreaniShipmentPanel({
  claim,
  itemLabel,
  canManage,
  onClaimChange,
}: {
  claim: SupabaseOrderClaim
  itemLabel: (orderItemId: number) => string
  canManage: boolean
  onClaimChange: (claim: SupabaseOrderClaim) => void
}) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [error, setError] = useState("")
  const [requestKind, setRequestKind] = useState<RequestKind | null>(null)
  const [branchQuery, setBranchQuery] = useState("")
  const [branchResults, setBranchResults] = useState<BranchOption[] | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<BranchOption | null>(null)
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

  const view = getAdminClaimLogisticsView({
    status: claim.status,
    resolution: claim.resolution,
    shipments: claim.order_claim_shipments ?? null,
    units: claim.order_claim_units ?? null,
    legacy: claim.logistics_legacy,
  })
  if (!view) return null
  const leg = view.leg

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
    setRequestKind(kind)
    setBranchQuery("")
    setBranchResults(null)
    setSelectedBranch(null)
    setRequestNotes("")
    setRequestConfirming(false)
    // Sugerida (tramo anterior o compra a sucursal), revalidada en Andreani.
    const data = await fetchBranches(`direction=${kind}`)
    if (data?.suggested) setSelectedBranch(data.suggested)
  }

  const searchBranches = async () => {
    const data = await fetchBranches(`q=${encodeURIComponent(branchQuery.trim())}`)
    if (data) setBranchResults(data.branches ?? [])
  }

  // Nuevo método (no reintento ni reenvío del mismo plan) con operación real previa: motivo.
  const reasonRequired = requestKind !== null && requestKind !== "reemplazo" && view.methodChangeRequiresReason &&
    view.methodOptions.some((option) => option.direction === requestKind)
  const submitRequest = () => {
    if (!requestKind || !selectedBranch) return
    if (!requestConfirming) {
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

  return (
    <section className="admin-claim-wizard-action" data-claim-logistics>
      <h4 className="admin-claim-reception-heading flex items-center gap-2">
        <Truck className="size-4" aria-hidden="true" />
        Logística del reclamo{view.legacy ? " · Reclamo anterior (legacy)" : ""}
      </h4>
      <dl className="grid gap-1 text-xs text-white/75 sm:grid-cols-2" data-claim-logistics-summary>
        <div><dt className="inline font-semibold">Método: </dt><dd className="inline">{summary.method}</dd></div>
        <div><dt className="inline font-semibold">Sucursal: </dt><dd className="inline">{summary.branch}</dd></div>
        <div><dt className="inline font-semibold">Andreani: </dt><dd className="inline">{summary.andreani}</dd></div>
        <div><dt className="inline font-semibold">Inspección: </dt><dd className="inline">{summary.inspection}</dd></div>
        <div><dt className="inline font-semibold">Incidencias abiertas: </dt><dd className="inline">{summary.incidents}</dd></div>
        <div><dt className="inline font-semibold">Intervención manual: </dt><dd className="inline">{summary.manualIntervention ? "Sí" : "No"}</dd></div>
      </dl>
      {view.nextStep && (
        <p className={`admin-claim-wizard-note ${view.humanActionRequired ? "font-semibold" : ""}`} data-claim-logistics-next>
          {view.humanActionRequired ? "Acción recomendada: " : "Próximo paso: "}{view.nextStep}
        </p>
      )}

      {canManage && !requestKind && (view.methodOptions.length > 0 || view.canRetryExchange || view.canAuthorizeResend) && (
        <div className="grid gap-2" data-claim-logistics-methods>
          {view.methodOptions.map((option) => (
            <div key={option.direction} className="grid gap-1" data-claim-logistics-method={option.direction}>
              <AdminSecondaryButton disabled={pending !== null} onClick={() => void openRequest(option.direction)}>
                {option.label}{view.methodChangeRequiresReason ? " (cambio de método, requiere motivo)" : ""}
              </AdminSecondaryButton>
              <p className="admin-claim-wizard-note">{option.description}</p>
            </div>
          ))}
          {view.canRetryExchange && (
            <AdminSecondaryButton disabled={pending !== null} onClick={() => void openRequest("cambio")}>Reintentar el cambio en sucursal</AdminSecondaryButton>
          )}
          {view.canAuthorizeResend && (
            <AdminButton variant="primary" disabled={pending !== null} onClick={() => void openRequest("reemplazo")}>Autorizar reemplazo y enviarlo a sucursal</AdminButton>
          )}
        </div>
      )}

      {canManage && requestKind && (
        <div className="grid gap-2 text-xs text-white/80" data-claim-logistics-request={requestKind}>
          <p className="font-semibold text-white">
            {requestKind === "cambio" ? "Cambio directo por sucursal" : requestKind === "devolucion" ? "Retiro + revisión por sucursal" : "Reenvío del reemplazo a sucursal"}
          </p>
          <p className="admin-claim-wizard-note">
            {selectedBranch ? `Sucursal: ${branchLine(selectedBranch)}` : "Elegí la sucursal Andreani donde el cliente va a hacer la operación."}
          </p>
          <div className="flex gap-2">
            <input className={adminControlClassName} value={branchQuery} maxLength={80} placeholder="Buscar por localidad, dirección o sucursal"
              aria-label="Buscar sucursal Andreani" onChange={(event) => setBranchQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchBranches() } }} />
            <AdminSecondaryButton disabled={pending !== null || branchQuery.trim().length < 3} onClick={() => void searchBranches()}>
              {pending === "branches" ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
              Buscar
            </AdminSecondaryButton>
          </div>
          {branchResults && (
            branchResults.length === 0
              ? <p className="admin-claim-wizard-note">No encontramos sucursales con esa búsqueda.</p>
              : (
                <ul className="grid max-h-56 gap-1 overflow-y-auto" data-claim-logistics-branches>
                  {branchResults.map((branch) => (
                    <li key={branch.id}>
                      <AdminSecondaryButton disabled={pending !== null} onClick={() => { setSelectedBranch(branch); setRequestConfirming(false) }}>
                        {selectedBranch?.id === branch.id ? "✓ " : ""}{branchLine(branch)}
                      </AdminSecondaryButton>
                    </li>
                  ))}
                </ul>
              )
          )}
          {(reasonRequired || requestKind !== "reemplazo") && (
            <label className="grid gap-1">
              <span className="font-semibold">Motivo{reasonRequired ? " (obligatorio, mínimo 10 caracteres)" : " (opcional)"}</span>
              <textarea className={adminControlClassName} value={requestNotes} onChange={(event) => setRequestNotes(event.target.value)} maxLength={1000} rows={2} />
            </label>
          )}
          {requestConfirming && selectedBranch && (
            <p role="alert" className="font-semibold text-amber-200">
              {requestKind === "reemplazo"
                ? `Vas a autorizar el reemplazo hacia ${selectedBranch.name}: después se reserva el stock y se genera el envío. ¿Confirmás?`
                : `El método queda registrado y auditado con la sucursal ${selectedBranch.name}; una vez generada la operación Andreani sólo se cambia con motivo. ¿Confirmás?`}
            </p>
          )}
          <div className="flex gap-2">
            <AdminButton variant="primary" onClick={submitRequest}
              disabled={pending !== null || !selectedBranch || (reasonRequired && requestNotes.trim().length < 10)}>
              {pending === "request" ? "Guardando..." : requestConfirming ? "Sí, confirmar" : "Continuar"}
            </AdminButton>
            <AdminSecondaryButton disabled={pending !== null} onClick={() => setRequestKind(null)}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}

      {leg && (
        <div className="grid gap-1 text-xs text-white/75" data-claim-logistics-leg={leg.direction}>
          <p className="font-semibold text-white">{leg.title} · {leg.statusLabel}{leg.legacy ? " · operación heredada" : ""}</p>
          {leg.outcomeLabel && <p className="font-semibold text-white">{leg.outcomeLabel}</p>}
          <dl className="grid gap-1 sm:grid-cols-2">
            {leg.modalityLabel && <div><dt className="inline font-semibold">Contrato: </dt><dd className="inline">{leg.modalityLabel}</dd></div>}
            {leg.tracking && <div><dt className="inline font-semibold">Seguimiento: </dt><dd className="inline">{leg.tracking}</dd></div>}
            {leg.andreaniEstado && <div><dt className="inline font-semibold">Estado Andreani: </dt><dd className="inline">{leg.andreaniEstado}</dd></div>}
            {leg.custodySince && <div><dt className="inline font-semibold">En sucursal desde (según Andreani): </dt><dd className="inline">{new Date(leg.custodySince).toLocaleDateString("es-AR")}</dd></div>}
            <div><dt className="inline font-semibold">Costo: </dt><dd className="inline">{leg.costLabel}</dd></div>
          </dl>
          {leg.review && <p role="alert" className="font-semibold text-amber-200">Requiere revisión: {leg.review}. El avance automático está congelado.</p>}
          {leg.incident && <p role="status" className="font-semibold text-amber-200">{leg.incident}</p>}
          {leg.error && <p role="alert" className="font-semibold text-red-200">{leg.error}</p>}
        </div>
      )}

      {view.items.length > 0 && (
        <ul className="grid gap-1.5 text-xs text-white/75" data-claim-logistics-units>
          {view.items.map((item) => (
            <li key={item.orderItemId} className="rounded-md border border-white/10 px-2 py-1.5">
              <p className="font-semibold text-white">{itemLabel(item.orderItemId)}{item.incident ? ` · Incidencia: ${item.incident}` : ""}</p>
              <p>Original: {locationSummary(item.original)}</p>
              {Object.keys(item.replacement).length > 0 && <p>Nuevo: {locationSummary(item.replacement)}</p>}
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert" className="text-xs font-semibold text-red-200">{error}</p>}

      {canManage && leg && (
        <div className="flex flex-wrap gap-2">
          {leg.canCreate && (
            <AdminButton variant="primary" disabled={pending !== null} onClick={() => void post("create", { action: "create", shipmentId: leg.id })}>
              {pending === "create" ? <LoaderCircle className="size-4 animate-spin" /> : <Truck className="size-4" />}
              {pending === "create" ? "Generando..." : leg.direction === "cambio" ? "Generar cambio en sucursal" : leg.direction === "devolucion" ? "Generar retiro por sucursal" : "Generar envío a sucursal"}
            </AdminButton>
          )}
          {leg.canSync && (
            <AdminSecondaryButton disabled={pending !== null} onClick={() => void post("sync", { action: "sync", shipmentId: leg.id })}>
              {pending === "sync" ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {pending === "sync" ? "Consultando..." : "Consultar seguimiento"}
            </AdminSecondaryButton>
          )}
          {leg.labelAvailable && (
            <AdminSecondaryButton disabled={pending !== null} onClick={() => void openLabel(leg.id)}>
              {pending === "label" ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
              Etiqueta
            </AdminSecondaryButton>
          )}
          {leg.canResolveReview && <AdminButton variant="primary" disabled={pending !== null} onClick={() => { setLegForm("review_resolve"); setLegNotes("") }}>Registrar revisión del evento</AdminButton>}
          {leg.canReconcile && <AdminSecondaryButton disabled={pending !== null} onClick={() => { setLegForm("reconcile"); setLegNotes("") }}>Conciliar con Andreani</AdminSecondaryButton>}
          {leg.canMarkNotCompleted && <AdminDangerButton disabled={pending !== null} onClick={() => { setLegForm("exchange_not_completed"); setLegNotes("") }}>Cambio no completado</AdminDangerButton>}
          {leg.canCancel && <AdminDangerButton disabled={pending !== null} onClick={() => { setLegForm("cancel"); setLegNotes("") }}>Cancelar operación</AdminDangerButton>}
        </div>
      )}

      {canManage && leg && legForm && (
        <div className="grid gap-2 text-xs text-white/80" data-claim-logistics-leg-form={legForm}>
          {legForm === "reconcile" && (
            <>
              <label className="grid gap-1">
                <span className="font-semibold">¿La orden existe en Andreani?</span>
                <select className={adminControlClassName} value={resolution} onChange={(event) => setResolution(event.target.value as "created" | "not_created")}>
                  <option value="created">Sí, existe (vincular; se verifica en Andreani)</option>
                  <option value="not_created">No existe (permitir generarla de nuevo)</option>
                </select>
              </label>
              {resolution === "created" && (
                <label className="grid gap-1">
                  <span className="font-semibold">Número de orden Andreani</span>
                  <input className={adminControlClassName} value={envioId} onChange={(event) => setEnvioId(event.target.value)} maxLength={80} />
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
            <span className="font-semibold">{legForm === "reconcile" ? "Cómo lo confirmaste" : "Motivo"} (mínimo {legNotesMin} caracteres)</span>
            <textarea className={adminControlClassName} value={legNotes} onChange={(event) => setLegNotes(event.target.value)} maxLength={1000} rows={2} />
          </label>
          <div className="flex gap-2">
            <AdminButton variant="primary"
              disabled={pending !== null || legNotes.trim().length < legNotesMin || (legForm === "reconcile" && resolution === "created" && !envioId.trim())}
              onClick={() => void post(legForm, {
                action: legForm, shipmentId: leg.id, notes: legNotes.trim(),
                ...(legForm === "reconcile" ? { resolution, envioId: envioId.trim() } : {}),
              }, () => setLegForm(null))}>
              {pending === legForm ? "Guardando..." : "Confirmar"}
            </AdminButton>
            <AdminSecondaryButton disabled={pending !== null} onClick={() => setLegForm(null)}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}

      {canManage && view.unitActions.length > 0 && !unitAction && (
        <label className="grid gap-1 text-xs text-white/80">
          <span className="font-semibold">Recepción e inspección de unidades</span>
          <select className={adminControlClassName} value="" onChange={(event) => {
            const option = view.unitActions[Number(event.target.value)]
            if (option) openUnitAction(option)
          }}>
            <option value="">Elegí una acción…</option>
            {view.unitActions.map((option, index) => (
              <option key={`${option.action}-${option.role}-${option.orderItemId}-${option.label}`} value={index}>
                {option.label} · {itemLabel(option.orderItemId)}
              </option>
            ))}
          </select>
        </label>
      )}

      {canManage && unitAction && (
        <div className="grid gap-2 text-xs text-white/80" data-claim-logistics-unit-form={unitAction.action}>
          <p className="font-semibold text-white"><PackageCheck className="mr-1 inline size-4" aria-hidden="true" />{unitAction.label} · {itemLabel(unitAction.orderItemId)}</p>
          {!unitAction.action.startsWith("incident") && (
            <label className="grid gap-1">
              <span className="font-semibold">Unidades (máximo {unitAction.max})</span>
              <input type="number" min={1} max={unitAction.max} className={adminControlClassName} value={quantity}
                onChange={(event) => setQuantity(Math.max(1, Math.min(unitAction.max, Math.trunc(Number(event.target.value) || 1))))} />
            </label>
          )}
          {unitAction.action === "inspect_replacement" && (
            <label className="grid gap-1">
              <span className="font-semibold">Vuelven a stock vendible (el resto se da de baja; paquete vacío o producto distinto nunca vuelven)</span>
              <input type="number" min={0} max={quantity} className={adminControlClassName} value={Math.min(restock, quantity)}
                onChange={(event) => setRestock(Math.max(0, Math.min(quantity, Math.trunc(Number(event.target.value) || 0))))} />
            </label>
          )}
          {(unitAction.action.startsWith("arrival") || incidentRequired) && (
            <label className="grid gap-1">
              <span className="font-semibold">{incidentRequired ? "Resultado de la inspección" : "Al abrir el paquete"}</span>
              <select className={adminControlClassName} value={incidentType} onChange={(event) => setIncidentType(event.target.value as ClaimIncidentType | "")}>
                {!incidentRequired && <option value="">Sin novedad (queda pendiente de inspección)</option>}
                {incidentRequired && <option value="">Elegí la incidencia…</option>}
                {INCIDENT_TYPES.map((type) => <option key={type} value={type}>{CLAIM_INCIDENT_LABELS[type]}</option>)}
              </select>
            </label>
          )}
          <label className="grid gap-1">
            <span className="font-semibold">Observación{notesMin ? ` (mínimo ${notesMin} caracteres)` : " (opcional)"}</span>
            <textarea className={adminControlClassName} value={unitNotes} onChange={(event) => setUnitNotes(event.target.value)} maxLength={1000} rows={2} />
          </label>
          {confirming && <p role="alert" className="font-semibold text-amber-200">Esta acción cede o cierra una regla del circuito y queda auditada con tu usuario y el motivo. ¿Confirmás?</p>}
          <div className="flex gap-2">
            <AdminButton variant="primary" disabled={pending !== null || unitNotes.trim().length < notesMin || (incidentRequired && !incidentType)} onClick={submitUnitAction}>
              {pending === "unit" ? "Guardando..." : confirming ? "Sí, confirmar" : "Registrar"}
            </AdminButton>
            <AdminSecondaryButton disabled={pending !== null} onClick={() => setUnitAction(null)}>Cancelar</AdminSecondaryButton>
          </div>
        </div>
      )}
    </section>
  )
}
