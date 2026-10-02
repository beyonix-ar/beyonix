import assert from "node:assert/strict"
import test from "node:test"

import {
  argentinaLocalToUtcIso,
  formatArgentinaDateTime,
  toArgentinaLocalParts,
} from "./argentina-time.ts"
import {
  findFinancingConflict,
  findPriceConflict,
  getControllingFinancingEvent,
  getDueEventActions,
  parseScheduledEventInput,
  windowsOverlap,
  type CommercialEventRow,
} from "./scheduled-events.ts"

const NOW = new Date("2026-10-01T15:00:00.000Z") // 01/10/2026 12:00 Argentina

function row(overrides: Partial<CommercialEventRow>): CommercialEventRow {
  return {
    id: "e1",
    internal_name: "Evento",
    event_type: "price_change",
    status: "scheduled",
    starts_on: null,
    duration_days: null,
    starts_at: "2026-10-03T21:00:00.000Z",
    ends_at: "2026-10-06T02:59:00.000Z",
    scope: "store",
    target_items: [],
    action_kind: "price_decrease_percent",
    value: 10,
    financing_policy: null,
    previous_financing_policy: null,
    executed_at: null,
    restored_at: null,
    cancelled_at: null,
    failed_phase: null,
    last_error: null,
    result: null,
    activated_at: null,
    created_by: null,
    updated_by: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  }
}

// ─── Horario Argentina ───

test("timezone: el Admin carga hora de Argentina y el backend guarda el instante UTC exacto", () => {
  assert.equal(argentinaLocalToUtcIso("2026-10-05", "03:00"), "2026-10-05T06:00:00.000Z")
  assert.equal(argentinaLocalToUtcIso("2026-10-03", "18:00"), "2026-10-03T21:00:00.000Z")
  assert.equal(argentinaLocalToUtcIso("2026-12-31", "23:59"), "2027-01-01T02:59:00.000Z")
  assert.deepEqual(toArgentinaLocalParts("2026-10-05T06:00:00.000Z"), { date: "2026-10-05", time: "03:00" })
  assert.equal(formatArgentinaDateTime("2026-10-01T06:00:00.000Z"), "jue 01/10/2026 03:00")
  for (const [date, time] of [["2026-02-30", "10:00"], ["2026-10-05", "24:00"], ["05/10/2026", "03:00"], ["", ""]]) {
    assert.equal(argentinaLocalToUtcIso(date, time), null, `${date} ${time}`)
  }
})

// ─── Validación ───

const financingBody = (overrides: Record<string, unknown> = {}) => ({
  internal_name: "Promo financiación fin de semana",
  event_type: "financing_policy",
  starts_date: "2026-10-03",
  starts_time: "18:00",
  ends_date: "2026-10-05",
  ends_time: "23:59",
  financing_policy: "same_as_cash",
  ...overrides,
})
const priceBody = (overrides: Record<string, unknown> = {}) => ({
  internal_name: "Aumento lunes",
  event_type: "price_change",
  starts_date: "2026-10-05",
  starts_time: "03:00",
  revert: false,
  action_kind: "price_increase_percent",
  value: 5,
  scope: "store",
  ...overrides,
})
const errorOf = (body: Record<string, unknown>) => {
  const result = parseScheduledEventInput(body, NOW)
  return "error" in result ? result.error : null
}

test("financiación promocional: inicio y fin en hora de Argentina, siempre temporal", () => {
  const result = parseScheduledEventInput(financingBody(), NOW)
  assert.ok("value" in result)
  assert.equal(result.value.startsAt, "2026-10-03T21:00:00.000Z")
  assert.equal(result.value.endsAt, "2026-10-06T02:59:00.000Z")
  assert.equal(result.value.financingPolicy, "same_as_cash")
  assert.match(errorOf(financingBody({ ends_date: "", ends_time: "" })) ?? "", /necesita fecha y hora de finalización/)
  assert.match(errorOf(financingBody({ ends_date: "2026-10-03", ends_time: "17:00" })) ?? "", /posterior al inicio/)
  assert.match(errorOf(financingBody({ financing_policy: "cover_costs" })) ?? "", /política/)
})

test("cambio de precios: permanente sin fin; con 'Revertir' exige fin válido", () => {
  const permanent = parseScheduledEventInput(priceBody(), NOW)
  assert.ok("value" in permanent)
  assert.equal(permanent.value.endsAt, null)
  assert.equal(permanent.value.startsAt, "2026-10-05T06:00:00.000Z")
  assert.match(errorOf(priceBody({ revert: true })) ?? "", /revierten los precios/)
  const reverting = parseScheduledEventInput(priceBody({ revert: true, ends_date: "2026-10-06", ends_time: "03:00" }), NOW)
  assert.ok("value" in reverting && reverting.value.endsAt === "2026-10-06T06:00:00.000Z")
})

test("cambio por monto: conserva valor, permite reversión y rechaza montos inválidos", () => {
  for (const action of ["price_increase_amount", "price_decrease_amount"]) {
    const result = parseScheduledEventInput(priceBody({ action_kind: action, value: "5000.25", revert: true, ends_date: "2026-10-06", ends_time: "03:00" }), NOW)
    assert.ok("value" in result)
    assert.equal(result.value.value, 5000.25)
    assert.equal(result.value.endsAt, "2026-10-06T06:00:00.000Z")
  }
  assert.match(errorOf(priceBody({ action_kind: "price_decrease_amount", value: 0 })) ?? "", /monto debe ser positivo/)
})

