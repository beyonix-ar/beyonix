import { NextResponse } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"

function getBearerToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim()
}

function onlyDigits(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.replace(/\D/g, "").slice(0, maxLength)
    : undefined
}

function optionalText(value: unknown) {
  return typeof value === "string" ? value.trim() : undefined
}

function isMissingDniColumnError(error: { message?: string; details?: string; code?: string }) {
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.code ?? ""}`.toLowerCase()

  return text.includes("dni") && (text.includes("schema cache") || text.includes("column"))
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
    const baseProfilePayload = {
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
    }
    let upsertResult = await admin.from("profiles").upsert({
      ...baseProfilePayload,
      dni: metadata.dni ?? null,
    })

    if (upsertResult.error && isMissingDniColumnError(upsertResult.error)) {
      upsertResult = await admin.from("profiles").upsert(baseProfilePayload)
    }

    if (upsertResult.error) {
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

  return NextResponse.json({
    profile: {
      ...profile,
      dni: profile.dni ?? user.user_metadata?.dni ?? null,
    },
  })
}

export async function PATCH(request: Request) {
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

  const body = await request.json().catch(() => ({}))
  const { data: currentProfile, error: currentProfileError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle()

  if (currentProfileError) {
    return NextResponse.json(
      { error: "No se pudo cargar el perfil actual." },
      { status: 500 },
    )
  }

  const payload: Record<string, unknown> = {}
  const dniFromRequest = onlyDigits(body.dni, 8)
  const currentDni = onlyDigits(currentProfile?.dni ?? user.user_metadata?.dni, 8) ?? ""

  if (optionalText(body.name) !== undefined) payload.nombre = optionalText(body.name)
  if (optionalText(body.username) !== undefined) payload.username = optionalText(body.username)
  if (optionalText(body.phone) !== undefined) payload.telefono = optionalText(body.phone)
  if (optionalText(body.street) !== undefined) payload.calle = optionalText(body.street)
  if (optionalText(body.streetNumber) !== undefined) payload.numero = optionalText(body.streetNumber)
  if (optionalText(body.floor) !== undefined) payload.piso = optionalText(body.floor) || null
  if (optionalText(body.apartment) !== undefined) payload.departamento = optionalText(body.apartment)?.toLocaleUpperCase("es-AR") || null
  if (optionalText(body.postalCode) !== undefined) payload.codigo_postal = optionalText(body.postalCode)
  if (optionalText(body.province) !== undefined) payload.provincia = optionalText(body.province)
  if (optionalText(body.city) !== undefined) payload.localidad = optionalText(body.city)
  if (optionalText(body.avatarUrl) !== undefined) payload.avatar_url = optionalText(body.avatarUrl)
  if (optionalText(body.references) !== undefined) payload.referencias = optionalText(body.references)

  if (dniFromRequest !== undefined) {
    if (currentDni && dniFromRequest !== currentDni) {
      return NextResponse.json(
        { error: "El DNI ya fue cargado y no puede modificarse." },
        { status: 409 },
      )
    }

    if (!currentDni) {
      payload.dni = dniFromRequest || null
      const nextMetadata = {
        ...user.user_metadata,
        dni: dniFromRequest || null,
      }

      const { error: metadataError } = await admin.auth.admin.updateUserById(
        user.id,
        { user_metadata: nextMetadata },
      )

      if (metadataError) {
        return NextResponse.json(
          { error: "No se pudo guardar el DNI de la cuenta." },
          { status: 500 },
        )
      }
    }
  }

  let updatePayload = payload
  let updateResult = await admin
    .from("profiles")
    .update(updatePayload)
    .eq("id", user.id)
    .select("*")
    .single()

  if (updateResult.error && isMissingDniColumnError(updateResult.error)) {
    const { dni: _dni, ...payloadWithoutDni } = payload
    updatePayload = payloadWithoutDni
    updateResult = await admin
      .from("profiles")
      .update(updatePayload)
      .eq("id", user.id)
      .select("*")
      .single()
  }

  if (updateResult.error || !updateResult.data) {
    return NextResponse.json(
      { error: updateResult.error?.message || "No se pudo guardar el perfil." },
      { status: 500 },
    )
  }

  return NextResponse.json({
    profile: {
      ...updateResult.data,
      dni:
        updateResult.data.dni ??
        dniFromRequest ??
        user.user_metadata?.dni ??
        null,
    },
  })
}
