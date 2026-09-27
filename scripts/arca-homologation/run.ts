/**
 * Arnés de pruebas ARCA HOMOLOGACIÓN. Corre SÓLO en el VPS, desde el
 * directorio de la app, para compartir el TA persistido de WSAA con PM2:
 *
 *   node --conditions=react-server --import tsx scripts/arca-homologation/run.ts <comando> [opciones]
 *
 * Ejecuta las RUTAS REALES de Admin (factura, NC, conciliación) en este
 * proceso; sólo se reemplazan la autenticación (actor super_admin explícito)
 * y el gateway (real, con prueba opcional de respuesta perdida). Toda
 * operación está atada a un usuario y un producto EXCLUSIVAMENTE de prueba.
 *
 * Comandos:
 *   preflight            Solo lectura (DB + configuración). --arca agrega
 *                        FEDummy y último autorizado 11/13 (sin CAE).
 *   invoice              Factura C (pide CAE). Requiere --confirm-cae.
 *                        --lose-response: ARCA autoriza y la respuesta se descarta.
 *   reconcile-invoice    Reintento de una factura pendiente de conciliar.
 *                        Nunca pide CAE (el gateway lo prohíbe).
 *   credit-note          NC C (ajuste administrativo, saldo a favor del usuario
 *                        de prueba). --amount. Requiere --confirm-cae.
 *                        --lose-response igual que en invoice.
 *   reconcile-credit-note  "Conciliar con ARCA" de una NC. Nunca pide CAE.
 *   verify               Solo lectura: compara DB contra FECompConsultar.
 *
 * Opciones comunes: --test-user <uuid> --test-product <id> --order <id>
 *                   --actor <uuid super_admin> (comandos que ejecutan rutas)
 */

import { createRequire } from "node:module"
import { parseArgs } from "node:util"

import { assertRouteUsesShims, registerRouteShims } from "./route-shims.ts"
import { harnessState } from "./harness-state.ts"
import {
  HomologationGuardError,
  assertCreditNoteTarget,
  assertHomologationRuntime,
  assertInvoiceableForTest,
  assertTestOrder,
  assertTestProduct,
  assertTestUser,
  assertTestUserIsolated,
  type OrderFacts,
} from "./guards.ts"

const root = process.cwd()
const require = createRequire(`${root}/package.json`)
require("@next/env").loadEnvConfig(root, false, { info() {}, error: console.error })
registerRouteShims(root)

const INVOICE_ROUTE = "app/api/admin/orders/[id]/invoice/route.ts"
const CREDIT_NOTE_ROUTE = "app/api/admin/orders/[id]/credit-note/route.ts"
const RECONCILE_ROUTE = "app/api/admin/credit-notes/[noteId]/reconcile/route.ts"

const COMMANDS = ["preflight", "invoice", "reconcile-invoice", "credit-note", "reconcile-credit-note", "verify"] as const
type Command = (typeof COMMANDS)[number]

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "test-user": { type: "string" },
    "test-product": { type: "string" },
    order: { type: "string" },
    actor: { type: "string" },
    amount: { type: "string" },
    note: { type: "string" },
    arca: { type: "boolean", default: false },
    "confirm-cae": { type: "boolean", default: false },
    "lose-response": { type: "boolean", default: false },
  },
})

const command = positionals[0] as Command
if (!COMMANDS.includes(command)) {
  console.error(`Comando inválido. Usá: ${COMMANDS.join(" | ")}`)
  process.exit(2)
}

function required(name: string, value: string | undefined) {
  if (!value) throw new HomologationGuardError(`Falta --${name}.`)
  return value
}

