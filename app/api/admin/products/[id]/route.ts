import { requireInternalUser } from "@/lib/auth/admin-api"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireInternalUser(request, ["admin", "super_admin"])
  if ("error" in auth) return auth.error

  const { id: rawId } = await context.params
  const productId = parseProductId(rawId)
  if (!productId) {
    return Response.json(
      { error: "El producto indicado no es válido." },
      { status: 400 },
    )
  }

  const { data: product, error: productError } = await auth.admin
    .from("productos")
    .select("id, nombre")
    .eq("id", productId)
    .maybeSingle()

  if (productError) {
    return Response.json(
      { error: "No se pudo consultar el producto." },
      { status: 500 },
    )
  }
  if (!product) {
    return Response.json(
      { error: "El producto ya no existe." },
      { status: 404 },
    )
  }

  const force = new URL(request.url).searchParams.get("force") === "true"
  if (force && auth.profile.rol !== "super_admin") {
    return Response.json(
      { error: "Solamente un SUPER ADMIN puede eliminar el historial asociado." },
      { status: 403 },
    )
  }

  const { data: images } = await auth.admin
    .from("imagenes_producto")
    .select("url")
    .eq("producto_id", productId)

  if (force) {
    const unlinkOperations = [
      auth.admin
        .from("orden_items")
        .update({ producto_id: null, variante_id: null })
        .eq("producto_id", productId),
      auth.admin
        .from("resenas")
        .update({ producto_id: null })
        .eq("producto_id", productId),
      auth.admin
        .from("reviews")
        .update({ product_id: null })
        .eq("product_id", productId),
    ]
    for (const operation of unlinkOperations) {
      const { error } = await operation
      if (error) {
        return Response.json(
          {
            error:
              "No se pudieron desvincular todos los pedidos y comprobantes históricos.",
          },
          { status: 500 },
        )
      }
    }

    const purgeOperations = [
      auth.admin
        .from("inventory_return_movements")
        .delete()
        .eq("product_id", productId),
      auth.admin
        .from("inventory_opening_balances")
        .delete()
        .eq("product_id", productId),
      auth.admin
        .from("business_expenses")
        .delete()
        .eq("product_id", productId),
      auth.admin
        .from("external_sales")
        .delete()
        .eq("product_id", productId),
      auth.admin
        .from("mercadolibre_sales")
        .delete()
        .eq("product_id", productId),
      auth.admin
        .from("product_cost_entries")
        .delete()
        .eq("product_id", productId),
      auth.admin
        .from("product_favorites")
        .delete()
        .eq("product_id", productId),
      auth.admin
        .from("producto_especificaciones")
        .delete()
        .eq("producto_id", productId),
      auth.admin
        .from("imagenes_producto")
        .delete()
        .eq("producto_id", productId),
      auth.admin
        .from("producto_variantes")
        .delete()
        .eq("producto_id", productId),
    ]
    for (const operation of purgeOperations) {
      const { error } = await operation
      if (error) {
        return Response.json(
          {
            error:
              error.message ||
              "No se pudo purgar el historial de inventario.",
          },
          { status: 500 },
        )
      }
    }
  }

  const { error: deleteError } = await auth.admin
    .from("productos")
    .delete()
    .eq("id", productId)

  if (!deleteError) {
    const paths = (images ?? [])
      .map((image) =>
        typeof image.url === "string"
          ? image.url.split("/imagenes-productos/")[1]
          : null,
      )
      .filter((path): path is string => Boolean(path))

    if (paths.length > 0) {
      await auth.admin.storage.from("imagenes-productos").remove(paths)
    }

    return Response.json({
      mode: "deleted",
      message: force
        ? `Se eliminó definitivamente “${product.nombre}” y su historial de inventario.`
        : `Se eliminó “${product.nombre}”.`,
    })
  }

  if (force) {
    return Response.json(
      {
        error:
          deleteError.message ||
          "Persisten referencias que impiden la eliminación definitiva.",
      },
      { status: 409 },
    )
  }

  if (deleteError.code !== "23503") {
    return Response.json(
      {
        error:
          deleteError.message ||
          "No se pudo eliminar el producto.",
      },
      { status: 500 },
    )
  }

  const { error: archiveError } = await auth.admin
    .from("productos")
    .update({
      activo: false,
      destacado: false,
    })
    .eq("id", productId)

  if (archiveError) {
    return Response.json(
      {
        error:
          "El producto tiene movimientos históricos y tampoco pudo archivarse.",
      },
      { status: 500 },
    )
  }

  return Response.json({
    mode: "archived",
    message:
      `“${product.nombre}” tiene compras, ventas o devoluciones asociadas. ` +
      "Se archivó para conservar la trazabilidad del inventario.",
  })
}
