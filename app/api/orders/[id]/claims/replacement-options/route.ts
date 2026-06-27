import { NextResponse } from "next/server"

export async function GET() {
  return NextResponse.json(
    { error: "El cambio de producto desde Ayuda con tu compra ya no está disponible." },
    { status: 410 },
  )
}
