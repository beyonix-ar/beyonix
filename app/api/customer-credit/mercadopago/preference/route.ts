import { NextResponse } from "next/server"

// Decisión de negocio: los clientes ya no pueden cargar saldo por ningún
// medio, incluyendo Mercado Pago. Antes esta ruta creaba una preferencia de
// pago y una fila "pendiente_pago" en customer_credit_topups; ahora se
// deshabilita antes de tocar Mercado Pago o la base. El saldo a favor sólo
// puede acreditarse por gestión interna de BEYONIX (reintegro, devolución,
// compensación, ajuste administrativo -- ver
// app/api/admin/clientes/saldos/route.ts y
// app/api/admin/customer-credit/route.ts). La conciliación/abandono de
// intentos ya iniciados antes de este cambio (app/api/customer-credit/mercadopago/reconcile
// y /abandon) se deja activa: sólo puede finalizar un pago real ya verificado
// contra la API de Mercado Pago sobre una fila existente, nunca crear saldo
// nuevo.
export async function POST() {
  return NextResponse.json(
    {
      error:
        "La carga de saldo por Mercado Pago está deshabilitada. El saldo a favor se acredita únicamente por gestión interna de BEYONIX.",
    },
    { status: 410 },
  )
}
