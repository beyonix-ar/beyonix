import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"

function getBearerToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
}

export async function DELETE(request: Request) {
  const token = getBearerToken(request)

  if (!token) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 })
  }

  const admin = createAdminClient()
  const { data: userData, error: userError } = await admin.auth.getUser(token)
  const user = userData.user

  if (userError || !user) {
    return NextResponse.json({ error: "Sesión inválida." }, { status: 401 })
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, rol")
    .eq("id", user.id)
    .maybeSingle()

  if (profileError) {
    return NextResponse.json(
      { error: "No se pudo validar la cuenta." },
      { status: 500 },
    )
  }

  if (profile?.rol && profile.rol !== "cliente") {
    return NextResponse.json(
      { error: "Las cuentas internas deben gestionarse desde administración." },
      { status: 403 },
    )
  }

  const { error: ordersError } = await admin
    .from("ordenes")
    .update({ usuario_id: null } as never)
    .eq("usuario_id", user.id)

  if (ordersError) {
    return NextResponse.json(
      { error: "No se pudo preservar el historial de compras." },
      { status: 500 },
    )
  }

  const { error: profileDeleteError } = await admin
    .from("profiles")
    .delete()
    .eq("id", user.id)

  if (profileDeleteError) {
    return NextResponse.json(
      { error: "No se pudo eliminar el perfil." },
      { status: 500 },
    )
  }

  const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id)

  if (deleteUserError) {
    return NextResponse.json(
      { error: "No se pudo eliminar la cuenta de acceso." },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true })
}
