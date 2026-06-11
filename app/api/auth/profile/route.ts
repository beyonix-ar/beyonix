import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"

function getBearerToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
}

export async function GET(request: Request) {
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

  let { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile && !profileError) {
    const metadata = user.user_metadata ?? {}
    const { error: upsertError } = await admin.from("profiles").upsert({
      id: user.id,
      email: user.email ?? metadata.email ?? null,
      username: metadata.username ?? null,
      nombre: metadata.nombre ?? "",
      telefono: metadata.telefono ?? null,
      calle: metadata.calle ?? null,
      numero: metadata.numero ?? null,
      piso: metadata.piso ?? null,
      departamento: metadata.departamento ?? null,
      localidad: metadata.localidad ?? null,
      codigo_postal: metadata.codigo_postal ?? null,
      provincia: metadata.provincia ?? null,
      referencias: metadata.referencias ?? null,
    })

    if (upsertError) {
      return NextResponse.json(
        { error: "No se pudo reconstruir el perfil." },
        { status: 500 },
      )
    }

    const retry = await admin
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single()

    profile = retry.data
    profileError = retry.error
  }

  if (profileError || !profile) {
    return NextResponse.json(
      { error: "No se pudo cargar el perfil." },
      { status: 500 },
    )
  }

  return NextResponse.json({ profile })
}
