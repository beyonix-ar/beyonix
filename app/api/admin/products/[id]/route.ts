import { requireInternalUser } from "@/lib/auth/admin-api"

function parseProductId(value: string) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export async function PATCH(
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

  const body = (await request.json().catch(() => null)) as {
    activo?: unknown
  } | null

  if (typeof body?.activo !== "boolean") {
    return Response.json(
      { error: "El estado del producto no es válido." },
      { status: 400 },
    )
  }

  const { data: stateResult, error: updateError } = await auth.admin.rpc(
    "set_product_commercial_state_atomic",
    {
      p_product_id: productId,
      p_active: body.activo,
      p_actor_id: auth.user.id,
    },
  )

  if (updateError) {
    const missingMigration =
      /set_product_commercial_state_atomic|schema cache|PGRST202/i.test(
        updateError.message,
      )
    return Response.json(
      {
        error: missingMigration
          ? "Falta aplicar la migración 20260808120000_atomic_product_catalog_workflow.sql."
          : updateError.message || "No se pudo cambiar el estado del producto.",
      },
      { status: missingMigration ? 503 : 409 },
    )
  }

  const updatedProduct = Array.isArray(stateResult)
    ? stateResult[0]
    : stateResult
  if (!updatedProduct) {
    return Response.json(
      { error: "El producto ya no existe." },
      { status: 404 },
    )
  }

  const { data: variants, error: variantsError } = await auth.admin
    .from("producto_variantes")
    .select("*")
    .eq("producto_id", productId)
    .order("orden", { ascending: true })
    .order("id", { ascending: true })

  if (variantsError) {
    return Response.json(
      { error: "No se pudo verificar el estado persistido de las variantes." },
      { status: 500 },
    )
  }

  return Response.json({
    product: {
      ...updatedProduct,
      producto_variantes: variants ?? [],
    },
  })
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
    const { error: forceError } = await auth.admin.rpc(
      "force_delete_product_super_admin",
      {
        p_product_id: productId,
        p_actor_id: auth.user.id,
      },
    )

    if (forceError) {
      const missingMigration =
        /force_delete_product_super_admin|schema cache|PGRST202/i.test(
          forceError.message,
        )
      return Response.json(
        {
          error: missingMigration
            ? "Falta aplicar la migración 20260817100000_super_admin_force_delete.sql."
            : forceError.message ||
              "No se pudo eliminar definitivamente el producto.",
        },
        { status: missingMigration ? 503 : 409 },
      )
    }

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
      message: `Se eliminó definitivamente “${product.nombre}”. Las compras, ventas y devoluciones asociadas se conservan desvinculadas para mantener la trazabilidad.`,
    })
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
      message: `Se eliminó “${product.nombre}”.`,
    })
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
