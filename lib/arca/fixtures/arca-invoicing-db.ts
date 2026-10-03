import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"

import type { ArcaEnvironment } from "../environment.ts"
import type { AssociatedVoucherRef, AuthorizedVoucher, FecaeRequest, FecaeResult } from "../wsfe.ts"
import type { ArcaInvoiceGateway } from "../invoice-automation.ts"

// Soporte de tests de la facturación automática: PostgreSQL en memoria con la
// migración REAL (20260927100000) y un ARCA simulado con numeración real.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

export const ENVIRONMENT_ISOLATION_MIGRATION = "supabase/migrations/20260927120000_arca_environment_isolation.sql"
export const AUTO_ACTIVATION_MIGRATION = "supabase/migrations/20261003120000_arca_auto_invoicing_activation.sql"

/**
 * environmentIsolation=false deja la base como estaba ANTES de 20260927120000
 * (para probar el backfill aplicándola después con applyEnvironmentIsolation).
 */
export async function setupInvoicingDb({ environmentIsolation = true } = {}) {
  const db = new PGlite()
  await db.exec(read("lib/arca/fixtures/arca-invoicing-schema.sql"))
  const reproducibility = read("supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql")
  const consumes = reproducibility.match(
    /create or replace function public\.inventory_order_consumes_stock\([\s\S]*?\n\$function\$;/,
  )?.[0]
  assert.ok(consumes, "inventory_order_consumes_stock real")
  await db.exec(consumes)
  await db.exec(read("supabase/migrations/20260927100000_arca_automatic_invoicing.sql"))
  if (environmentIsolation) await applyEnvironmentIsolation(db)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

export async function applyEnvironmentIsolation(db: PGlite) {
  await db.exec(read(ENVIRONMENT_ISOLATION_MIGRATION))
}

export async function applyAutoActivation(db: PGlite) {
  await db.exec(read(AUTO_ACTIVATION_MIGRATION))
}

export type OrderSeed = {
  estado?: string
  payment_status?: string | null
  financial_status?: string | null
  payment_method_id?: string
  total?: number
}

export async function insertOrder(db: PGlite, seed: OrderSeed = {}) {
  const { rows } = await db.query<{ id: number }>(
    `insert into ordenes (estado, payment_status, financial_status, payment_method_id, total)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      seed.estado ?? "pendiente",
      seed.payment_status ?? "pending",
      seed.financial_status ?? "pending_payment",
      seed.payment_method_id ?? "mercadopago",
      seed.total ?? 1000,
    ],
  )
  return Number(rows[0].id)
}

/** Confirmación tal como la dejan MP / transferencia / saldo a favor. */
export async function confirmOrder(db: PGlite, id: number, paymentStatus = "approved") {
  await db.query(
    "update ordenes set estado='pagado', payment_status=$2, financial_status='payment_confirmed' where id=$1",
    [id, paymentStatus],
  )
}

export async function loadOrder(db: PGlite, id: number) {
  return (await db.query<Record<string, unknown>>("select * from ordenes where id=$1", [id])).rows[0]
}

/** Cliente con la misma forma que supabase-js (.rpc) sobre PGlite. */
export function rpcClient(db: PGlite, hooks: { beforeRpc?: (name: string) => void } = {}) {
  const signatures: Record<string, string[]> = {
    claim_arca_invoice: ["p_order_id::bigint", "p_lease::interval", "p_manual::boolean"],
    record_arca_invoice_request: ["p_order_id::bigint", "p_point::integer", "p_type::integer", "p_number::bigint", "p_total::numeric", "p_date::text", "p_environment::text"],
    complete_arca_invoice: ["p_order_id::bigint", "p_point::integer", "p_type::integer", "p_number::bigint", "p_cae::text", "p_cae_due::date", "p_issued_at::timestamptz", "p_reconciled::boolean", "p_environment::text"],
    fail_arca_invoice_attempt: ["p_order_id::bigint", "p_error::text", "p_retry_after::interval", "p_release_request::boolean"],
  }
  return {
    async rpc(name: string, args: Record<string, unknown>) {
      hooks.beforeRpc?.(name)
      const params = signatures[name]
      assert.ok(params, `rpc desconocida ${name}`)
      const values = params.map((param) => args[param.split("::")[0]] ?? null)
      const placeholders = params.map((param, index) => `$${index + 1}::${param.split("::")[1]}`)
      try {
        const { rows } = await db.query(`select * from ${name}(${placeholders.join(", ")})`, values)
        return { data: rows, error: null }
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } }
      }
    },
  }
}

export class FakeArcaError extends Error {
  readonly definitive: boolean

  constructor(message: string, definitive: boolean) {
    super(message)
    this.definitive = definitive
  }
}

type NextBehavior = "ok" | "down" | "reject" | "lost_after_authorize"

type FakeVoucher = {
  total: number
  cae: string
  caeDue: string
  date: string
  /** Como FECompConsultar: CbtesAsoc de la NC (vacío en una factura). */
  associated?: AssociatedVoucherRef[]
}

/** ARCA simulado: numeración secuencial real por punto de venta y tipo. */
export class FakeArca implements ArcaInvoiceGateway {
  vouchers = new Map<number, FakeVoucher>()
  requests = 0
  next: NextBehavior[] = []
  down = false
  readonly pointOfSale: number
  /** Cada instancia es UN ambiente ARCA con su propia numeración. */
  readonly environment: ArcaEnvironment

  constructor(pointOfSale = 3, environment: ArcaEnvironment = "homologation") {
    this.pointOfSale = pointOfSale
    this.environment = environment
  }

  private last() {
    return Math.max(0, ...this.vouchers.keys())
  }

  async lastAuthorized(): Promise<number> {
    if (this.down) throw new FakeArcaError("WSFEv1 rechazó FECompUltimoAutorizado: HTTP 503.", false)
    return this.last()
  }

  async consult(_point: number, voucherNumber: number, voucherType: number): Promise<AuthorizedVoucher | null> {
    if (this.down) throw new FakeArcaError("WSFEv1 rechazó FECompConsultar: HTTP 503.", false)
    const voucher = this.vouchers.get(voucherNumber)
    if (!voucher) return null
    return {
      pointOfSale: this.pointOfSale,
      voucherType,
      voucherNumber,
      voucherDate: voucher.date,
      total: voucher.total,
      cae: voucher.cae,
      caeDueDate: voucher.caeDue,
      result: "A",
      associatedVouchers: voucher.associated ?? [],
    }
  }

  async requestCae(request: FecaeRequest): Promise<FecaeResult> {
    this.requests += 1
    const behavior = this.next.shift() ?? "ok"
    if (this.down || behavior === "down") {
      throw new FakeArcaError("WSFEv1 rechazó FECAESolicitar: HTTP 503.", false)
    }
    if (behavior === "reject") {
      throw new FakeArcaError("ARCA rechazó la solicitud de CAE. 10016: número incorrecto", true)
    }
    if (request.voucherNumber !== this.last() + 1) {
      throw new FakeArcaError(`ARCA rechazó la solicitud de CAE. 10016: se esperaba ${this.last() + 1}`, true)
    }
    const cae = `7${String(request.voucherNumber).padStart(13, "0")}`
    this.vouchers.set(request.voucherNumber, {
      total: request.total,
      cae,
      caeDue: "20261010",
      date: request.voucherDate,
      associated: request.associatedVoucher
        ? [{
            voucherType: request.associatedVoucher.voucherType,
            pointOfSale: request.associatedVoucher.pointOfSale,
            voucherNumber: request.associatedVoucher.voucherNumber,
          }]
        : [],
    })
    if (behavior === "lost_after_authorize") {
      // ARCA autorizó, pero la respuesta nunca llegó al worker.
      throw new FakeArcaError("The operation was aborted due to timeout", false)
    }
    return {
      cae,
      caeDueDate: "20261010",
      voucherNumber: request.voucherNumber,
      voucherDate: request.voucherDate,
      result: "A",
      observations: [],
    }
  }

  isDefinitiveRejection(error: unknown) {
    return error instanceof FakeArcaError && error.definitive
  }

  describeError(error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}
