import { requireInternalUser } from "@/lib/auth/admin-api"

function productIds(value: string | null) {
  if (!value) return null

  const ids = [...new Set(
    value
      .split(",")
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item > 0),
  )]

  return ids.length > 0 && ids.length <= 100 ? ids : null
}

function searchText(value: string | null) {
  const normalized = value?.trim().replace(/[%(),]/g, " ") ?? ""
  return normalized.slice(0, 160)
}

export async function GET(request: Request) {
  const auth = await requireInternalUser(request)
  if ("error" in auth) return auth.error

  const url = new URL(request.url)
  const idsParam = url.searchParams.get("productIds")
  const ids = productIds(idsParam)
  if (idsParam && !ids) {
    return Response.json(
      { error: "La lista de productos no es válida." },
      { status: 400 },
    )
  }

  const skuSearch = searchText(url.searchParams.get("skuSearch"))
  const colorSearch = searchText(url.searchParams.get("colorSearch"))
  const variants: unknown[] = []
  const pageSize = 1000

  for (let offset = 0; ; offset += pageSize) {
    let query = auth.admin
      .from("producto_variantes")
      .select("*")
      .order("orden", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1)

    if (ids) query = query.in("producto_id", ids)
    if (skuSearch) {
      query = query.or(
        `sku.ilike.%${skuSearch}%,codigo_barra.ilike.%${skuSearch}%`,
      )
    }
    if (colorSearch) {
      query = query.or(
        `nombre.ilike.%${colorSearch}%,color_hex.ilike.%${colorSearch}%`,
      )
    }

    const { data, error } = await query
    if (error) {
      return Response.json(
        { error: "No se pudo cargar el catálogo administrativo de variantes." },
        { status: 500 },
      )
    }

    variants.push(...(data ?? []))
    if ((data?.length ?? 0) < pageSize) break
  }

  return Response.json({ variants })
}
