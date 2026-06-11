import {
  type BlockIdentifierType,
  getClientBlockIdentifiers,
  normalizeBlockIdentifier,
} from "@/lib/clients/client-blocking"
import type { createAdminClient } from "@/lib/supabase/admin"

import { requireAdmin } from "../_auth"

type AdminClient = ReturnType<typeof createAdminClient>

function inferBlockIdentifierType(value: string): BlockIdentifierType {
  if (value.includes("@")) return "email"
  if (value.replace(/\D/g, "").length >= 7) return "phone"
  return "username"
}

async function findAuthUserByEmail(admin: AdminClient, email: string) {
  const targetEmail = email.trim().toLowerCase()
  let page = 1

  while (page <= 20) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    })

    if (error) return null

    const user = data.users.find(
      (candidate) => candidate.email?.trim().toLowerCase() === targetEmail
    )

    if (user) return user
    if (data.users.length < 1000) return null

    page += 1
  }

  return null
}

async function findProfileByLookup(admin: AdminClient, lookupValue: string) {
  const cleanLookup = lookupValue.trim().toLowerCase()
  const phoneLookup = normalizeBlockIdentifier("phone", lookupValue)

  if (cleanLookup.includes("@")) {
    const authUser = await findAuthUserByEmail(admin, cleanLookup)

    if (!authUser) return null

    const { data: profile } = await admin
      .from("profiles")
      .select("id, username, telefono")
      .eq("id", authUser.id)
      .maybeSingle()

    return profile
      ? {
          ...profile,
          email: authUser.email ?? null,
        }
      : null
  }

  const { data: profiles } = await admin
    .from("profiles")
    .select("id, username, telefono")
    .or(`username.eq.${cleanLookup},telefono.eq.${lookupValue.trim()}`)

  const profile =
    profiles?.find((candidate) => {
      const username = candidate.username?.trim().toLowerCase()
      const phone = normalizeBlockIdentifier("phone", candidate.telefono ?? "")

      return username === cleanLookup || Boolean(phoneLookup && phone === phoneLookup)
    }) ?? null

  if (!profile) return null

  const { data: authUser } = await admin.auth.admin.getUserById(profile.id)

  return {
    ...profile,
    email: authUser.user?.email ?? null,
  }
}

export async function GET(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) {
    return auth.error
  }

  const { data, error } = await auth.admin
    .from("blocked_client_identifiers")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ blockedIdentifiers: data ?? [] })
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) {
    return auth.error
  }

  const body = (await request.json()) as {
    lookup_value?: string
    reason?: string | null
  }
  const lookupValue = body.lookup_value?.trim() ?? ""

  if (!lookupValue) {
    return Response.json({ error: "Ingresá un dato para bloquear." }, { status: 400 })
  }

  const matchedProfile = await findProfileByLookup(auth.admin, lookupValue)
  const fallbackType = inferBlockIdentifierType(lookupValue)
  const identifiers = matchedProfile
    ? getClientBlockIdentifiers({
        email: matchedProfile.email,
        username: matchedProfile.username,
        phone: matchedProfile.telefono,
      })
    : [
        {
          identifier_type: fallbackType,
          identifier_value: normalizeBlockIdentifier(fallbackType, lookupValue),
        },
      ]

  if (!identifiers.length || identifiers.some((identifier) => !identifier.identifier_value)) {
    return Response.json({ error: "No se pudo interpretar el dato." }, { status: 400 })
  }

  if (matchedProfile) {
    await auth.admin
      .from("profiles")
      .update({
        blocked_at: new Date().toISOString(),
        blocked_reason: body.reason?.trim() || "Bloqueado desde Clientes",
        blocked_by: auth.user.id,
      })
      .eq("id", matchedProfile.id)
  }

  for (const identifier of identifiers) {
    const { error } = await auth.admin.from("blocked_client_identifiers").upsert(
      {
        ...identifier,
        reason: body.reason?.trim() || null,
        source_profile_id: matchedProfile?.id ?? null,
        created_by: auth.user.id,
      },
      { onConflict: "identifier_type,identifier_value" }
    )

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
  }

  return Response.json({ ok: true, matchedProfileId: matchedProfile?.id ?? null })
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request)

  if ("error" in auth) {
    return auth.error
  }

  const { searchParams } = new URL(request.url)
  const id = Number(searchParams.get("id"))
  const ids = searchParams
    .get("ids")
    ?.split(",")
    .map((value) => Number(value))
    .filter(Number.isFinite)
  const sourceProfileId = searchParams.get("source_profile_id")

  if (ids?.length) {
    const { error } = await auth.admin
      .from("blocked_client_identifiers")
      .delete()
      .in("id", ids)

    if (error) {
      return Response.json({ error: error.message }, { status: 500 })
    }
  }

  if (sourceProfileId) {
    if (!ids?.length) {
      const { error: deleteError } = await auth.admin
        .from("blocked_client_identifiers")
        .delete()
        .eq("source_profile_id", sourceProfileId)

      if (deleteError) {
        return Response.json({ error: deleteError.message }, { status: 500 })
      }
    }

    const { error: profileError } = await auth.admin
      .from("profiles")
      .update({
        blocked_at: null,
        blocked_reason: null,
        blocked_by: null,
      })
      .eq("id", sourceProfileId)

    if (profileError) {
      return Response.json({ error: profileError.message }, { status: 500 })
    }

    return Response.json({ ok: true })
  }

  if (!Number.isFinite(id)) {
    return Response.json({ error: "Bloqueo invalido." }, { status: 400 })
  }

  const { error } = await auth.admin
    .from("blocked_client_identifiers")
    .delete()
    .eq("id", id)

  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  return Response.json({ ok: true })
}
