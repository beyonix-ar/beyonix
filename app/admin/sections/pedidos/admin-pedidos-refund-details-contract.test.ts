import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// Fase 4 (cierre del módulo cancelaciones/reintegros/NC), puntos 2 y 6.
// Contrato de texto -- este archivo (~7000 líneas, con hooks/estado de UI)
// no se importa/ejecuta directamente en los tests de este proyecto (ver el
// resto de tests de esta carpeta y de components/claims, todos de
// contrato). Normaliza CRLF -> LF por la misma razón que el resto de los
// tests de esta carpeta (checkouts Windows).
const source = readFileSync(
  new URL("./admin-pedidos.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n")

test("punto 2: el formulario de registrar reintegro envía referencia, fecha y observación al backend", () => {
  assert.match(source, /formData\.set\("reference", reference\.trim\(\)\)/)
  assert.match(source, /formData\.set\("refundDate", refundDate\.trim\(\)\)/)
  assert.match(source, /formData\.set\("notes", notes\.trim\(\)\)/)
})

test("punto 2: los tres campos son opcionales -- sólo se envían si el admin cargó algo", () => {
  assert.match(source, /if \(reference\.trim\(\)\) formData\.set\("reference"/)
  assert.match(source, /if \(refundDate\.trim\(\)\) formData\.set\("refundDate"/)
  assert.match(source, /if \(notes\.trim\(\)\) formData\.set\("notes"/)
})

test("punto 6: 'Proceso finalizado' muestra la referencia y la observación del último comprobante persistido", () => {
  assert.match(source, /latestProof\?\.bank_reference && <li>Referencia: \{latestProof\.bank_reference\}<\/li>/)
  assert.match(source, /latestProof\?\.observation && <li>Observación: \{latestProof\.observation\}<\/li>/)
})

test("punto 6: 'Proceso finalizado' muestra el CAE de la nota de crédito cuando existe", () => {
  assert.match(source, /pedido\.credit_note_cae && ` \(CAE \$\{pedido\.credit_note_cae\}\)`/)
})

test("punto 6: 'Proceso finalizado' muestra el saldo restaurado cuando corresponde", () => {
  assert.match(
    source,
    /model\.amounts\.balanceRestored > 0 && \(\s*\n\s*<li>Saldo restaurado: \{formatPrice\(model\.amounts\.balanceRestored\)\}<\/li>/,
  )
})

test("el importe del formulario de reintegro nunca es un input editable -- siempre viene de model.amounts.amountToRefund", () => {
  const formSection = source.slice(
    source.indexOf('model.primaryAction?.kind === "register_external_refund"'),
    source.indexOf('model.primaryAction?.kind === "execute_mp_refund"'),
  )
  assert.ok(formSection.length > 0)
  assert.doesNotMatch(formSection, /<input[^>]*name=["']amount["']/)
  assert.match(formSection, /\{formatPrice\(model\.amounts\.amountToRefund\)\}/)
})