test("seguridad: sin fecha válida, en el pasado, porcentajes absurdos o alcance vacío no se guarda", () => {
  assert.match(errorOf(priceBody({ starts_date: "" })) ?? "", /fecha y hora de inicio válidas/)
  assert.match(errorOf(priceBody({ starts_date: "2026-10-01", starts_time: "11:00" })) ?? "", /posterior a este momento/)
  assert.match(errorOf(priceBody({ value: 150 })) ?? "", /entre 1 y 99/)
  assert.match(errorOf(priceBody({ value: 0 })) ?? "", /entre 1 y 99/)
  assert.match(errorOf(priceBody({ action_kind: "price_increase_amount", value: -1000 })) ?? "", /monto debe ser positivo/)
  assert.match(errorOf(priceBody({ scope: "product", target_items: [] })) ?? "", /al menos un producto/)
  assert.match(errorOf(priceBody({ internal_name: "  " })) ?? "", /nombre interno/)
  assert.match(errorOf(priceBody({ event_type: "otro" })) ?? "", /tipo de evento/)
})

// ─── Conflictos ───

test("ventanas semiabiertas: termina 23:59 y otro empieza 23:59 no chocan; superpuestos sí", () => {
  const a = { startsAt: "2026-10-03T21:00:00.000Z", endsAt: "2026-10-06T02:59:00.000Z" }
  assert.equal(windowsOverlap(a, { startsAt: "2026-10-06T02:59:00.000Z", endsAt: "2026-10-07T02:59:00.000Z" }), false)
  assert.equal(windowsOverlap(a, { startsAt: "2026-10-04T13:00:00.000Z", endsAt: "2026-10-06T13:00:00.000Z" }), true)
  // Dos cambios permanentes en el mismo minuto chocan.
  assert.equal(windowsOverlap({ startsAt: "2026-10-05T06:00:00.000Z", endsAt: null }, { startsAt: "2026-10-05T06:00:30.000Z", endsAt: null }), true)
})

test("financiación: el ejemplo vie 18 → dom 23:59 vs sáb 10 → lun 10 es conflicto; cancelado o finalizado no", () => {
  const weekend = row({ id: "a", event_type: "financing_policy", financing_policy: "same_as_cash" })
  const candidate = { startsAt: "2026-10-04T13:00:00.000Z", endsAt: "2026-10-06T13:00:00.000Z" }
  assert.equal(findFinancingConflict(candidate, [weekend])?.id, "a")
  for (const status of ["cancelled", "finished"] as const) {
    assert.equal(findFinancingConflict(candidate, [{ ...weekend, status }]), null, status)
  }
  assert.equal(findFinancingConflict({ ...candidate, id: "a" }, [weekend]), null, "al editarse no choca consigo mismo")
  assert.equal(findFinancingConflict(candidate, [{ ...weekend, event_type: "price_change" }]), null, "precios no bloquean financiación")
})

test("precios: conflicto sólo si comparten productos en la misma franja", () => {
  const other = row({ id: "b", starts_at: "2026-10-05T06:00:00.000Z", ends_at: null })
  const candidate = { startsAt: "2026-10-05T06:00:00.000Z", endsAt: null, productIds: [1, 2] }
  assert.deepEqual(findPriceConflict(candidate, [{ event: other, productIds: [2, 3] }])?.productIds, [2])
  assert.equal(findPriceConflict(candidate, [{ event: other, productIds: [3, 4] }]), null, "productos distintos no chocan")
  assert.equal(findPriceConflict({ ...candidate, startsAt: "2026-10-05T07:00:00.000Z" }, [{ event: other, productIds: [1] }]), null)
})

// ─── Ejecución ───

test("scheduler: primero restaura lo que termina y después aplica lo que empieza; nunca reintenta errores", () => {
  const now = new Date("2026-10-06T03:00:00.000Z")
  const ending = row({ id: "ending", status: "active", event_type: "financing_policy", ends_at: "2026-10-06T02:59:00.000Z" })
  const starting = row({ id: "starting", status: "scheduled", starts_at: "2026-10-06T02:59:00.000Z", ends_at: "2026-10-07T02:59:00.000Z" })
  const future = row({ id: "future", status: "scheduled", starts_at: "2026-10-10T00:00:00.000Z" })
  const failed = row({ id: "failed", status: "error", failed_phase: "apply", starts_at: "2026-10-05T00:00:00.000Z" })
  const permanentDone = row({ id: "done", status: "finished", ends_at: null })
  const legacy = row({ id: "legacy", status: "active", starts_at: null, ends_at: null })
  assert.deepEqual(
    getDueEventActions([starting, future, failed, permanentDone, legacy, ending], now).map((item) => [item.event.id, item.phase]),
    [["ending", "restore"], ["starting", "apply"]],
  )
})

test("evento que controla la política: activo, o trabado con error al restaurar", () => {
  const scheduled = row({ id: "s", event_type: "financing_policy" })
  assert.equal(getControllingFinancingEvent([scheduled]), null)
  assert.equal(getControllingFinancingEvent([scheduled, { ...scheduled, id: "a", status: "active" }])?.id, "a")
  assert.equal(getControllingFinancingEvent([{ ...scheduled, id: "r", status: "error", failed_phase: "restore" }])?.id, "r")
  assert.equal(getControllingFinancingEvent([{ ...scheduled, id: "x", status: "error", failed_phase: "apply" }]), null)
})
