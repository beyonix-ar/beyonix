import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { persistDeclaredInput } from "../orders/transfer-verification-service.ts"
import {
  TRANSFER_DECLARATION_MISSING,
  getTransferDeclarationView,
} from "../orders/transfer-declaration-view.ts"
import {
  formatDeclaredPayerDocument,
  normalizeDeclaredDni,
  parseDeclaredPayerDocument,
} from "./argentine-identification.ts"
import {
  TRANSFER_DECLARATION_ERRORS,
  validateTransferDeclaration,
} from "./transfer-declaration.ts"

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

// CUIT/CUIL de persona física con dígito verificador válido (DNI 30.111.222).
const VALID_PERSON_CUIT = "20301112220"
const valid = { nombre: "María José", apellido: "Núñez", dni: "30.111.222", monto: "1.500,50" }

test("1-4. nombre, apellido, DNI/CUIT y monto son obligatorios", () => {
  const result = validateTransferDeclaration({})
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.deepEqual(result.errors, TRANSFER_DECLARATION_ERRORS)
  }
  for (const field of ["nombre", "apellido", "dni", "monto"] as const) {
    const missing = validateTransferDeclaration({ ...valid, [field]: "" })
    assert.equal(missing.ok, false, field)
  }
  assert.equal(validateTransferDeclaration(valid).ok, true)
})

test("5. nombre y apellido se guardan con trim (Unicode intacto)", () => {
  const result = validateTransferDeclaration({ ...valid, nombre: "  María   José ", apellido: "\tNúñez  " })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.firstName, "María José")
    assert.equal(result.value.lastName, "Núñez")
    assert.equal(result.value.document, "30111222")
    assert.equal(result.value.amount, 1500.5)
  }
  // Sólo espacios = vacío.
  assert.equal(validateTransferDeclaration({ ...valid, nombre: "   " }).ok, false)
  assert.equal(validateTransferDeclaration({ ...valid, apellido: "   " }).ok, false)
})

test("DNI/CUIT: DNI 7-8 dígitos o CUIT/CUIL válido; el DNI para conciliar sale del CUIT de persona", () => {
  assert.deepEqual(parseDeclaredPayerDocument("5.123.456"), { kind: "dni", number: "05123456", dni: "05123456" })
  assert.deepEqual(parseDeclaredPayerDocument("20-30111222-0"), {
    kind: "cuit",
    number: VALID_PERSON_CUIT,
    dni: "30111222",
  })
  assert.equal(parseDeclaredPayerDocument("20301112228"), null, "dígito verificador inválido")
  assert.equal(parseDeclaredPayerDocument("123"), null)
  assert.equal(parseDeclaredPayerDocument("abc"), null)
  // Compatibilidad: el DNI declarado sigue normalizándose igual que antes.
  assert.equal(normalizeDeclaredDni("30.111.222"), "30111222")
  assert.equal(normalizeDeclaredDni("5123456"), "05123456")
  assert.equal(normalizeDeclaredDni(VALID_PERSON_CUIT), "30111222")
  assert.equal(formatDeclaredPayerDocument("30111222"), "30.111.222")
  assert.equal(formatDeclaredPayerDocument("05123456"), "5.123.456")
  assert.equal(formatDeclaredPayerDocument(VALID_PERSON_CUIT), "20-30111222-0")
  assert.equal(validateTransferDeclaration({ ...valid, dni: "12" }).ok, false)
})

test("monto: parser es-AR, positivo y máximo 2 decimales", () => {
  for (const [input, expected] of [
    ["1500", 1500],
    ["1.500,50", 1500.5],
    ["1500.5", 1500.5],
    [8352.25, 8352.25],
  ] as const) {
    const result = validateTransferDeclaration({ ...valid, monto: input })
    assert.equal(result.ok && result.value.amount, expected, String(input))
  }
  for (const input of ["0", "-10", "1500,505", 1500.505, "abc", Number.NaN, null]) {
    assert.equal(validateTransferDeclaration({ ...valid, monto: input }).ok, false, String(input))
  }
})

