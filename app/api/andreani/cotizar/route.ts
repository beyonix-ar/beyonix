import { NextResponse } from "next/server"

import {
  AndreaniClient,
  getAndreaniDisabledResponse,
  isAndreaniReady,
  parseAndreaniCotizarPayload,
} from "@/lib/andreani/client"

export async function POST(request: Request) {
  if (!isAndreaniReady()) {
    return NextResponse.json(getAndreaniDisabledResponse())
  }

  try {
    const payload = parseAndreaniCotizarPayload(await request.json())
    const client = new AndreaniClient()
    const quote = await client.cotizar(payload)

    return NextResponse.json(quote)
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "No se pudo preparar la cotización Andreani",
        expectedResponse: {
          options: [
            {
              type: "sucursal",
              label: "Retiro en sucursal Andreani",
              price: 0,
            },
            {
              type: "domicilio",
              label: "Envío a domicilio",
              price: 0,
            },
          ],
        },
      },
      { status: 400 }
    )
  }
}
