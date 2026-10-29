import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  PRICING_CONFLICT_CREDIT_FAILED_MESSAGE,
  buildPricingSelectionKey,
  createCommercialRefreshRunner,
  diffCommercialSettings,
  finishPricingConflictSync,
  getCheckoutCommercialNotice,
  getDetectedCommercialChange,
  getPricingConflictStatus,
  getPricingConflictStatusMessage,
  pricingConflictBlocksPayment,
  type DetectedCommercialChange,
  type PricingConflict,
} from "./cart-catalog-refresh.ts"
import { calculateCartTotals } from "./cart-totals.ts"
import { calculateCustomerShippingCost } from "../store-config.ts"
import { buildShippingQuoteKey } from "../andreani/checkout-quote-client.ts"

// Carrera real del checkout: un refresco comercial ya en curso cuando llega
// el 409 PRICING_CHANGED. El "servidor" cambia la bonificación de envío de
// $20.000 a $25.000; el resumen pasa de $152.360 (A) a $147.360 (B) con las
// fórmulas reales, sin tocarlas.

const PRODUCTS = 129_500
const ANDREANI = 42_860
const TOTAL_A = 152_360
const TOTAL_B = 147_360
const LABEL_B = "$ 147.360"
const SELECTION = "mercadopago_cash|andreani|domicilio|||101:null:null:1"

type Settings = { shipping: { freeShippingMode: string; freeShippingMinAmount: number; shippingBonusMax: number } }

function settingsWithBonus(shippingBonusMax: number): Settings {
  return { shipping: { freeShippingMode: "full", freeShippingMinAmount: 100_000, shippingBonusMax } }
}

