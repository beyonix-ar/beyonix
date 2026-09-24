import type { SupabaseAuditLog } from "../supabase/types"
import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act, type ReactNode } from "react"
import { getReplacementFlow, type ReplacementLoadState } from "../orders/claim-replacement-flow"

test("componentes reales: alertas/facturación error ≠ vacío, retry y borrado con confirmación tipada", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
  }
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local-test.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-test-key"
  const { createRoot } = await import("react-dom/client")
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime")
  const { supabase } = await import("../supabase/client")
  const root = createRoot(document.getElementById("root")!)
  const router = { bfcacheId: "test-router", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} }
  const render = (node: ReactNode) => act(async () => root.render(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>))
  const authMock = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "test-token" } }, error: null }))
  const channelMock = mock.method(supabase, "channel", () => ({ on() { return this }, subscribe() { return this } }))
  const removeMock = mock.method(supabase, "removeChannel", async () => "ok")
  let invoiceFail = true
  let settingsFail = true
  let deleteCalls = 0
  let reversalCalls = 0
  let reversed = false
  let replacementCalls = 0
  let replacementLoadFails = false
  let receptionCalls = 0
  let orderFailure: "network" | "404" | "403" | "timeout" | null = "network"
  const sale = { id: "sale-1", sale_date: "2026-09-19", product_id: 1, variant_id: 1, product_name: "Auricular Ñandú", sku: "SKU-1", quantity: 2, gross_amount: 50000, net_amount: 45000, unit_cost: 1000, fee_amount: 5000, status: "completed", created_at: "2026-09-19T12:00:00Z" }
  const impact = { kind: "purchase", id: "123", product: "Auricular Ñandú", variant: "Azul", sku: "SKU-1", receivedQuantity: 3, totalCost: 10000, currentStock: 5, projectedStock: 2, affectedSales: 1, variants: 1, references: [], confirmation: "ELIMINAR COMPRA 123", fingerprint: "version-1" }
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (path.startsWith("/api/admin/pedidos?") ) {
      if (orderFailure === "network") throw new TypeError("Network unavailable")
      if (orderFailure === "timeout") throw new DOMException("Timeout", "TimeoutError")
      if (orderFailure) return Response.json({ error: "Error de carga" }, { status: Number(orderFailure) })
      return Response.json({ pedidos: [{ id: 123 }], total: 1 })
    }
    if (path === "/api/admin/facturacion") {
      if (invoiceFail) throw new TypeError("Network unavailable")
      return Response.json({ orders: [] })
    }
    if (path.startsWith("/api/admin/destructive-operations")) {
      if (init?.method === "POST") { deleteCalls++; return Response.json({ deleted: true }) }
      const kind = new URL(path, "http://localhost").searchParams.get("kind")
      return Response.json({ impact: { ...impact, kind, confirmation: kind === "purchase" ? impact.confirmation : `ELIMINAR ${kind === "product" ? "PRODUCTO" : "VARIANTE"} SKU-1` } })
    }
    if (path === "/api/admin/settings") {
      if (settingsFail || init?.method === "PATCH") throw new TypeError("Network unavailable")
      return Response.json({ settings: { shipping: { defaultShippingCost: 0, freeShippingMinAmount: 100000, shippingBonusMax: 10000, freeShippingMode: "bonificado", logisticsBaseSubsidy: 0 } } })
    }
    if (path === "/api/admin/integrations/andreani/test") return Response.json({ configured: false, environment: "QA" })
    if (path.includes("local-test.invalid") || path.includes("banner")) return Response.json([])
    if (path === "/api/admin/sales-ledger") return Response.json({ catalog: [], externalSales: [{ ...sale, status: reversed ? "reversed" : "completed", reversal_reason: reversed ? "Venta duplicada por error" : null, reversal_amount: reversed ? 45000 : null, reversed_by_name: reversed ? "Administración" : null }], mlSales: [] })
    if (path === "/api/admin/sales-ledger/sale-1/reverse") {
      const payload = JSON.parse(String(init?.body))
      assert.equal(payload.reason, "Venta duplicada por error")
      assert.ok(payload.idempotencyKey)
      reversalCalls++; reversed = true
      return Response.json({ reversed: true })
    }
    if (path === "/api/admin/mercadolibre-sales/sale-1/return-review") return Response.json({ error: "Esta devolución fue modificada por otro administrador. Recargá los datos antes de continuar." }, { status: 409 })
    if (path.startsWith("/api/admin/pedidos/123/replacements")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        assert.equal(body.orderItemId, 7)
        assert.equal(body.replacementVariantId, 9)
        assert.equal(body.quantity, 1)
        assert.equal(body.claimId, 1)
        assert.ok(body.idempotencyKey)
        replacementCalls++
        return Response.json({ replacement: { id: 1 } })
      }
      if (replacementLoadFails) return Response.json({ error: "No se pudieron verificar los reemplazos" }, { status: 500 })
      return Response.json({ replacements: [], variants: [{ id: 9, nombre: "Azul", sku: "REP-9", stock: 5, productos: { nombre: "Reemplazo Ñandú" } }] })
    }
    if (path === "/api/admin/pedidos/123/return-inventory/7") {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.restockedQuantity, 1, "envía sólo la nueva entrega, nunca el acumulado")
      assert.equal(body.writtenOffQuantity, 0)
      assert.ok(body.idempotencyKey)
      receptionCalls++
      return Response.json({ ok: true })
    }
    throw new Error(`Unexpected test request: ${path}`)
  })
  try {
    const { AdminNotificationsPopover } = await import("../../components/admin-notifications-popover")
    let retried = 0
    await render(<AdminNotificationsPopover notifications={[]} error="No se pudieron cargar las alertas" onNotificationClick={() => {}} onRetry={() => { retried++ }} />)
    assert.match(document.body.textContent || "", /No se pudieron cargar las alertas/)
    assert.doesNotMatch(document.body.textContent || "", /No hay alertas pendientes|Todo al día|0 pendientes/)
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Reintentar"))!.click())
    assert.equal(retried, 1)

    const { getAdminNotifications } = await import("./admin-notifications")
    const userMock = mock.method(supabase.auth, "getUser", async () => ({ data: { user: null }, error: new Error("Network unavailable") }))
    try { await assert.rejects(getAdminNotifications(), /No se pudieron cargar las alertas/) }
    finally { userMock.mock.restore() }

    const { usePedidos } = await import("../../hooks/use-pedidos")
    function OrderHarness() {
      const state = usePedidos({ orderId: 123 })
      return <div>{state.loading ? "Cargando" : state.error || `Pedido ${state.pedidos[0]?.id}`}<button onClick={() => void state.reloadPedidos()}>Reintentar pedido</button></div>
    }
    await render(<OrderHarness />)
    assert.match(document.body.textContent || "", /No se pudieron cargar/)
    assert.doesNotMatch(document.body.textContent || "", /No encontramos/)
    for (const [failure, expected] of [["403", /permisos/], ["timeout", /demoró/], ["404", /No encontramos/], [null, /Pedido 123/]] as const) {
      orderFailure = failure
      await act(async () => [...document.querySelectorAll("button")].find((node) => node.textContent === "Reintentar pedido")!.click())
      assert.match(document.body.textContent || "", expected)
    }

    const { AdminFacturacion } = await import("../../app/admin/sections/facturacion/admin-facturacion")
    await render(<AdminFacturacion />)
    assert.match(document.body.textContent || "", /No se pudieron cargar las facturas/)
    assert.doesNotMatch(document.body.textContent || "", /No hay facturas pendientes/)
    invoiceFail = false
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Reintentar"))!.click())
    assert.match(document.body.textContent || "", /No hay facturas pendientes/)

    const { ForceDeleteDialog } = await import("../../app/admin/components/force-delete-dialog")
    let deleted = 0
    await render(<ForceDeleteDialog kind="purchase" id="123" onClose={() => {}} onDeleted={() => { deleted++ }} />)
    const button = [...document.querySelectorAll("button")].find((element) => element.textContent === "Eliminar definitivamente")!
    assert.equal(button.disabled, true)
    assert.match(document.body.textContent || "", /Auricular Ñandú/)
    assert.match(document.body.textContent || "", /Stock después del borrado/)
    const input = document.querySelector<HTMLInputElement>('[aria-label="Confirmación de eliminación"]')!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input, "ELIMINAR COMPRA 123"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
    assert.equal(button.disabled, false)
    await act(async () => { button.click(); button.click() })
    assert.equal(deleteCalls, 1)
    assert.equal(deleted, 1)

    for (const kind of ["product", "variant"] as const) {
      await render(<ForceDeleteDialog key={kind} kind={kind} id="123" onClose={() => {}} onDeleted={() => { deleted++ }} />)
      const confirm = [...document.querySelectorAll("button")].find((element) => element.textContent === "Eliminar definitivamente")!
      assert.equal(confirm.disabled, true)
      const typed = document.querySelector<HTMLInputElement>('[aria-label="Confirmación de eliminación"]')!
      await act(async () => { setter.call(typed, `ELIMINAR ${kind === "product" ? "PRODUCTO" : "VARIANTE"} SKU-1`); typed.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
      await act(async () => { confirm.click(); confirm.click() })
    }
    assert.equal(deleteCalls, 3)
    assert.equal(deleted, 3)

    const { AdminModificaciones } = await import("../../app/admin/sections/modificaciones/admin-modificaciones")
    await render(<AdminModificaciones />)
    const save = () => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Guardar cambios"))!
    assert.equal(save().disabled, true, "no guarda defaults ante fallo de carga")
    const reload = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Recargar configuración"))!
    assert.equal(reload.disabled, false, "libera loading tras el error")
    settingsFail = false
    await act(async () => reload.click())
    assert.equal(save().disabled, false)
    await act(async () => save().click())
    assert.equal(save().disabled, false, "libera saving tras el error de red")

    const { saveMercadoLibreReturnReview } = await import("../supabase/queries/mercadolibre-sales")
    await assert.rejects(saveMercadoLibreReturnReview("sale-1", { expectedApprovedAt: null, receivedQuantity: 1, sellableQuantity: 1, discountedQuantity: 0, nonSellableQuantity: 0, discountPercent: null, discountReason: "", nonSellableReason: "", notes: "" }), /modificada por otro administrador/)

    const { AdminSalesLedger } = await import("../../app/admin/sections/dashboard/admin-sales-ledger")
    await render(<AdminSalesLedger channel="external" />)
    const reverse = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("Reversar"))!
    assert.ok(reverse)
    await act(async () => reverse.click())
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent || "", /no reintegra dinero automáticamente/)
    const confirmReverse = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Confirmar reversión")!
    assert.equal(confirmReverse.disabled, true)
    const reason = dialog.querySelector("textarea")!
    const textareaSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!
    await act(async () => { textareaSetter.call(reason, "Venta duplicada por error"); reason.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
    assert.equal(confirmReverse.disabled, false)
    await act(async () => { confirmReverse.click(); confirmReverse.click() })
    assert.equal(reversalCalls, 1)
    assert.match(document.body.textContent || "", /Reversada/)
    assert.match(document.body.textContent || "", /Administración/)

    const { OrderReplacementManager } = await import("../../app/admin/sections/pedidos/order-replacements")
    let updated = 0
    const replacementStates: ReplacementLoadState[] = []
    await render(<OrderReplacementManager pedido={{ id: 123, usuario_id: null, estado: "entregado", total: 50000, created_at: "2026-09-19", order_claims: [{ id: 1, order_id: 123, user_id: "test", claim_type: "garantia_beyonix", failure_type: "falla", resolution: "cambio_producto", status: "aprobado", description: "", affected_items: [{ order_item_id: 7, quantity: 1 }], created_at: "2026-09-19", updated_at: "2026-09-19" }], orden_items: [{ id: 7, orden_id: 123, producto_id: 1, cantidad: 3, precio: 1000, return_restocked_quantity: 2 }] }} onUpdated={async () => { updated++ }} onReplacementsChange={(_rows, state) => replacementStates.push(state)} />)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Registrar reemplazo")!.click())
    const replacementDialog = document.querySelector('[role="dialog"]')!
    const selects = replacementDialog.querySelectorAll("select")
    await act(async () => { selects[0].value = "7"; selects[0].dispatchEvent(new dom.window.Event("change", { bubbles: true })); selects[1].value = "9"; selects[1].dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
    const replacementReason = replacementDialog.querySelector("textarea")!
    await act(async () => { textareaSetter.call(replacementReason, "Cambio por falla de fábrica"); replacementReason.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
    const reviewReplacement = [...replacementDialog.querySelectorAll("button")].find((button) => button.textContent === "Revisar reemplazo")!
    assert.equal(reviewReplacement.disabled, false)
    await act(async () => reviewReplacement.click())
    assert.match(replacementDialog.textContent || "", /Vas a retirar 1 unidades de SKU REP-9/)
    const confirmReplacement = [...replacementDialog.querySelectorAll("button")].find((button) => button.textContent === "Confirmar retiro de stock")!
    await act(async () => { confirmReplacement.click(); confirmReplacement.click() })
    assert.equal(replacementCalls, 1)
    assert.equal(updated, 1)
    assert.equal(replacementStates[0], "loading")
    assert.equal(replacementStates.at(-1), "ready")
    replacementLoadFails = true
    await render(<OrderReplacementManager key="failed-load" pedido={{ id: 123, usuario_id: null, estado: "entregado", total: 50000, created_at: "2026-09-19" }} onUpdated={async () => {}} onReplacementsChange={(rows, state) => {
      replacementStates.push(state)
      if (state !== "ready") assert.equal(rows, null)
    }} />)
    assert.equal(replacementStates.at(-1), "loading")
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
    assert.equal(replacementStates.at(-1), "error")
    replacementLoadFails = false
    await act(async () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Recargar datos")!.click())
    assert.equal(replacementStates.at(-1), "ready")

    const { ReturnInventoryPanel, ReplacementFlowSteps } = await import("../../components/claims/admin-claim-manager")
    for (const [replacedUnits, replacementLoadState, enabled] of [
      [null, "loading", false], [null, "error", false], [null, undefined, false],
      [0, "ready", false], [1, "loading", false], [1, "error", false], [1, "ready", true],
    ] as const) {
      let confirmed = 0
      const flow = getReplacementFlow({ status: "aprobado", resolution: "cambio_producto", claimedUnits: 1, receivedUnits: 1, replacedUnits, replacementLoadState })
      await render(<ReplacementFlowSteps flow={flow} missingUnit={false} claimedUnits={1} receivedUnits={1} replacedUnits={replacedUnits} replacementLoadState={replacementLoadState} saving={false} onGoToReception={() => {}} onRegisterReplacement={() => {}} onConfirmDelivery={() => { confirmed++ }} onFinalize={() => {}} />)
      const delivery = [...document.querySelectorAll("button")].find((button) => button.textContent === "Confirmar envío o entrega")!
      const finalize = [...document.querySelectorAll("button")].find((button) => button.textContent === "Finalizar reclamo")!
      assert.equal(delivery.disabled, !enabled)
      assert.equal(finalize.disabled, !enabled)
      await act(async () => delivery.click())
      assert.equal(confirmed, enabled ? 1 : 0)
      if (replacementLoadState === "error") assert.match(document.body.textContent || "", /No pudimos verificar el reemplazo/)
      else if (replacedUnits === null || replacementLoadState === "loading") assert.match(document.body.textContent || "", /Verificando reemplazo/)
    }
    await render(<ReturnInventoryPanel canManage pedido={{ id: 123, usuario_id: null, estado: "entregado", total: 50000, created_at: "2026-09-19", orden_items: [{ id: 7, orden_id: 123, producto_id: 1, cantidad: 5, precio: 1000, return_restocked_quantity: 2, return_inventory_processed_at: "2026-09-18T12:00:00Z" }] }} claim={{ id: 1, order_id: 123, user_id: "test", claim_type: "garantia_beyonix", status: "aprobado", description: "", affected_items: [{ order_item_id: 7, quantity: 3 }], created_at: "2026-09-19", updated_at: "2026-09-19" }} />)
    assert.match(document.body.textContent || "", /Reclamadas 3Recibidas 2Pendientes 1/)
    assert.doesNotMatch(document.body.textContent || "", /Vendió/)
    assert.match(document.body.textContent || "", /Si recibís el pedido en partes/)
    const confirmReception = () => [...document.querySelectorAll("button")].find((button) => button.textContent === "Confirmar recepción")!
    assert.equal(confirmReception().disabled, true, "sin unidades recibidas no se puede confirmar")
    assert.match(document.body.textContent || "", /Indicá cuántas unidades llegaron/)
    assert.doesNotMatch(document.body.textContent || "", /Recepción cerrada/)
    const counts = document.querySelectorAll<HTMLInputElement>('input[type="number"]')
    assert.equal(counts[0].value, "0", "no precarga cantidades ya recibidas")
    assert.equal(counts[0].max, "1")
    await act(async () => { for (const input of counts) { setter.call(input, "1"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) } })
    assert.equal(confirmReception().disabled, false)
    await act(async () => confirmReception().click())
    const receiptDialog = document.querySelector('[role="dialog"]')!
    assert.ok(receiptDialog)
    assert.match(receiptDialog.textContent || "", /0 → 1/)
    await act(async () => [...receiptDialog.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirmar"))!.click())
    assert.equal(receptionCalls, 1)
    await render(<ReturnInventoryPanel canManage pedido={{ id: 123, usuario_id: null, estado: "entregado", total: 50000, created_at: "2026-09-19", orden_items: [{ id: 7, orden_id: 123, producto_id: 1, cantidad: 5, precio: 1000, return_restocked_quantity: 3, return_inventory_processed_at: "2026-09-20T12:00:00Z" }] }} claim={{ id: 1, order_id: 123, user_id: "test", claim_type: "garantia_beyonix", status: "aprobado", description: "", affected_items: [{ order_item_id: 7, quantity: 3 }], created_at: "2026-09-19", updated_at: "2026-09-19" }} />)
    assert.match(document.body.textContent || "", /Reclamadas 3Recibidas 3Pendientes 0/)
    assert.match(document.body.textContent || "", /Recepción completa · 3 unidades volvieron al stock/)
    // Reclamo de una unidad: opciones semánticas, observación obligatoria sólo para la baja.
    await render(<ReturnInventoryPanel canManage pedido={{ id: 124, usuario_id: null, estado: "entregado", total: 50000, created_at: "2026-09-19", orden_items: [{ id: 8, orden_id: 124, producto_id: 1, cantidad: 1, precio: 1000 }] }} claim={{ id: 2, order_id: 124, user_id: "test", claim_type: "garantia_beyonix", status: "aprobado", resolution: "cambio_producto", description: "", affected_items: [{ order_item_id: 8, quantity: 1 }], created_at: "2026-09-19", updated_at: "2026-09-19" }} />)
    const text = () => document.body.textContent || ""
    assert.match(text(), /¿Qué hacemos con esta unidad\?/)
    assert.doesNotMatch(text(), /Si recibís el pedido en partes/)
    assert.match(text(), /Observación interna \(opcional\)/)
    const choice = (label: string) => [...document.querySelectorAll("button")].find((button) => button.textContent?.startsWith(label))!
    assert.equal(confirmReception().disabled, true)
    assert.match(text(), /Elegí qué hacer con la unidad/)
    await act(async () => choice("Volver al stock").click())
    assert.equal(choice("Volver al stock").getAttribute("aria-pressed"), "true")
    assert.match(text(), /Stock: 0 → 1/)
    assert.equal(confirmReception().disabled, false)
    await act(async () => choice("Dar de baja").click())
    assert.equal(choice("Dar de baja").getAttribute("aria-pressed"), "true")
    assert.equal(choice("Volver al stock").getAttribute("aria-pressed"), "false")
    assert.match(text(), /Observación interna \(obligatoria para dar de baja\)/)
    assert.equal(confirmReception().disabled, true, "la baja exige motivo")
    const note = document.querySelector<HTMLTextAreaElement>("textarea")!
    await act(async () => { textareaSetter.call(note, "Caja golpeada"); note.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
    assert.equal(confirmReception().disabled, false)
    await act(async () => confirmReception().click())
    const writeOffDialog = document.querySelector('[role="dialog"]')!
    assert.match(writeOffDialog.textContent || "", /Baja o pérdida1/)
    await act(async () => [...writeOffDialog.querySelectorAll("button")].find((button) => button.textContent === "Cancelar")!.click())
    assert.equal(receptionCalls, 1, "cancelar no registra la recepción")
    // Stepper: Decisión completa, Recepción actual, Reemplazo y Entrega pendientes.
    const stepper = [...document.querySelectorAll(".admin-claim-stepper-item")].map((item) => `${item.textContent}:${item.className}`)
    assert.deepEqual(stepper.map((entry) => entry.replace(/^.*?(Decisión|Recepción|Reemplazo|Entrega).*?is-(\w+).*$/, "$1=$2")), ["Decisión=done", "Recepción=current", "Reemplazo=pending", "Entrega=pending"])
    const { formatAuditDescription } = await import("../../app/admin/sections/auditoria/audit-helpers")
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["external_sales", { product_name: "Ñandú", quantity: 2, net_amount: 2000 }, /Venta externa registrada/],
      ["external_sales", { status: "reversed", reversal_amount: 2000, reversal_reason: "Venta duplicada" }, /Venta externa reversada/],
      ["order_replacements", { original_order_id: 123, quantity: 1, reason: "garantia" }, /Reemplazo registrado/],
      ["order_credit_notes", { order_id: 123, amount: 2000, status: "authorized" }, /Nota de crédito/],
      ["mercadopago_order_refunds", { order_id: 123, amount: 2000, status: "confirmed" }, /Reintegro por Mercado Pago/],
      ["order_claims", { order_id: 123, status: "aprobado" }, /Reclamo actualizado/],
      ["inventory_return_movements", { mercadolibre_sale_id: "ml-test", sellable_quantity: 1, discounted_quantity: 1, non_sellable_quantity: 1, review_notes: "Corrección: caja dañada" }, /Corrección: caja dañada/],
      ["inventory_return_movements", { order_id: 123, received_quantity: 2, sellable_quantity: 2 }, /\+2 al stock vendible/],
    ]
    for (const [table_name, after_data, expected] of cases) {
      const log: SupabaseAuditLog = { id: 1, table_name, action: "INSERT", record_id: "1", actor_user_id: null, actor_email: null, before_data: null, after_data, created_at: "2026-09-20T12:00:00Z", undone_at: null, undone_by: null }
      const description = formatAuditDescription(log)
      const text = [description.title, ...description.lines].join(" · ")
      assert.match(text, expected)
      assert.ok(description.lines.length > 0)
      assert.doesNotMatch(text, /\[object Object\]|\{"/)
    }
    } finally {
    await act(async () => root.unmount())
    await supabase.auth.stopAutoRefresh()
    fetchMock.mock.restore(); authMock.mock.restore(); channelMock.mock.restore(); removeMock.mock.restore()
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey
    dom.window.close()
    for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key)
  }
})
