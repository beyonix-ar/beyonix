import assert from "node:assert/strict"
import test from "node:test"

import {
  getCustomerClaimPollIntervalMs,
  isTerminalClaimStatus,
  shouldPollClaimList,
  shouldPollSingleClaim,
} from "./claim-polling.ts"

test("cerrado y rechazado son estados terminales", () => {
  assert.equal(isTerminalClaimStatus("cerrado"), true)
  assert.equal(isTerminalClaimStatus("rechazado"), true)
})

test("en_revision, recibido, aprobado no son terminales", () => {
  assert.equal(isTerminalClaimStatus("en_revision"), false)
  assert.equal(isTerminalClaimStatus("recibido"), false)
  assert.equal(isTerminalClaimStatus("aprobado"), false)
})

test("admin: un claim abierto debe seguir polleandose", () => {
  assert.equal(shouldPollSingleClaim("en_revision"), true)
})

test("admin: un claim cerrado/rechazado deja de pollearse (se reduce a foco de ventana)", () => {
  assert.equal(shouldPollSingleClaim("cerrado"), false)
  assert.equal(shouldPollSingleClaim("rechazado"), false)
})

test("cliente: con al menos un claim abierto, sigue polleando", () => {
  assert.equal(
    shouldPollClaimList([{ status: "cerrado" }, { status: "en_revision" }]),
    true,
  )
})

test("cliente: con todos los claims terminados, deja de pollear", () => {
  assert.equal(
    shouldPollClaimList([{ status: "cerrado" }, { status: "rechazado" }]),
    false,
  )
})

test("cliente: un claim que se cierra durante la sesión reduce el polling en el siguiente chequeo", () => {
  const beforeClose = [{ status: "en_revision" }]
  const afterClose = [{ status: "cerrado" }]

  assert.equal(shouldPollClaimList(beforeClose), true)
  assert.equal(shouldPollClaimList(afterClose), false)
})

test("cliente: una reapertura o un caso nuevo reactivan el polling", () => {
  const allClosed = [{ status: "cerrado" }]
  const withNewOpenCase = [{ status: "cerrado" }, { status: "recibido" }]

  assert.equal(shouldPollClaimList(allClosed), false)
  assert.equal(shouldPollClaimList(withNewOpenCase), true)
})

test("cliente: sin claims cargados todavía, sigue polleando (para detectar el primero)", () => {
  assert.equal(shouldPollClaimList([]), true)
})

test("cliente: intervalo activo (20s) mientras hay un claim sin terminar", () => {
  assert.equal(
    getCustomerClaimPollIntervalMs([{ status: "en_revision" }]),
    20_000,
  )
})

test("cliente: el intervalo nunca se apaga del todo, aun con todo terminado (5 min)", () => {
  assert.equal(
    getCustomerClaimPollIntervalMs([{ status: "cerrado" }, { status: "rechazado" }]),
    5 * 60_000,
  )
})

test("cliente: una reapertura vuelve a acelerar el intervalo", () => {
  const allClosed = [{ status: "cerrado" }]
  const reopened = [{ status: "en_revision" }]

  assert.equal(getCustomerClaimPollIntervalMs(allClosed), 5 * 60_000)
  assert.equal(getCustomerClaimPollIntervalMs(reopened), 20_000)
})
