"use client"

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { ChevronDown, Minus, Plus, Repeat2, X } from "lucide-react"
import { useAuth } from "@/context/auth-context"
import { getAdminCapabilities } from "@/lib/admin/admin-capabilities"
import { activateModalFocus } from "@/lib/admin/modal-focus"
import { lockDocumentScroll } from "@/lib/admin/scroll-lock"
import { AdminRequestError } from "@/lib/admin/request-error"
import { supabase } from "@/lib/supabase/client"
import type { RegisteredReplacement, ReplacementLoadState } from "@/lib/orders/claim-replacement-flow"
import type { SupabasePedido } from "@/lib/supabase/types"
import { HelpTip } from "@/components/claims/help-tip"
import { getCuentaItemImage } from "@/lib/account/account-utils"
import { AdminSecondaryButton } from "../../components/admin-controls"

// Variantes activas de los productos del pedido (el servidor no ofrece otras).
type Variant = { id: number; producto_id: number; nombre: string; sku: string | null; stock: number; productos: { nombre: string } | { nombre: string }[] }
type Replacement = RegisteredReplacement & { id: number; original_order_id: number; claim_id: number | null; replacement_variant_id: number; reason: string; unit_cost: number | null; created_at: string; notes: string | null }
type ReplacementData = { replacements: Replacement[]; variants: Variant[] }