async function main() {
  const { createAdminClient } = await import("../../lib/supabase/admin.ts")
  const forge = require("node-forge")
  const admin = createAdminClient()
  const state = harnessState()

  // 1. Configuración: homologación, certificado de testing, automática apagada.
  const certificate = forge.pki.certificateFromPem(String(process.env.ARCA_CERT ?? "").trim().replaceAll("\\n", "\n"))
  const issuerCn = String(certificate.issuer.getField("CN")?.value ?? "")
  assertHomologationRuntime({
    arcaEnv: process.env.ARCA_ENV,
    autoInvoicingEnabled: process.env.ARCA_AUTO_INVOICING_ENABLED,
    certificateIssuerCn: issuerCn,
  })

  // 2. Usuario y producto exclusivamente de prueba; el usuario nunca compró otra cosa.
  const testUserId = required("test-user", values["test-user"])
  const testProductId = Number(required("test-product", values["test-product"]))
  const [{ data: user }, { data: product }, { data: userOrders, error: ordersError }] = await Promise.all([
    admin.from("profiles").select("id, email, rol").eq("id", testUserId).maybeSingle(),
    admin.from("productos").select("id, nombre").eq("id", testProductId).maybeSingle(),
    admin
      .from("ordenes")
      .select("id, usuario_id, total, invoice_status, invoice_arca_environment, invoice_requested_number, orden_items(producto_id)")
      .eq("usuario_id", testUserId),
  ])
  if (ordersError) throw new Error(`No se pudieron leer los pedidos del usuario de prueba: ${ordersError.message}`)
  assertTestUser(user, testUserId)
  assertTestProduct(product, testProductId)
  const orders: Array<OrderFacts & { invoice_requested_number: number | null }> = (userOrders ?? []).map((order) => ({
    id: Number(order.id),
    usuario_id: order.usuario_id,
    total: Number(order.total),
    invoice_status: order.invoice_status,
    invoice_arca_environment: order.invoice_arca_environment,
    invoice_requested_number: order.invoice_requested_number,
    items: (order.orden_items ?? []).map((item: { producto_id: number }) => ({ producto_id: Number(item.producto_id) })),
  }))
  assertTestUserIsolated(orders, testUserId, testProductId)

  const report: Record<string, unknown> = {
    command,
    arcaEnvironment: "homologation",
    certificateIssuer: issuerCn,
    testUser: { id: testUserId, email: user?.email },
    testProduct: { id: testProductId, nombre: product?.nombre },
    testOrders: orders.map(({ id, total, invoice_status, invoice_arca_environment, invoice_requested_number }) =>
      ({ id, total, invoice_status, invoice_arca_environment, invoice_requested_number })),
  }

  const orderId = values.order ? Number(values.order) : null
  const order = orderId == null ? null : orders.find((candidate) => candidate.id === orderId) ?? null
  if (command !== "preflight" || orderId != null) {
    assertTestOrder(order, testUserId, testProductId)
  }

  if (command === "preflight" || command === "verify") {
    if (values.arca || command === "verify") report.arca = await readArca(order)
    console.log(JSON.stringify(report, null, 2))
    return
  }

  // 3. Actor super_admin explícito (las rutas lo exigen para ajustes).
  const actorId = required("actor", values.actor)
  const { data: actor } = await admin.from("profiles").select("id, email, rol").eq("id", actorId).maybeSingle()
  if (!actor || actor.rol !== "super_admin") throw new HomologationGuardError("--actor debe ser un super_admin.")
  state.actor = { id: actor.id, email: actor.email, rol: "super_admin" }

  const requestsCae = command === "invoice" || command === "credit-note"
  if (requestsCae && !values["confirm-cae"]) {
    throw new HomologationGuardError("Este comando pide un CAE real de homologación: requiere --confirm-cae.")
  }
  if (!requestsCae && values["lose-response"]) {
    throw new HomologationGuardError("--lose-response sólo aplica a invoice / credit-note.")
  }
  state.forbidCae = !requestsCae
  state.loseNextCaeResponse = values["lose-response"] === true

  let response: Response
  if (command === "invoice") {
    const facts = await invoiceFacts(admin, order!.id)
    assertInvoiceableForTest(order!, facts.invoiceable)
    assertRouteUsesShims(INVOICE_ROUTE)
    const { POST } = await import("../../app/api/admin/orders/[id]/invoice/route.ts")
    response = await POST(new Request(`http://harness/api/admin/orders/${order!.id}/invoice`, { method: "POST" }), {
      params: Promise.resolve({ id: String(order!.id) }),
    })
  } else if (command === "reconcile-invoice") {
    if (order!.invoice_requested_number == null || order!.invoice_status === "authorized") {
      throw new HomologationGuardError(`El pedido ${order!.id} no tiene una factura pendiente de conciliar.`)
    }
    assertRouteUsesShims(INVOICE_ROUTE)
    const { POST } = await import("../../app/api/admin/orders/[id]/invoice/route.ts")
    response = await POST(new Request(`http://harness/api/admin/orders/${order!.id}/invoice`, { method: "POST" }), {
      params: Promise.resolve({ id: String(order!.id) }),
    })
  } else if (command === "credit-note") {
    const amount = Number(required("amount", values.amount))
    const { getRemainingCreditableAmount } = await import("../../lib/orders/credit-note-remaining.ts")
    const remaining = await getRemainingCreditableAmount(admin, order!.id)
    if (remaining == null) throw new Error("No se pudo calcular el saldo acreditable del pedido.")
    assertCreditNoteTarget(order!, amount, remaining)
    const { data: notes, error } = await admin
      .from("order_credit_notes")
      .select("id, status")
      .eq("order_id", order!.id)
      .in("status", ["processing", "authorized"])
    if (error) throw new Error(`No se pudieron leer las NC del pedido: ${error.message}`)
    assertRouteUsesShims(CREDIT_NOTE_ROUTE)
    const { POST } = await import("../../app/api/admin/orders/[id]/credit-note/route.ts")
    response = await POST(
      new Request(`http://harness/api/admin/orders/${order!.id}/credit-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [],
          claim_id: null,
          expected_note_ids: (notes ?? []).map((note) => note.id),
          operation_type: "ajuste_manual",
          reason_code: "error_administrativo",
          reason_detail: "Prueba ARCA homologación (sin validez fiscal).",
          reason: "Prueba ARCA homologación",
          include_original_shipping: false,
          other_adjustment_amount: amount,
          reception_status: "no_requiere",
          reception_exception: false,
          destination: "customer_balance",
        }),
      }),
      { params: Promise.resolve({ id: String(order!.id) }) },
    )
  } else {
    const noteId = required("note", values.note)
    const { data: note } = await admin.from("order_credit_notes").select("id, order_id").eq("id", noteId).maybeSingle()
    if (!note || Number(note.order_id) !== order!.id) {
      throw new HomologationGuardError("La NC no pertenece al pedido de prueba indicado.")
    }
    assertRouteUsesShims(RECONCILE_ROUTE)
    const { POST } = await import("../../app/api/admin/credit-notes/[noteId]/reconcile/route.ts")
    response = await POST(new Request(`http://harness/api/admin/credit-notes/${noteId}/reconcile`, { method: "POST" }), {
      params: Promise.resolve({ noteId }),
    })
  }

  report.route = { status: response.status, body: await response.json().catch(() => null) }
  report.harness = { caeRequests: state.caeRequests, lostResponses: state.lostResponses }
  report.after = await invoiceFacts(admin, order!.id)
  console.log(JSON.stringify(report, null, 2))
}