test("6-7. el servidor rechaza nombre o apellido vacío (misma validación, antes de verificar)", () => {
  const route = readSource("../../app/api/transferencia/[orderId]/verificar/route.ts")
  const validation = route.indexOf("const declaration = validateTransferDeclaration(payload)")
  assert.ok(validation > 0)
  assert.ok(validation < route.indexOf("attemptTransferAutoVerification(admin"))
  // Después de validar dueño/token del pedido y antes de cualquier intento.
  assert.ok(route.indexOf("verifyGuestOrderAccessToken(guestToken, pedidoId)") < validation)
  assert.match(route, /if \(!declaration\.ok\) \{[\s\S]*?fieldErrors: declaration\.errors,[\s\S]*?\{ status: 400 \}/)
  assert.match(route, /declared: \{ firstName, lastName, dni: document, amount \}/)
  assert.doesNotMatch(route, /Nombre y apellido son opcionales/)

  const noFirstName = validateTransferDeclaration({ ...valid, nombre: "" })
  assert.equal(!noFirstName.ok && noFirstName.errors.firstName, TRANSFER_DECLARATION_ERRORS.firstName)
  const noLastName = validateTransferDeclaration({ ...valid, apellido: " " })
  assert.equal(!noLastName.ok && noLastName.errors.lastName, TRANSFER_DECLARATION_ERRORS.lastName)
})

test("8. los datos quedan asociados al pedido correcto (UPDATE por id + lease vigente)", async () => {
  const updates: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]> }> = []
  const admin = {
    from: (table: string) => {
      assert.equal(table, "ordenes")
      return {
        update: (payload: Record<string, unknown>) => {
          const entry = { payload, filters: [] as Array<[string, unknown]> }
          updates.push(entry)
          const chain = {
            eq: (column: string, value: unknown) => {
              entry.filters.push([column, value])
              return chain
            },
            then: (resolve: (value: unknown) => unknown) => resolve({ error: null }),
          }
          return chain
        },
      }
    },
  }

  await persistDeclaredInput(
    admin as never,
    42,
    { firstName: "María", lastName: "Núñez", dni: VALID_PERSON_CUIT, amount: 1500.5 },
    VALID_PERSON_CUIT,
    "lease-42",
  )

  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0].payload, {
    transfer_payer_first_name: "María",
    transfer_payer_last_name: "Núñez",
    // Se guarda el documento declarado (CUIT), no el DNI derivado.
    transfer_payer_dni: VALID_PERSON_CUIT,
    transfer_amount_declared: 1500.5,
  })
  assert.deepEqual(updates[0].filters, [
    ["id", 42],
    ["transfer_verification_lease_id", "lease-42"],
  ])

  const service = readSource("../orders/transfer-verification-service.ts")
  assert.match(service, /const declaredDocument = parseDeclaredPayerDocument\(declared\.dni\)\?\.number \?\? null/)
})

test("9. Admin muestra nombre, apellido, DNI/CUIT y monto declarados en la pestaña Pago", () => {
  const view = getTransferDeclarationView({
    transfer_payer_first_name: "María",
    transfer_payer_last_name: "Núñez",
    transfer_payer_dni: VALID_PERSON_CUIT,
    transfer_amount_declared: "1500.50",
    transfer_last_verification_at: "2026-09-23T20:00:00.000Z",
    transfer_verification_status: "manual_review",
  })
  assert.equal(view.firstName, "María")
  assert.equal(view.lastName, "Núñez")
  assert.equal(view.document, "20-30111222-0")
  assert.equal(view.declaredAmount, 1500.5)
  assert.equal(view.declaredAt, "2026-09-23T20:00:00.000Z")
  assert.equal(view.verificationLabel, "Requiere revisión manual")

  const admin = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")
  const pagoStart = admin.indexOf('{activeView === "pago" && capabilities.canManageFinancials')
  const section = admin.slice(admin.indexOf("const declaration = getTransferDeclarationView(pedido)"))
  assert.ok(admin.indexOf("const declaration = getTransferDeclarationView(pedido)") > pagoStart)
  for (const label of [
    "Datos de la transferencia",
    "Nombre del titular",
    "Apellido del titular",
    "DNI/CUIT del titular",
    "Monto declarado",
    "Fecha y hora de carga",
    "Estado de verificación",
    "Comprobante",
  ]) {
    assert.ok(section.indexOf(label) > 0 && section.indexOf(label) < section.indexOf("Conciliación automática"), label)
  }
  // Sin duplicar lo declarado en el panel de conciliación.
  assert.doesNotMatch(admin, /label="Nombre declarado"|label="DNI declarado"|label="Monto informado por el cliente"/)
})

