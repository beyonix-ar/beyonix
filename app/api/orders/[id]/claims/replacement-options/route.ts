import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Debés iniciar sesión." }, { status: 401 })
  }

  const { id } = await params
  const orderId = Number(id)

  if (!Number.isFinite(orderId) || orderId <= 0) {
    return NextResponse.json({ error: "Pedido inválido." }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: order, error: orderError } = await admin
    .from("ordenes")
    .select("id, usuario_id")
    .eq("id", orderId)
    .maybeSingle()

  if (orderError || !order) {
    return NextResponse.json({ error: "No encontramos el pedido." }, { status: 404 })
  }

  if (order.usuario_id !== user.id) {
    return NextResponse.json({ error: "No autorizado." }, { status: 403 })
  }

  const [productsResult, categoriesResult] = await Promise.all([
    admin
      .from("productos")
      .select("*, categorias(id, nombre, slug), imagenes_producto(*), producto_variantes(*)")
      .eq("activo", true)
      .order("nombre", { ascending: true }),
    admin
      .from("categorias")
      .select("id, nombre, slug")
      .order("nombre", { ascending: true }),
  ])

  if (productsResult.error) {
    return NextResponse.json(
      { error: "No se pudieron cargar los productos." },
      { status: 500 },
    )
  }

  if (categoriesResult.error) {
    return NextResponse.json(
      { error: "No se pudieron cargar las categorías." },
      { status: 500 },
    )
  }

  const products = (productsResult.data ?? [])
    .map((product: any) => {
      const variants = (product.producto_variantes ?? []).filter(
        (variant: any) => variant.activo !== false && Number(variant.stock ?? 0) > 0,
      )

      return {
        ...product,
        producto_variantes: variants,
      }
    })
    .filter((product: any) => {
      const variantStock = (product.producto_variantes ?? []).reduce(
        (total: number, variant: any) => total + Number(variant.stock ?? 0),
        0,
      )

      return Number(product.stock ?? 0) > 0 || variantStock > 0
    })

  return NextResponse.json({
    products,
    categories: categoriesResult.data ?? [],
  })
}