async function invoiceFacts(admin: ReturnType<typeof import("../../lib/supabase/admin.ts").createAdminClient>, orderId: number) {
  const [{ data: order }, { data: notes }] = await Promise.all([
    admin
      .from("ordenes")
      .select("id, total, invoice_status, invoice_arca_environment, invoice_point, invoice_number, invoice_cae, invoice_cae_due, invoice_requested_number, invoice_error, financial_status, estado, payment_status, cancelled_at, cancellation_requested_at, order_change_status")
      .eq("id", orderId)
      .maybeSingle(),
    admin
      .from("order_credit_notes")
      .select("id, status, arca_environment, voucher_point, voucher_number, cae, total_amount, error, finalized_at")
      .eq("order_id", orderId),
  ])
  // Corte temprano; la regla autoritativa es order_is_invoiceable en la ruta.
  const invoiceable =
    order?.financial_status === "payment_confirmed" &&
    !order?.cancelled_at &&
    !order?.cancellation_requested_at &&
    !["change_requested", "extra_payment_pending"].includes(String(order?.order_change_status ?? ""))
  return { order, creditNotes: notes ?? [], invoiceable }
}

/** Solo lectura contra ARCA (WSAA vía TA persistido compartido). */
async function readArca(order: OrderFacts | null) {
  const wsfe = await import("../../lib/arca/wsfe.ts")
  const { getArcaPointOfSale } = await import("../../lib/arca/invoice-automation.ts")
  const point = getArcaPointOfSale()
  const result: Record<string, unknown> = {
    environment: wsfe.getArcaEnvironment(),
    dummy: await wsfe.getWsfeHealth(),
    lastInvoice: await wsfe.feCompUltimoAutorizado(point, wsfe.FACTURA_C_TYPE),
    lastCreditNote: await wsfe.feCompUltimoAutorizado(point, wsfe.NOTA_CREDITO_C_TYPE),
  }
  if (order) {
    const facts = await invoiceFacts((await import("../../lib/supabase/admin.ts")).createAdminClient(), order.id)
    const invoice = facts.order
    if (invoice?.invoice_number) {
      result.invoiceInArca = await wsfe.feCompConsultar(Number(invoice.invoice_point), Number(invoice.invoice_number), wsfe.FACTURA_C_TYPE)
    }
    result.creditNotesInArca = await Promise.all(
      facts.creditNotes
        .filter((note) => note.voucher_number != null)
        .map(async (note) => ({
          id: note.id,
          db: { number: note.voucher_number, total: note.total_amount, cae: note.cae, status: note.status },
          arca: await wsfe.feCompConsultar(Number(note.voucher_point), Number(note.voucher_number), wsfe.NOTA_CREDITO_C_TYPE),
        })),
    )
    result.db = facts
  }
  return result
}

main().catch((error) => {
  const guard = error instanceof HomologationGuardError
  console.error(guard ? `BLOQUEADO: ${error.message}` : error)
  process.exitCode = guard ? 3 : 1
})