async function requestReplacements(orderId: number, body?: Record<string, unknown>) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error("Tu sesión venció. Volvé a iniciar sesión.")
  const response = await fetch(`/api/admin/pedidos/${orderId}/replacements`, {
    method: body ? "POST" : "GET", signal: AbortSignal.timeout(25_000), cache: "no-store",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  if (!response.ok) throw new AdminRequestError(response.status, data.error || "No se pudo completar la operación. Recargá los datos.")
  if (!body && (!Array.isArray(data.replacements) || !Array.isArray(data.variants))) throw new Error("No se pudieron verificar los reemplazos. Reintentá.")
  return data as ReplacementData
}

/** Pedido externo de apertura del formulario (paso 2 de "Gestionar reclamo"). */
export interface ReplacementOpenRequest {
  nonce: number
  orderItemId: number | null
}

interface OrderReplacementsProps {
  pedido: SupabasePedido
  onUpdated: () => Promise<void>
  hidePanel?: boolean
  /** Informa los reemplazos ya cargados (null si no se pudieron cargar) para mostrar el progreso del reclamo sin otro fetch. */
  onReplacementsChange?: (replacements: RegisteredReplacement[] | null, state: ReplacementLoadState) => void
  /** Cada nonce nuevo abre este mismo formulario (con el ítem reclamado preseleccionado si llega). */
  openRequest?: ReplacementOpenRequest | null
}

export function OrderReplacements(props: OrderReplacementsProps) {
  const { user } = useAuth()
  const allowed = getAdminCapabilities(user?.rol).canManageReplacements
  return allowed ? <OrderReplacementManager {...props} /> : null
}

const variantProductName = (row: Variant) => (Array.isArray(row.productos) ? row.productos[0] : row.productos)?.nombre

const VARIANT_HELP =
  "Elegí la variante del mismo producto que se descontará del stock y se enviará al cliente. Si el cliente quiere otro producto diferente, gestioná la devolución mediante Nota de Crédito / saldo a favor."

export function OrderReplacementManager({ pedido, onUpdated, onReplacementsChange, openRequest = null, hidePanel = false }: OrderReplacementsProps) {
  const [data, setData] = useState<ReplacementData | null>(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [itemId, setItemId] = useState("")
  const [variantId, setVariantId] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [warranty, setWarranty] = useState(false)
  const [reason, setReason] = useState("")
  const attempt = useRef<{ key: string; payload: Record<string, unknown> } | null>(null)
  const inFlight = useRef(false)
  const loadVersion = useRef({ value: 0 })
  const onReplacementsChangeRef = useRef(onReplacementsChange)
  useEffect(() => { onReplacementsChangeRef.current = onReplacementsChange })
  const load = useCallback(async () => {
    const version = ++loadVersion.current.value
    setLoading(true); setError("")
    onReplacementsChangeRef.current?.(null, "loading")
    try {
      const next = await requestReplacements(pedido.id)
      if (version === loadVersion.current.value) {
        setData(next)
        onReplacementsChangeRef.current?.(next.replacements, "ready")
      }
    }
    catch (cause) { if (version === loadVersion.current.value) {
      setData(null); setError(cause instanceof Error ? cause.message : "No se pudieron cargar los reemplazos.")
      onReplacementsChangeRef.current?.(null, "error")
    } }
    finally { if (version === loadVersion.current.value) setLoading(false) }
  }, [pedido.id])
  useEffect(() => {
    const generation = loadVersion.current
    onReplacementsChangeRef.current?.(null, "loading")
    const timer = setTimeout(() => void load(), 300)
    return () => { clearTimeout(timer); generation.value++; onReplacementsChangeRef.current?.(null, "loading") }
  }, [load])
  // Única apertura del formulario: la usan el botón "Registrar reemplazo" de la
  // sección y el paso 2 del reclamo (vía openRequest). Si llega el ítem
  // reclamado y todavía no se eligió uno, se preselecciona.
  const openReplacementModal = useCallback((orderItemId: number | null) => {
    setOpen(true); setConfirm(false)
    if (orderItemId !== null && !attempt.current) setItemId((current) => current || String(orderItemId))
  }, [])
  const handledOpenNonce = useRef(openRequest?.nonce ?? 0)
  useEffect(() => {
    if (!openRequest || openRequest.nonce === handledOpenNonce.current) return
    handledOpenNonce.current = openRequest.nonce
    openReplacementModal(openRequest.orderItemId)
  }, [openRequest, openReplacementModal])
  const orderItems = pedido.orden_items ?? []
  const openChangeClaims = (pedido.order_claims ?? []).filter((claim) =>
    claim.resolution === "cambio_producto" && !["cerrado", "rechazado"].includes(claim.status))
  // Ítem original fijo (sin selector) cuando no hay nada que elegir: pedido de
  // un solo ítem, o un único ítem reclamado en los cambios abiertos.
  const claimedItemIds = [...new Set(openChangeClaims.flatMap((claim) =>
    (claim.affected_items ?? []).filter((affected) => affected.quantity > 0).map((affected) => affected.order_item_id)))]
  const fixedItem = orderItems.length === 1
    ? orderItems[0]
    : claimedItemIds.length === 1 ? orderItems.find((candidate) => candidate.id === claimedItemIds[0]) : undefined
  const fixedItemImage = fixedItem ? getCuentaItemImage(fixedItem) : null
  const item = fixedItem ?? orderItems.find((candidate) => candidate.id === Number(itemId))
  const matchingClaims = openChangeClaims.filter((claim) =>
    claim.affected_items?.some((affected) => affected.order_item_id === item?.id && affected.quantity > 0))
  // Reemplazo = mismo producto: sólo variantes del producto del ítem original.
  const productVariants = item ? (data?.variants ?? []).filter((candidate) => Number(candidate.producto_id) === Number(item.producto_id)) : []
  const originalVariant = item?.variante_id ? productVariants.find((candidate) => candidate.id === item.variante_id) : undefined
  // Por defecto: la única variante, o la misma que compró el cliente si tiene
  // stock. Nunca se cambia sola a otra variante.
  const defaultVariant = productVariants.length === 1
    ? productVariants[0]
    : originalVariant && originalVariant.stock > 0 ? originalVariant : undefined
  const variant = variantId ? productVariants.find((candidate) => candidate.id === Number(variantId)) : defaultVariant
  const used = data?.replacements.filter((row) => row.original_order_item_id === item?.id).reduce((sum, row) => sum + row.quantity, 0) || 0
  const received = Number(item?.return_restocked_quantity || 0) + Number(item?.return_written_off_quantity || 0)
  const availableOriginal = Math.max(0, Math.min(Number(item?.cantidad || 0), warranty ? Number(item?.cantidad || 0) : received) - used)
  const count = Number(quantity)
  const valid = Boolean(item && variant && matchingClaims.length <= 1 && Number.isInteger(count) && count > 0 && count <= availableOriginal && count <= variant.stock && reason.trim().length >= 10 && !loading)
  const submit = async () => {
    if (inFlight.current || (!attempt.current && !valid)) return
    if (!attempt.current && item && variant) attempt.current = { key: crypto.randomUUID(), payload: {
      orderItemId: item.id, replacementVariantId: variant.id, quantity: count,
      ...(matchingClaims.length === 1 ? { claimId: matchingClaims[0].id } : {}),
      reason: warranty ? "garantia" : item.variante_id === variant.id ? "mismo_producto" : "otra_variante", notes: reason.trim(),
    } }
    if (!attempt.current) return
    inFlight.current = true; setSaving(true); setError("")
    try {
      await requestReplacements(pedido.id, { ...attempt.current.payload, idempotencyKey: attempt.current.key })
      attempt.current = null; setOpen(false); setConfirm(false)
      await load(); await onUpdated()
    } catch (cause) {
      if (cause instanceof AdminRequestError && [400, 403, 409].includes(cause.status)) { attempt.current = null; setConfirm(false) }
      setError(cause instanceof Error ? cause.message : "No se pudo registrar. Reintentá la misma operación.")
    }
    finally { setSaving(false); inFlight.current = false }
  }

  // Sólo presentación: motivo por el que "Revisar reemplazo" está deshabilitado,
  // en el mismo orden que el formulario (mismas condiciones que `valid`).
  const quantityLimit = Math.min(availableOriginal, variant?.stock || 0)
  const variantsLoaded = Boolean(data)
  const noVariants = Boolean(item) && variantsLoaded && productVariants.length === 0
  const productOutOfStock = productVariants.length > 0 && productVariants.every((candidate) => candidate.stock <= 0)
  // La variante que compró el cliente no puede enviarse: se avisa y el admin
  // elige otra del mismo producto (no se reemplaza sola).
  const originalNotice = !item?.variante_id || !variantsLoaded || productVariants.length <= 1 || productOutOfStock
    ? null
    : !originalVariant
      ? "La variante original ya no está disponible. Elegí otra variante del mismo producto."
      : originalVariant.stock <= 0
        ? `La variante original (${originalVariant.nombre}) no tiene stock disponible. Elegí otra variante del mismo producto.`
        : null
  const noVariantsMessage = "Este producto no tiene variantes activas para realizar el reemplazo."
  const productOutOfStockMessage = "No hay stock disponible de este producto para realizar el reemplazo."
  const variantOutOfStockMessage = "Esta variante no tiene stock disponible."
  const missing = !item
    ? "Seleccioná el ítem original."
    : !variantsLoaded
      ? "Cargando datos…"
      : matchingClaims.length > 1
        ? "Este ítem tiene más de un reclamo de cambio abierto."
        : noVariants
          ? noVariantsMessage
          : productOutOfStock
            ? productOutOfStockMessage
            : reason.trim().length < 10
              ? "Escribí el motivo del reemplazo (mínimo 10 caracteres)."
              : !variant
                ? "Seleccioná la variante a enviar."
                : variant.stock <= 0
                  ? variantOutOfStockMessage
                  : !(Number.isInteger(count) && count > 0)
                    ? "Indicá una cantidad válida."
                    : count > availableOriginal
                      ? "La cantidad supera las unidades pendientes de reemplazo."
                      : count > variant.stock
                        ? "No hay stock suficiente de la variante elegida."
                        : loading
                          ? "Cargando datos…"
                          : null
  const primaryDisabled = saving || (!attempt.current && !valid)
  const formLocked = saving || confirm || Boolean(attempt.current)
  const closeModal = () => { if (!saving) setOpen(false) }
  const stepQuantity = (delta: number) => {
    const next = (Number.isInteger(count) ? count : 0) + delta
    setQuantity(String(Math.max(1, quantityLimit > 0 ? Math.min(next, quantityLimit) : next)))
  }

  return <section id={`order-replacements-${pedido.id}`} className={hidePanel ? "" : "my-3 rounded-xl border border-white/15 p-4"}>
    {hidePanel && error && <p role="alert" className="m-3 text-sm text-red-200">{error} <button type="button" onClick={() => void load()} className="underline">Recargar reemplazos</button></p>}
    {!hidePanel && <>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Reemplazos del pedido</h3><AdminSecondaryButton onClick={() => openReplacementModal(null)}>Registrar reemplazo</AdminSecondaryButton></div>
    {loading && <p role="status">Cargando reemplazos…</p>}
    {error && <p role="alert" className="my-2 text-red-200">{error} <button type="button" onClick={() => void load()} className="underline">Recargar datos</button></p>}
    {!loading && !error && data?.replacements.length === 0 && <p className="mt-2 text-sm">Todavía no hay reemplazos registrados.</p>}
    <ul className="mt-3 space-y-2 text-sm">{data?.replacements.map((row) => <li key={row.id} className="rounded border border-white/10 p-2">{new Date(row.created_at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })} · {row.quantity} unidades · {row.reason === "garantia" ? "Garantía" : "Cambio"} · Variante #{row.replacement_variant_id}<p>{row.notes}</p><p>Costo económico registrado: {row.unit_cost == null ? "No disponible" : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(row.unit_cost * row.quantity)}</p><p>Salida de stock registrada. Coordiná la entrega del reemplazo; esto no crea un envío ni reutiliza la etiqueta del pedido original.</p></li>)}</ul>
    </>}
    <ReplacementDialog
      open={open}
      title={`Reemplazo del pedido #${pedido.id}`}
      onClose={closeModal}
      footer={
        <>
          {missing && missing !== noVariantsMessage && missing !== productOutOfStockMessage && missing !== variantOutOfStockMessage && !attempt.current && !confirm && !saving && (
            <p className="admin-replacement-modal__missing" id={`replacement-missing-${pedido.id}`}>{missing}</p>
          )}
          <div className="admin-replacement-modal__actions">
            <button type="button" disabled={saving} onClick={() => setOpen(false)} className="admin-replacement-modal__button is-secondary">Cancelar</button>
            <button
              type="button"
              disabled={primaryDisabled}
              aria-describedby={missing && !attempt.current && !confirm ? `replacement-missing-${pedido.id}` : undefined}
              onClick={() => { if (confirm || attempt.current) void submit(); else setConfirm(true) }}
              className="admin-replacement-modal__button is-primary"
            >
              {saving ? "Registrando…" : confirm || attempt.current ? "Confirmar retiro de stock" : "Revisar reemplazo"}
            </button>
          </div>
        </>
      }
    >
      {error && <p role="alert" className="admin-replacement-modal__alert">{error}</p>}
      <fieldset disabled={formLocked} className="admin-replacement-modal__form">
        <section className="admin-replacement-modal__section admin-replacement-modal__original" aria-labelledby={`replacement-original-${pedido.id}`}>
          <p className="admin-replacement-modal__section-title" id={`replacement-original-${pedido.id}`}>Producto original</p>
          {fixedItem ? (
            <div className="admin-replacement-modal__selection" data-testid="replacement-original-item">
              {fixedItemImage && <span className="admin-replacement-modal__thumb" style={{ backgroundImage: `url(${JSON.stringify(fixedItemImage)})` }} aria-hidden="true" />}
              <div>
                <p className="admin-replacement-modal__selection-name">{fixedItem.productos?.nombre ?? (originalVariant && variantProductName(originalVariant)) ?? "Producto"}</p>
                <p className="admin-replacement-modal__selection-meta">
                  {(fixedItem.producto_variantes?.nombre ?? originalVariant?.nombre) && <span>{fixedItem.producto_variantes?.nombre ?? originalVariant?.nombre}</span>}
                  {originalVariant?.sku && <span>SKU {originalVariant.sku}</span>}
                  <span>Vendió {fixedItem.cantidad}</span>
                </p>
              </div>
            </div>
          ) : (
            <label className="admin-replacement-modal__field">
              <FieldLabel text="Ítem original" help="Seleccioná el producto original del pedido que estás reemplazando." />
              <SelectControl value={itemId} onChange={(value) => { setItemId(value); setVariantId("") }}>
                <option value="">Elegir producto vendido</option>
                {orderItems.map((row) => <option key={row.id} value={row.id}>{row.productos?.nombre} · {row.producto_variantes?.nombre} · Vendió {row.cantidad}</option>)}
              </SelectControl>
            </label>
          )}
          <dl className="admin-replacement-modal__stats" aria-label="Unidades del ítem original">
            <div className="admin-replacement-modal__stat"><dt>Recibimos</dt><dd>{received}</dd></div>
            <div className="admin-replacement-modal__stat"><dt>Ya reemplazadas</dt><dd>{used}</dd></div>
            <div className={`admin-replacement-modal__stat ${availableOriginal > 0 ? "is-positive" : "is-empty"}`}><dt>Pendientes de reemplazo</dt><dd>{availableOriginal}</dd></div>
          </dl>
          <div className="admin-replacement-modal__check-row">
            <label className="admin-replacement-modal__check">
              <input type="checkbox" checked={warranty} onChange={(event) => setWarranty(event.target.checked)} />
              <span>Continuar sin recepción previa</span>
            </label>
            <HelpTip label="Continuar sin recepción previa">
              Usá esta opción sólo cuando BEYONIX autorice enviar el reemplazo sin esperar la devolución física del producto original.
            </HelpTip>
          </div>
        </section>

        <section className="admin-replacement-modal__section admin-replacement-modal__reason">
          <label className="admin-replacement-modal__field">
            <FieldLabel text="Motivo del reemplazo" help="Explicá brevemente por qué se entrega una nueva unidad. Este dato queda registrado internamente." />
            <textarea
              className="admin-replacement-modal__control admin-replacement-modal__textarea"
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-describedby={`replacement-reason-helper-${pedido.id}`}
            />
            <span className="admin-replacement-modal__helper" id={`replacement-reason-helper-${pedido.id}`}>Mínimo 10 caracteres.</span>
          </label>
        </section>

        <section className="admin-replacement-modal__section admin-replacement-modal__options">
          <div className="admin-replacement-modal__variant-column">
          {productVariants.length > 1 ? (
            <label className="admin-replacement-modal__field">
              <FieldLabel text="Variante a enviar" help={VARIANT_HELP} />
              <SelectControl value={variant ? String(variant.id) : ""} onChange={setVariantId}>
                <option value="">Elegir variante</option>
                {productVariants.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.nombre}{row.id === item?.variante_id ? " (original)" : ""}{row.sku ? ` · SKU ${row.sku}` : ""} · {row.stock > 0 ? `Stock ${row.stock}` : "Sin stock"}
                  </option>
                ))}
              </SelectControl>
            </label>
          ) : (
            <div className="admin-replacement-modal__field">
              <FieldLabel text="Variante a enviar" help={VARIANT_HELP} />
              {!item ? (
                <p className="admin-replacement-modal__helper">Elegí el ítem original para ver sus variantes.</p>
              ) : !variantsLoaded ? (
                <p className="admin-replacement-modal__helper">Cargando variantes…</p>
              ) : noVariants ? (
                <p className="admin-replacement-modal__notice" role="note">{noVariantsMessage}</p>
              ) : null}
            </div>
          )}
          {variant && (
            <div className="admin-replacement-modal__selection" aria-live="polite" data-testid="replacement-variant">
              <p className="admin-replacement-modal__selection-name">{variant.nombre}</p>
              <p className="admin-replacement-modal__selection-meta">
                {variant.sku && <span>SKU {variant.sku}</span>}
                <span>{variant.stock > 0 ? `Stock ${variant.stock}` : "Sin stock"}</span>
              </p>
            </div>
          )}
          {productOutOfStock ? (
            <p className="admin-replacement-modal__notice" role="note">{productOutOfStockMessage}</p>
          ) : variant && variant.stock <= 0 ? (
            <p className="admin-replacement-modal__notice" role="note">{variantOutOfStockMessage}</p>
          ) : originalNotice ? (
            <p className="admin-replacement-modal__notice" role="note">{originalNotice}</p>
          ) : null}
          </div>
          <div className="admin-replacement-modal__field admin-replacement-modal__quantity-field">
            <FieldLabel text="Cantidad" help="Indicá cuántas unidades vas a entregar como reemplazo." htmlFor={`replacement-quantity-${pedido.id}`} />
            <span className="admin-replacement-modal__quantity">
              <button type="button" aria-label="Restar una unidad" onClick={() => stepQuantity(-1)} disabled={formLocked || count <= 1} className="admin-replacement-modal__quantity-button"><Minus aria-hidden="true" /></button>
              <input
                id={`replacement-quantity-${pedido.id}`}
                className="admin-replacement-modal__control admin-replacement-modal__quantity-input"
                type="number"
                min={1}
                max={quantityLimit}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
              <button type="button" aria-label="Sumar una unidad" onClick={() => stepQuantity(1)} disabled={formLocked || quantityLimit <= 0 || count >= quantityLimit} className="admin-replacement-modal__quantity-button"><Plus aria-hidden="true" /></button>
            </span>
          </div>
        </section>

        {!noVariants && <section className={`admin-replacement-modal__stock ${variant ? "" : "is-empty"}`} aria-live="polite">
          <div className="admin-replacement-modal__stock-head">
            <p className="admin-replacement-modal__section-title">Stock</p>
            <HelpTip label="Stock">El stock se valida nuevamente al confirmar. El sistema registra también el costo histórico del reemplazo.</HelpTip>
          </div>
          {variant ? (
            <div className="admin-replacement-modal__stock-grid">
              <div className="admin-replacement-modal__stock-tile"><p>Stock disponible</p><strong>{variant.stock} {variant.stock === 1 ? "unidad" : "unidades"}</strong></div>
              <div className="admin-replacement-modal__stock-tile is-result"><p>Stock después del reemplazo</p><strong>{Number.isInteger(count) ? `${variant.stock - count} ${variant.stock - count === 1 ? "unidad" : "unidades"}` : "—"}</strong></div>
            </div>
          ) : (
            <p className="admin-replacement-modal__stock-empty">Seleccioná la variante a enviar para calcular el stock.</p>
          )}
        </section>}
      </fieldset>
      {confirm && <div role="status" className="admin-replacement-modal__confirm">Vas a retirar {count} unidades de SKU {variant?.sku || variant?.nombre} para reemplazar {count} unidades del pedido #{pedido.id}. No se genera un cobro ni un envío automático.{!attempt.current && <button className="admin-replacement-modal__link" type="button" onClick={() => setConfirm(false)}>Corregir</button>}</div>}
      {attempt.current && <p className="admin-replacement-modal__pending">Hay un intento pendiente de confirmar. El reintento conserva la misma operación para no descontar stock dos veces.</p>}
    </ReplacementDialog>
  </section>
}

function FieldLabel({ text, help, htmlFor }: { text: string; help: string; htmlFor?: string }) {
  const content = <span className="admin-replacement-modal__label-text">{text}</span>
  return (
    <span className="admin-replacement-modal__label">
      {htmlFor ? <label htmlFor={htmlFor}>{content}</label> : content}
      <HelpTip label={text}>{help}</HelpTip>
    </span>
  )
}

function SelectControl({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <span className="admin-replacement-modal__select">
      <select className="admin-replacement-modal__control" value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <ChevronDown className="admin-replacement-modal__select-icon" aria-hidden="true" />
    </span>
  )
}

/**
 * Presentación del formulario de reemplazo: se monta con Portal en
 * document.body (fuera del detalle de pedido y sus reglas contextuales), con
 * estilos propios admin-replacement-modal__* para Light/Dark. Foco atrapado y
 * Escape con el mismo helper que AdminModal (activateModalFocus); scroll del
 * documento bloqueado mientras está abierto (lockDocumentScroll).
 *
 * El posicionamiento (overlay fixed, centrado) y la superficie base van
 * inline: si la hoja de estilos servida no trae el bloque del modal (deploy
 * con CSS desfasado), el Portal no puede caer al final de <body> como bloque
 * en flujo, agrandar el documento ni arrastrar el scroll con el foco.
 */
const backdropLayout: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1200,
  display: "flex",
  overflowX: "hidden",
  overflowY: "auto",
  overscrollBehavior: "contain",
}
const dialogLayout: CSSProperties = {
  position: "relative",
  width: "min(100%, 46rem)",
  margin: "auto",
  background: "var(--replacement-modal-bg, #0b1724)",
  color: "var(--replacement-modal-text, #cbd5e1)",
}
function ReplacementDialog({
  open,
  title,
  onClose,
  footer,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })
  useEffect(() => {
    if (!open || !dialogRef.current) return
    // Primero el bloqueo (guarda la posición) y al cerrar se libera último,
    // después de devolver el foco al botón que abrió el modal.
    const unlockScroll = lockDocumentScroll()
    const releaseFocus = activateModalFocus(dialogRef.current, () => onCloseRef.current())
    return () => { releaseFocus(); unlockScroll() }
  }, [open])

  if (!open || typeof document === "undefined") return null

  return createPortal(
    <div className="admin-replacement-modal__backdrop" style={backdropLayout} role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-replacement-title"
        tabIndex={-1}
        className="admin-replacement-modal"
        style={dialogLayout}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="admin-replacement-modal__header">
          <span className="admin-replacement-modal__icon" aria-hidden="true"><Repeat2 /></span>
          <div className="admin-replacement-modal__heading">
            <p className="admin-replacement-modal__eyebrow">Cambio de producto</p>
            <h2 id="order-replacement-title" className="admin-replacement-modal__title">{title}</h2>
            <p className="admin-replacement-modal__subtitle">Registrá qué unidad recibe el cliente y descontala del stock.</p>
          </div>
          <button type="button" aria-label="Cerrar" onClick={onClose} className="admin-replacement-modal__close"><X aria-hidden="true" /></button>
        </header>
        <div className="admin-replacement-modal__body">{children}</div>
        <footer className="admin-replacement-modal__footer">{footer}</footer>
      </section>
    </div>,
    document.body,
  )
}
