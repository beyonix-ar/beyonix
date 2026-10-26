import assert from "node:assert/strict"
import test from "node:test"

import { createAnalyticsRefreshScheduler, formatCountdown } from "./refresh-scheduler.ts"

function deferred() {
  let resolve!: (ok: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function harness(options: { hidden?: boolean } = {}) {
  let clock = 1_000_000
  let hidden = options.hidden ?? false
  const runs: { signal: AbortSignal; done: ReturnType<typeof deferred> }[] = []
  const scheduler = createAnalyticsRefreshScheduler({
    now: () => clock,
    isHidden: () => hidden,
    runTasks: (signal) => {
      const done = deferred()
      runs.push({ signal, done })
      return done.promise
    },
  })
  return {
    scheduler,
    runs,
    advance(ms: number) { clock += ms },
    setHidden(value: boolean) { hidden = value },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  }
}

test("formato mm:ss", () => {
  assert.equal(formatCountdown(60), "01:00")
  assert.equal(formatCountdown(59), "00:59")
  assert.equal(formatCountdown(5.4), "00:05")
  assert.equal(formatCountdown(0), "00:00")
  assert.equal(formatCountdown(-3), "00:00")
})

test("arranca en 01:00 y baja según la hora real, no por cantidad de ticks", () => {
  const { scheduler, advance } = harness()
  assert.equal(scheduler.getSnapshot().secondsRemaining, 60)
  advance(1_000); scheduler.tick()
  assert.equal(scheduler.getSnapshot().secondsRemaining, 59)
  advance(250); scheduler.tick()
  assert.equal(scheduler.getSnapshot().secondsRemaining, 59, "los ticks intermedios no restan de más")
  advance(13_750); scheduler.tick()
  assert.equal(scheduler.getSnapshot().secondsRemaining, 45, "un salto largo entre ticks se refleja completo")
})

test("en 00:00 refresca una vez y al terminar reinicia en 01:00", async () => {
  const h = harness()
  h.advance(59_999); h.scheduler.tick()
  assert.equal(h.runs.length, 0)
  h.advance(1); h.scheduler.tick()
  assert.equal(h.runs.length, 1)
  assert.equal(h.scheduler.getSnapshot().isRefreshing, true)
  h.advance(1_000); h.scheduler.tick(); h.scheduler.tick()
  assert.equal(h.runs.length, 1, "mientras actualiza no dispara otro")
  h.runs[0].done.resolve(true)
  await h.settle()
  assert.deepEqual(h.scheduler.getSnapshot(), { secondsRemaining: 60, isRefreshing: false, refreshVersion: 1, lastRefreshFailed: false })
})

test("Actualizar ahora refresca ya, reinicia el contador y nunca superpone ciclos con el automático", async () => {
  const h = harness()
  h.advance(20_000); h.scheduler.tick()
  const manual = h.scheduler.refreshNow()
  const again = h.scheduler.refreshNow()
  assert.equal(manual, again, "doble click: el mismo ciclo")
  h.advance(60_000); h.scheduler.tick()
  assert.equal(h.runs.length, 1, "vencimiento durante el refresh manual: una sola consulta")
  h.runs[0].done.resolve(true)
  await manual
  assert.equal(h.scheduler.getSnapshot().secondsRemaining, 60)
  assert.equal(h.scheduler.getSnapshot().refreshVersion, 1)
})

test("un ciclo fallido no rompe el siguiente: se informa y el contador vuelve a empezar", async () => {
  const h = harness()
  const first = h.scheduler.refreshNow()
  h.runs[0].done.reject(new Error("500"))
  await first
  assert.deepEqual(h.scheduler.getSnapshot(), { secondsRemaining: 60, isRefreshing: false, refreshVersion: 1, lastRefreshFailed: true })
  h.advance(60_000); h.scheduler.tick()
  assert.equal(h.runs.length, 2, "el siguiente refresh ocurre normalmente")
  h.runs[1].done.resolve(true)
  await h.settle()
  assert.equal(h.scheduler.getSnapshot().lastRefreshFailed, false)
})

test("cambiar el período cancela el ciclo anterior y arranca otro (sus datos serían viejos)", async () => {
  const h = harness()
  h.advance(30_000)
  void h.scheduler.refreshNow()
  const restarted = h.scheduler.restart()
  assert.equal(h.runs[0].signal.aborted, true)
  assert.equal(h.runs.length, 2)
  h.runs[0].done.resolve(true)
  await h.settle()
  assert.equal(h.scheduler.getSnapshot().isRefreshing, true, "el ciclo cancelado no cierra el nuevo")
  h.advance(2_000)
  h.runs[1].done.resolve(true)
  await restarted
  assert.equal(h.scheduler.getSnapshot().secondsRemaining, 60, "contador reiniciado desde que terminó la carga")
  assert.equal(h.scheduler.getSnapshot().refreshVersion, 1)
})

test("pestaña dormida varios minutos: al volver, UNA sola actualización", async () => {
  const h = harness()
  h.setHidden(true)
  h.advance(5 * 60_000)
  for (let index = 0; index < 20; index += 1) h.scheduler.tick()
  assert.equal(h.runs.length, 0, "oculta: no refresca ni acumula")
  assert.equal(h.scheduler.getSnapshot().secondsRemaining, 0)
  h.setHidden(false)
  h.scheduler.tick(); h.scheduler.tick(); h.scheduler.tick()
  assert.equal(h.runs.length, 1)
  h.runs[0].done.resolve(true)
  await h.settle()
  h.scheduler.tick()
  assert.equal(h.runs.length, 1)
  assert.equal(h.scheduler.getSnapshot().secondsRemaining, 60)
})

test("timers frenados (sin ocultar): un salto de varios minutos dispara un solo refresh", async () => {
  const h = harness()
  h.advance(7 * 60_000)
  h.scheduler.tick(); h.scheduler.tick()
  assert.equal(h.runs.length, 1)
  h.runs[0].done.resolve(true)
  await h.settle()
  h.scheduler.tick()
  assert.equal(h.runs.length, 1, "no se recuperan refresh atrasados")
})

test("cancel (desmontar) aborta el ciclo en curso y no aplica su resultado", async () => {
  const h = harness()
  void h.scheduler.refreshNow()
  h.scheduler.cancel()
  assert.equal(h.runs[0].signal.aborted, true)
  assert.equal(h.scheduler.getSnapshot().isRefreshing, false)
  h.runs[0].done.resolve(true)
  await h.settle()
  assert.equal(h.scheduler.getSnapshot().refreshVersion, 0)
})

test("suscriptores: sólo se notifica cuando cambia lo visible", () => {
  const h = harness()
  let notifications = 0
  const unsubscribe = h.scheduler.subscribe(() => { notifications += 1 })
  h.advance(100); h.scheduler.tick(); h.scheduler.tick()
  assert.equal(notifications, 0, "60 → 60: sin render")
  h.advance(1_000); h.scheduler.tick()
  assert.equal(notifications, 1)
  unsubscribe()
  h.advance(1_000); h.scheduler.tick()
  assert.equal(notifications, 1)
})
