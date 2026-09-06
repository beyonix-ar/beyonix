import { NextResponse } from "next/server"

// Retirado: sin llamadores ni solicitudes históricas en DB (auditoría 2026-09-06).
// Toda nueva solicitud debe pasar por las reglas, permisos y auditoría de reclamos.
export async function POST() {
  return NextResponse.json(
    { error: "La devolución se gestiona desde Ayuda con tu compra y el centro de reclamos." },
    { status: 410 },
  )
}
