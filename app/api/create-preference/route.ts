import { MercadoPagoConfig, Preference } from "mercadopago"
import { NextResponse } from "next/server"
import {
  FREE_SHIPPING_MIN,
  SHIPPING_COST,
  TRANSFER_DISCOUNT,
  getProductDiscount,
} from "@/lib/store-config"

const client = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN!,
})


export async function POST(req: Request) {
  try {
    const { items, paymentMethod } = await req.json()

    const subtotal = items.reduce(
      (sum: number, item: any) =>
        sum +
        Math.round(item.price * (1 - getProductDiscount(item.id))) *
          item.quantity,
      0
    )

    const discount =
      paymentMethod === "transfer"
        ? Math.round(subtotal * TRANSFER_DISCOUNT)
        : 0

    const discountedSubtotal = subtotal - discount

    const shipping =
      discountedSubtotal >= FREE_SHIPPING_MIN
        ? 0
        : SHIPPING_COST

    const preference = new Preference(client)

    const result = await preference.create({
      body: {
        items: [
          ...items.map((item: any) => ({
            id: String(item.id),
            title: item.name,
            quantity: item.quantity,
            unit_price: Math.round(
              item.price * (1 - getProductDiscount(item.id))
            ),
            currency_id: "ARS",
          })),
          ...(shipping > 0
            ? [
                {
                  id: "shipping",
                  title: "Costo de envío",
                  quantity: 1,
                  unit_price: shipping,
                  currency_id: "ARS",
                },
              ]
            : []),
        ],
        back_urls: {
          success: "http://localhost:3000",
          failure: "http://localhost:3000/checkout",
          pending: "http://localhost:3000/checkout",
        },
      },
    })

    return NextResponse.json({
      init_point: result.init_point,
    })
  } catch (error) {
    console.error(error)
    return NextResponse.json(
      { error: "Error creating Mercado Pago preference" },
      { status: 500 }
    )
  }
}