test("10. pedido histórico sin datos del titular: 'No informado', nunca rompe", () => {
  const view = getTransferDeclarationView({})
  assert.equal(view.hasDeclaration, false)
  assert.equal(view.firstName, TRANSFER_DECLARATION_MISSING)
  assert.equal(view.lastName, TRANSFER_DECLARATION_MISSING)
  assert.equal(view.document, TRANSFER_DECLARATION_MISSING)
  assert.equal(view.declaredAmount, null)
  assert.equal(view.declaredAt, null)
  assert.equal(view.verificationLabel, "Sin intentos de verificación")
  // DNI histórico guardado "crudo" (no normalizable) se muestra tal cual.
  assert.equal(getTransferDeclarationView({ transfer_payer_dni: "abc" }).document, "abc")
  assert.equal(getTransferDeclarationView({ transfer_amount_declared: null }).declaredAmount, null)
})

test("11-12. comprobante: botón si existe; 'Sin comprobante adjunto' si no", () => {
  const withProof = getTransferDeclarationView({
    payment_proof_url: "payment-proofs/42/comprobante.pdf",
    payment_proof_file_name: "comprobante.pdf",
    payment_proof_uploaded_at: "2026-09-23T21:00:00.000Z",
  })
  assert.deepEqual(withProof.proof, {
    attached: true,
    fileName: "comprobante.pdf",
    uploadedAt: "2026-09-23T21:00:00.000Z",
  })
  assert.deepEqual(getTransferDeclarationView({}).proof, {
    attached: false,
    fileName: "Sin comprobante adjunto",
    uploadedAt: null,
  })

  const admin = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")
  const proofBlock = admin.slice(admin.indexOf("data-transfer-declaration-proof"))
  assert.match(proofBlock, /\{declaration\.proof\.attached && \(\s*<button[\s\S]*?onClick=\{\(\) => void handleViewPaymentProof\(\)\}[\s\S]*?Ver comprobante/)
  // Nunca se expone la ruta de Storage: se abre por el endpoint admin firmado.
  assert.doesNotMatch(proofBlock.slice(0, proofBlock.indexOf("</section>")), /payment_proof_url|href=/)
})

test("13. permisos: el comprobante sólo se firma para su dueño/token o para un operador admin", () => {
  const customerRoute = readSource("../../app/api/payment-proofs/[orderId]/route.ts")
  const ownerCheck = customerRoute.indexOf("if (order.usuario_id !== user?.id)")
  const guestCheck = customerRoute.indexOf("verifyGuestOrderAccessToken(guestToken, pedidoId)")
  assert.ok(ownerCheck > 0 && guestCheck > ownerCheck)
  const signing = customerRoute.indexOf("createSignedUrl(")
  if (signing > 0) assert.ok(signing > guestCheck, "la URL firmada se crea después de validar acceso")

  const adminRoute = readSource("../../app/api/admin/payment-proofs/[orderId]/route.ts")
  assert.ok(adminRoute.indexOf("await requireOperator(request)") < adminRoute.indexOf("createSignedUrl("))
  assert.match(adminRoute, /createSignedUrl\(stripBucket\(order\.payment_proof_url\), 300\)/)

  const verifyRoute = readSource("../../app/api/transferencia/[orderId]/verificar/route.ts")
  assert.match(verifyRoute, /if \(order\.usuario_id !== user\?\.id\) \{\s*return NextResponse\.json\(\{ error: "No autorizado\." \}, \{ status: 403 \}\)/)
})

function relativeLuminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(foreground: string, background: string) {
  const [light, dark] = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

test("14. 'Corregir datos de la transferencia' es un secundario con contraste en dark y light", () => {
  const flow = readSource("../../components/checkout/transfer-flow.tsx")
  assert.match(flow, /data-transfer-retry\s+className="transfer-retry-button mt-4 h-11 w-full"\s*>\s*Corregir datos de la transferencia/)
  assert.doesNotMatch(flow, /Volver a intentar con otros datos/)

  const css = readSource("../../app/globals.css")
  const dark = css.slice(css.indexOf("[data-transfer-retry].transfer-retry-button {"))
  assert.match(dark, /^\[data-transfer-retry\]\.transfer-retry-button \{\n  background-color: rgba\(140, 200, 242, 0\.08\) !important;\n  border: 1px solid rgba\(140, 200, 242, 0\.55\) !important;\n  color: #e2f1fc !important;/)
  // Fondo de la tarjeta en dark (--account-surface) y en light.
  assert.ok(contrast("#e2f1fc", "#0d1117") >= 7)
  assert.match(css, /html\[data-account-theme="light"\] \[data-transfer-retry\]\.transfer-retry-button \{\n  background-color: #ffffff !important;\n  border-color: #2f6fa3 !important;\n  color: #112a43 !important;/)
  assert.ok(contrast("#112a43", "#ffffff") >= 7)
})

test("copy: deja claro que son los datos del titular de la cuenta de origen", () => {
  const flow = readSource("../../components/checkout/transfer-flow.tsx")
  for (const copy of [
    "Estos datos pueden ser distintos a los de la persona que realizó la compra.",
    "Podés ingresar uno o todos sus nombres, como figuran en la cuenta desde donde transferiste (ej.: Romina Ayelen).",
    "Apellido/s de la persona titular de esa cuenta (ej.: Pérez).",
    "Ingresá el documento del titular de la cuenta desde donde se realizó la transferencia.",
    "Ingresá exactamente el importe enviado.",
  ]) {
    assert.ok(flow.includes(copy), copy)
  }
  for (const label of ["Nombre/s del titular", "Apellido/s del titular", "DNI/CUIT del titular", "Monto exacto transferido"]) {
    assert.ok(flow.includes(`label="${label}"`), label)
  }
})

test("nombres y apellidos compuestos: se aceptan completos o con un solo nombre, con tildes y espacios normalizados", () => {
  for (const [nombre, apellido] of [
    ["Romina Ayelen", "Pérez"],
    ["Romina", "Pérez"],
    ["Ayelen", "Pérez"],
    ["María Teresita", "De la Fuente"],
    ["Juan Manuel", "Gómez Núñez"],
  ]) {
    const result = validateTransferDeclaration({ ...valid, nombre, apellido })
    assert.equal(result.ok, true, `${nombre} ${apellido}`)
    if (result.ok) {
      assert.equal(result.value.firstName, nombre)
      assert.equal(result.value.lastName, apellido)
    }
  }
  const spaced = validateTransferDeclaration({ ...valid, nombre: "  Romina   Ayelen ", apellido: " Pérez  " })
  assert.equal(spaced.ok, true)
  if (spaced.ok) {
    assert.equal(spaced.value.firstName, "Romina Ayelen")
    assert.equal(spaced.value.lastName, "Pérez")
  }
})

test("formulario: nombre/s y apellido/s del titular, sin forzar un único nombre", () => {
  const flow = readSource("../../components/checkout/transfer-flow.tsx")
  assert.match(flow, /label="Nombre\/s del titular"/)
  assert.match(flow, /Podés ingresar uno o todos sus nombres/)
  assert.match(flow, /label="Apellido\/s del titular"/)
})