function visibleTotal(settings: Settings) {
  const items = [{ product: { id: 101, precio: PRODUCTS }, quantity: 1, unitPrice: PRODUCTS }]
  const productsTotal = calculateCartTotals(items).productsTotal
  const shippingCost = calculateCustomerShippingCost(productsTotal, ANDREANI, settings.shipping as never)
  return calculateCartTotals(items, { shippingCost }).total
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createCheckoutHarness() {
  let serverSettings = settingsWithBonus(20_000)
  const state = {
    clientSettings: settingsWithBonus(20_000),
    change: null as DetectedCommercialChange | null,
    conflict: null as PricingConflict | null,
    installmentsPending: false,
  }
  const pendingReads: Array<{ snapshot: Settings; release: () => void }> = []
  const payments: number[] = []
  // Como customerCredit.reload(): nunca rechaza, informa éxito o fallo.
  let creditReloadSucceeds = true
  const reloadCredit = async () => creditReloadSucceeds

  // Igual que el hook: lee la configuración al EMPEZAR, la aplica al terminar
  // y avisa la causa por onChange.
  const runRefresh = createCommercialRefreshRunner(
    async () => {
      const snapshot = structuredClone(serverSettings)
      const gate = deferred<void>()
      pendingReads.push({ snapshot, release: () => gate.resolve() })
      await gate.promise
      const diff = diffCommercialSettings(state.clientSettings, snapshot)
      state.clientSettings = snapshot
      const signals = {
        cartChanged: false,
        priceChanged: false,
        availabilityChanged: false,
        removedCount: 0,
        settingsChanged: diff.changed,
        shippingSettingsChanged: diff.shippingChanged,
        otherSettingsChanged: diff.otherChanged,
      }
      if (signals.settingsChanged) state.change = getDetectedCommercialChange(signals)
      return signals
    },
    { isVisible: () => true },
  )

  const status = () =>
    getPricingConflictStatus({
      conflict: state.conflict,
      selectionKey: SELECTION,
      visibleTotal: visibleTotal(state.clientSettings),
      installmentsPending: state.installmentsPending,
    })

  return {
    state,
    pendingReads,
    runRefresh,
    status,
    visible: () => visibleTotal(state.clientSettings),
    // Lo que muestra el aviso y lo que mandaría Pagar (expectedTotal = total visible).
    notice: () =>
      getCheckoutCommercialNotice({ change: state.change, conflict: status() === "none" ? null : state.conflict }),
    paymentBlocked: () => pricingConflictBlocksPayment(status()),
    statusMessage: () => getPricingConflictStatusMessage(status()),
    expectedTotal: () => visibleTotal(state.clientSettings),
    // Igual que los guardas de Pagar: con el conflicto bloqueando no se manda nada.
    tryToPay: () => {
      if (pricingConflictBlocksPayment(status())) return false
      payments.push(visibleTotal(state.clientSettings))
      return true
    },
    payments,
    adminChangesBonus: (bonus: number) => {
      serverSettings = settingsWithBonus(bonus)
    },
    setCreditReload: (outcome: boolean) => {
      creditReloadSucceeds = outcome
    },
    // Igual que el bloque 409 del checkout: refresco forzado + relectura de saldo.
    receivePricingChanged: (serverTotal: number, label: string) => {
      state.change = null
      state.conflict = { id: 1, serverTotal, newTotalLabel: label, selectionKey: SELECTION, syncing: true, creditSyncFailed: false }
      return Promise.allSettled([runRefresh(true), reloadCredit()]).then(([, credit]) => {
        const creditReloaded = credit.status === "fulfilled" && credit.value
        state.conflict = finishPricingConflictSync(state.conflict, 1, { creditReloaded })
      })
    },
    // Igual que "Reintentar" del aviso.
    retryCredit: async () => {
      const creditReloaded = await reloadCredit()
      state.conflict = finishPricingConflictSync(state.conflict, 1, { creditReloaded })
    },
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test("A-E. refresco en curso + 409: el aviso conserva B, el refresco viejo no vuelve a A y Pagar espera al resumen", async () => {
  const checkout = createCheckoutHarness()
  assert.equal(checkout.visible(), TOTAL_A)

  // 1-2. Empieza un refresco comercial (lee la configuración vieja).
  const oldRefresh = checkout.runRefresh()
  assert.equal(checkout.pendingReads.length, 1)

  // 3. Antes de que termine, el admin cambió la bonificación y el servidor responde 409 con B.
  checkout.adminChangesBonus(25_000)
  const sync = checkout.receivePricingChanged(TOTAL_B, LABEL_B)
  assert.equal(checkout.notice(), `El total de tu compra cambió. Nuevo total: ${LABEL_B}. Revisalo antes de pagar.`)
  assert.equal(checkout.paymentBlocked(), true)
  // El forzado no se descartó ni reusó la lectura vieja: queda encadenado.
  assert.equal(checkout.pendingReads.length, 1)

  // 4. Termina el refresco anterior (datos viejos): no hay cambio y el aviso de B sigue intacto.
  checkout.pendingReads[0].release()
  await oldRefresh
  await flush()
  assert.equal(checkout.visible(), TOTAL_A)
  assert.match(checkout.notice() ?? "", /Nuevo total: \$ 147\.360/)
  assert.equal(checkout.paymentBlocked(), true, "con el resumen todavía en A no se puede pagar")

  // El refresco encadenado empezó DESPUÉS del viejo y lee la configuración nueva.
  assert.equal(checkout.pendingReads.length, 2)
  assert.equal(checkout.pendingReads[1].snapshot.shipping.shippingBonusMax, 25_000)
  checkout.pendingReads[1].release()
  await sync

  // El resumen muestra B, el aviso precisa la causa sin perder el total y Pagar manda B.
  assert.equal(checkout.visible(), TOTAL_B)
  assert.equal(checkout.notice(), `Se actualizó el costo de envío. Nuevo total: ${LABEL_B}. Revisalo antes de pagar.`)
  assert.equal(checkout.paymentBlocked(), false)
  assert.equal(checkout.expectedTotal(), TOTAL_B)
  assert.equal(checkout.expectedTotal(), checkout.visible())
})

test("B. un aviso común posterior no reemplaza el del 409: sólo precisa la causa", () => {
  const conflict: PricingConflict = { id: 1, serverTotal: TOTAL_B, newTotalLabel: LABEL_B, selectionKey: SELECTION, syncing: true, creditSyncFailed: false }
  for (const cause of ["price", "availability", "cart", "settings", "shipping_settings", "multiple"] as const) {
    assert.match(getCheckoutCommercialNotice({ change: { cause, removedCount: 0 }, conflict }) ?? "", /Nuevo total: \$ 147\.360\. Revisalo antes de pagar\.$/)
  }
  assert.equal(
    getCheckoutCommercialNotice({ change: { cause: "price", removedCount: 0 }, conflict: null }),
    "Cambió el precio de uno o más productos. Revisá el nuevo total antes de pagar.",
  )
})

test("C/E. Pagar sigue bloqueado mientras sincroniza, recalcula cuotas o el resumen no muestra el total del servidor", () => {
  const conflict: PricingConflict = { id: 1, serverTotal: TOTAL_B, newTotalLabel: LABEL_B, selectionKey: SELECTION, syncing: false, creditSyncFailed: false }
  const status = (overrides: Partial<Parameters<typeof getPricingConflictStatus>[0]>) =>
    getPricingConflictStatus({ conflict, selectionKey: SELECTION, visibleTotal: TOTAL_B, installmentsPending: false, ...overrides })

  assert.equal(status({ conflict: { ...conflict, syncing: true } }), "syncing")
  assert.equal(status({ installmentsPending: true }), "syncing")
  assert.equal(status({ visibleTotal: TOTAL_A }), "mismatch")
  assert.equal(status({}), "synced")
  assert.equal(status({ visibleTotal: TOTAL_B + 0.004 }), "synced")
  // Sin conflicto, o si el cliente cambió pago/envío/cantidades, el 409 ya no aplica.
  assert.equal(status({ conflict: null }), "none")
  assert.equal(status({ selectionKey: "transferencia|andreani|domicilio|||101:null:null:1", visibleTotal: 140_000 }), "none")
  // El servidor no informó un total válido: tras sincronizar no hay contra qué comparar.
  assert.equal(status({ conflict: { ...conflict, serverTotal: null }, visibleTotal: TOTAL_A }), "synced")
})

test("A. el runner: varios force con una lectura en curso comparten UNA lectura encadenada; sin force no se duplica", async () => {
  const gates: Array<() => void> = []
  let calls = 0
  const run = createCommercialRefreshRunner(
    async () => {
      calls += 1
      const gate = deferred<void>()
      gates.push(() => gate.resolve())
      await gate.promise
      return calls
    },
    { isVisible: () => true },
  )

  const first = run()
  assert.equal(await run(), null, "sin force, con otra lectura en curso, no se lanza otra")
  const forcedA = run(true)
  const forcedB = run(true)
  assert.equal(forcedA, forcedB)
  assert.equal(calls, 1)

  gates[0]()
  assert.equal(await first, 1)
  await flush()
  assert.equal(calls, 2)
  gates[1]()
  assert.equal(await forcedA, 2)
})

test("contrato: el checkout manda el total visible, bloquea Pagar con un 409 vigente y encadena la sincronización", () => {
  const checkout = readFileSync(new URL("../../app/checkout/page.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  const hook = readFileSync(new URL("../../hooks/use-commercial-refresh.ts", import.meta.url), "utf8")

  assert.match(hook, /createCommercialRefreshRunner\(/)
  assert.match(checkout, /const expectedCheckoutTotal = finalTotal\n/)
  assert.match(checkout, /termsAccepted &&\s*!pricingConflictBlocksPayment/)
  assert.equal(checkout.match(/if \(pricingConflictBlocksPayment\) return/g)?.length, 2)
  assert.match(checkout, /\(isMercadoPagoFinanced && interestFreeConfirmationPending\) \|\|\s*pricingConflictBlocksPayment/)
  assert.match(checkout, /installmentsPending: isMercadoPagoPayment && interestFreeConfirmationPending/)

  const start = checkout.indexOf('if (response.status === 409 && data?.code === "PRICING_CHANGED")')
  const block = checkout.slice(start, checkout.indexOf("return\n      }", start))
  assert.match(block, /setCommercialChange\(null\)/)
  assert.match(block, /syncing: true/)
  assert.match(block, /invalidateInterestFreeInstallments\(\)/)
  assert.match(block, /Promise\.allSettled\(\[refreshCommercialData\(true\), customerCredit\.reload\(\)\]\)/)
  assert.match(block, /creditSyncFailed: false/)
  assert.match(block, /const creditReloaded = credit\.status === "fulfilled" && credit\.value/)
  assert.match(block, /finishPricingConflictSync\(conflict, conflictId, \{ creditReloaded \}\)/)
  // Mientras el 409 bloquea Pagar, el aviso no se puede descartar; si falló el saldo, se puede reintentar.
  assert.match(checkout, /\{!pricingConflictBlocksPayment && \(\s*<button/)
  assert.match(checkout, /pricingConflictStatus === "credit_failed" && pricingConflict && \(/)
  assert.match(checkout, /onClick=\{\(\) => retryPricingConflictCredit\(pricingConflict\.id\)\}/)
  // La huella incluye el destino canónico de la cotización.
  assert.match(checkout, /destinationKey: shippingQuotePayload,/)
  assert.ok(checkout.indexOf("const shippingQuotePayload =") < checkout.indexOf("const pricingSelectionKey ="))
})

test("contrato: reload() del saldo informa éxito o fallo sin inventar saldo ni pisar el anterior", () => {
  const context = readFileSync(new URL("../../context/customer-credit-context.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  assert.match(context, /reload: \(\) => Promise<boolean>/)
  const start = context.indexOf("const reload = useCallback(")
  const reload = context.slice(start, context.indexOf("}, [clearAppliedAmount, user])", start))
  const catchBlock = reload.slice(reload.indexOf("} catch"))
  assert.match(catchBlock, /return false/)
  assert.doesNotMatch(catchBlock, /setBalance|storeBalance/)
  assert.match(reload.slice(0, reload.indexOf("} catch")), /storeBalance\(user\.id, nextBalance\)\n\s*return true/)
})

// Relectura del saldo durante la sincronización del 409

async function receiveConflictInSync(checkout: ReturnType<typeof createCheckoutHarness>) {
  checkout.adminChangesBonus(25_000)
  const sync = checkout.receivePricingChanged(TOTAL_B, LABEL_B)
  await flush()
  checkout.pendingReads[0].release()
  await sync
}

test("saldo: el refresco y las cuotas terminan bien pero falla la relectura del saldo -> Pagar sigue bloqueado", async () => {
  const checkout = createCheckoutHarness()
  checkout.setCreditReload(false)
  await receiveConflictInSync(checkout)

  // Refresco comercial OK (resumen en B) y cuotas ya recalculadas.
  assert.equal(checkout.visible(), TOTAL_B)
  assert.equal(checkout.state.installmentsPending, false)
  // Pero sin saldo releído no está sincronizado.
  assert.equal(checkout.status(), "credit_failed")
  assert.equal(checkout.paymentBlocked(), true)
  assert.equal(checkout.statusMessage(), PRICING_CONFLICT_CREDIT_FAILED_MESSAGE)
  assert.equal(PRICING_CONFLICT_CREDIT_FAILED_MESSAGE, "No pudimos actualizar tu saldo. Intentá nuevamente.")
  assert.match(checkout.notice() ?? "", /Nuevo total: \$ 147\.360/)
  assert.equal(checkout.tryToPay(), false)
  assert.deepEqual(checkout.payments, [], "no se intentó pagar")
})

test("saldo: el reintento sale bien -> termina la sincronización, el total visible coincide y Pagar se habilita", async () => {
  const checkout = createCheckoutHarness()
  checkout.setCreditReload(false)
  await receiveConflictInSync(checkout)
  assert.equal(checkout.status(), "credit_failed")

  checkout.setCreditReload(true)
  await checkout.retryCredit()
  assert.equal(checkout.status(), "synced")
  assert.equal(checkout.statusMessage(), null)
  assert.equal(checkout.paymentBlocked(), false)
  assert.equal(checkout.visible(), TOTAL_B)
  assert.equal(checkout.tryToPay(), true)
  assert.deepEqual(checkout.payments, [TOTAL_B], "se manda el total visible")
})

test("saldo: un reintento de un conflicto viejo no toca un conflicto nuevo", () => {
  const current: PricingConflict = {
    id: 2, serverTotal: TOTAL_B, newTotalLabel: LABEL_B, selectionKey: SELECTION, syncing: true, creditSyncFailed: false,
  }
  assert.equal(finishPricingConflictSync(current, 1, { creditReloaded: false }), current)
  assert.equal(finishPricingConflictSync(null, 1, { creditReloaded: true }), null)
})

// Huella de la selección: destino real vs. campos irrelevantes

const cartItems = [{ product: { id: 101 }, variantId: null, conditionedStockId: null, quantity: 1 }]

function selectionKey(overrides: {
  cpDestino?: string
  localidad?: string
  provincia?: string
  direccion?: string
  shippingType?: string
  sucursalId?: number | null
} = {}) {
  const destination = {
    cpDestino: overrides.cpDestino ?? "5000",
    localidad: overrides.localidad ?? "Córdoba",
    provincia: overrides.provincia ?? "Córdoba",
    direccion: overrides.direccion ?? "Av. Colón 1234",
  }
  return buildPricingSelectionKey({
    paymentOption: "mercadopago_cash",
    shippingProvider: "andreani",
    shippingType: overrides.shippingType ?? "domicilio",
    sucursalId: overrides.sucursalId ?? null,
    storeBenefitId: "",
    destinationKey: buildShippingQuoteKey({
      ...destination,
      items: cartItems.map((item) => ({ productId: item.product.id, quantity: item.quantity, variantId: null, conditionedStockId: null })),
    }),
    items: cartItems,
  })
}

function conflictAt(key: string): PricingConflict {
  return { id: 1, serverTotal: TOTAL_B, newTotalLabel: LABEL_B, selectionKey: key, syncing: false, creditSyncFailed: false }
}

const statusFor = (conflictKey: string, currentKey: string) =>
  getPricingConflictStatus({ conflict: conflictAt(conflictKey), selectionKey: currentKey, visibleTotal: TOTAL_A, installmentsPending: false })

test("huella A. 409 en el destino A y el cliente no cambia nada: el conflicto sigue", () => {
  assert.equal(statusFor(selectionKey(), selectionKey()), "mismatch")
})

test("huella B. el cliente cambia CP/localidad a otro destino (misma modalidad): el conflicto viejo se descarta", () => {
  const atA = selectionKey()
  assert.equal(statusFor(atA, selectionKey({ cpDestino: "5500", localidad: "Mendoza", provincia: "Mendoza" })), "none")
  assert.equal(statusFor(atA, selectionKey({ cpDestino: "5001" })), "none")
  assert.equal(statusFor(atA, selectionKey({ localidad: "Villa Allende" })), "none")
})

test("huella C. cambia el domicilio con la misma modalidad: nueva selección", () => {
  assert.equal(statusFor(selectionKey(), selectionKey({ direccion: "Av. Colón 999" })), "none")
})

test("huella D. cambia la sucursal: nueva selección", () => {
  const atBranch10 = selectionKey({ shippingType: "sucursal", sucursalId: 10 })
  assert.equal(statusFor(atBranch10, selectionKey({ shippingType: "sucursal", sucursalId: 11 })), "none")
  assert.equal(statusFor(atBranch10, selectionKey({ shippingType: "sucursal", sucursalId: 10 })), "mismatch")
})

test("huella E. cambios que no son una nueva selección logística no descartan el conflicto", () => {
  const atA = selectionKey()
  // Mayúsculas, tildes o espacios del mismo destino: la clave canónica es la misma.
  assert.equal(statusFor(atA, selectionKey({ localidad: "  CORDOBA ", direccion: "av.  colón 1234 " })), "mismatch")
  // Nombre, teléfono, email o referencias no forman parte de la huella.
  const source = readFileSync(new URL("./cart-catalog-refresh.ts", import.meta.url), "utf8")
  const builder = source.slice(source.indexOf("export function buildPricingSelectionKey"), source.indexOf("export function finishPricingConflictSync"))
  assert.doesNotMatch(builder, /nombre|telefono|email|referencias|quoteToken|expiresAt/)
})

test("huella 7. con un 409 activo, la misma dirección escrita con o sin tilde no descarta el conflicto", () => {
  const atColon = selectionKey({ direccion: "Av. Colón 1234" })
  assert.equal(statusFor(atColon, selectionKey({ direccion: "Av. Colon 1234" })), "mismatch")
  assert.equal(statusFor(atColon, selectionKey({ direccion: "AV. COLON   1234" })), "mismatch")
  assert.equal(statusFor(selectionKey({ direccion: "San Martín 500" }), selectionKey({ direccion: "San Martin 500" })), "mismatch")
  // Otra altura sí es otra dirección: el conflicto viejo se descarta.
  assert.equal(statusFor(atColon, selectionKey({ direccion: "Av. Colón 1235" })), "none")
})
