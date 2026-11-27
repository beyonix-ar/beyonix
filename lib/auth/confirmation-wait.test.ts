import assert from "node:assert/strict"
import test from "node:test"

import {
  getConfirmationDestinationLabel,
  getConfirmationWaitMode,
  shouldLeaveLoginWithSession,
} from "./confirmation-wait.ts"

const HANDOFF = "0c0a6f5e-7d0b-4b8e-9d55-1c4c2f4b9a10"

test("con handoff en memoria la espera es automática; tras recargar la pestaña (sin handoff) es manual", () => {
  assert.equal(getConfirmationWaitMode(HANDOFF), "automatic")
  assert.equal(getConfirmationWaitMode(""), "manual")
  assert.equal(getConfirmationWaitMode("   "), "manual")
})

test("sin pantalla de confirmación, una sesión válida sale de /login como siempre", () => {
  assert.equal(
    shouldLeaveLoginWithSession({ isLoading: false, hasUser: true, confirmationEmail: "", confirmationHandoff: "" }),
    true,
  )
})

test("mientras la sesión se resuelve o no hay usuario, /login no navega", () => {
  for (const confirmationEmail of ["", "ana.peña@example.com"]) {
    assert.equal(
      shouldLeaveLoginWithSession({ isLoading: true, hasUser: true, confirmationEmail, confirmationHandoff: "" }),
      false,
    )
    assert.equal(
      shouldLeaveLoginWithSession({ isLoading: false, hasUser: false, confirmationEmail, confirmationHandoff: HANDOFF }),
      false,
    )
  }
})

test("espera automática: la consulta de confirmación decide la navegación (no hay doble redirección)", () => {
  assert.equal(
    shouldLeaveLoginWithSession({
      isLoading: false,
      hasUser: true,
      confirmationEmail: "ana.peña@example.com",
      confirmationHandoff: HANDOFF,
    }),
    false,
  )
})

test("espera manual (pestaña recargada): si aparece la sesión, por ejemplo confirmada en otra pestaña del mismo navegador, vuelve al destino en vez de quedar en \"Ingreso confirmado\"", () => {
  assert.equal(
    shouldLeaveLoginWithSession({
      isLoading: false,
      hasUser: true,
      confirmationEmail: "ana.peña@example.com",
      confirmationHandoff: "",
    }),
    true,
  )
})

test("el texto de destino coincide con el ?redirect= real: el checkout no se anuncia como el inicio", () => {
  assert.equal(getConfirmationDestinationLabel("/"), "al inicio")
  assert.equal(getConfirmationDestinationLabel("/checkout"), "de vuelta a tu compra")
})
