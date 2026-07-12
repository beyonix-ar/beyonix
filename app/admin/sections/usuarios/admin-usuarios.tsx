"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Save, ShieldCheck, Users } from "lucide-react"

import {
  adminPageClassName,
  AdminCard,
  AdminEmptyState,
  AdminFiltersBar,
  AdminInfoBlock,
  AdminPageHeader,
  AdminPrimaryButton,
  AdminSearchInput,
  AdminSelect,
  AdminSkeleton,
} from "../../components/admin-controls"
import { useAuth } from "@/context/auth-context"
import { supabase } from "@/lib/supabase/client"
import {
  PROTECTED_SUPER_ADMIN_EMAIL,
  ROLE_LABELS,
  type UserRole,
} from "@/lib/auth/roles"

interface ManagedUser {
  id: string
  email: string | null
  username: string | null
  nombre: string
  rol: UserRole
  created_at: string
}

async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session },
  } = await supabase.auth.getSession()

  return session?.access_token
    ? { Authorization: `Bearer ${session.access_token}` }
    : {}
}

export function AdminUsuarios() {
  const { isSuperAdmin } = useAuth()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [draftRoles, setDraftRoles] = useState<Record<string, UserRole>>({})
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [message, setMessage] = useState<{
    type: "success" | "error"
    text: string
  } | null>(null)

  const loadUsers = useCallback(async () => {
    setLoading(true)
    const response = await fetch("/api/admin/usuarios", {
      headers: await authHeaders(),
      cache: "no-store",
    })
    const payload = await response.json()

    if (!response.ok) {
      setMessage({
        type: "error",
        text: payload.error ?? "No se pudieron cargar los usuarios.",
      })
      setLoading(false)
      return
    }

    const nextUsers = (payload.users ?? []) as ManagedUser[]
    setUsers(nextUsers)
    setDraftRoles(
      Object.fromEntries(nextUsers.map((user) => [user.id, user.rol]))
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("es")
    if (!term) return users

    return users.filter((user) =>
      [user.email, user.username, user.nombre]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("es")
        .includes(term)
    )
  }, [search, users])

  const saveRole = async (user: ManagedUser) => {
    const nextRole = draftRoles[user.id]
    if (!nextRole || nextRole === user.rol) return

    const raisesPrivileges =
      nextRole === "admin" || nextRole === "super_admin"
    const confirmed = window.confirm(
      raisesPrivileges
        ? `¿Confirmás asignar el rol ${ROLE_LABELS[nextRole]} a ${user.email ?? user.nombre}?`
        : `¿Confirmás bajar los permisos de ${user.email ?? user.nombre} a ${ROLE_LABELS[nextRole]}?`
    )

    if (!confirmed) {
      setDraftRoles((current) => ({ ...current, [user.id]: user.rol }))
      return
    }

    setSavingId(user.id)
    setMessage(null)
    const response = await fetch("/api/admin/usuarios", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...(await authHeaders()),
      },
      body: JSON.stringify({ userId: user.id, role: nextRole }),
    })
    const payload = await response.json()

    if (!response.ok) {
      setDraftRoles((current) => ({ ...current, [user.id]: user.rol }))
      setMessage({
        type: "error",
        text: payload.error ?? "No se pudo cambiar el rol.",
      })
    } else {
      setUsers((current) =>
        current.map((item) => (item.id === user.id ? payload.user : item))
      )
      setMessage({ type: "success", text: "Rol actualizado correctamente." })
    }

    setSavingId(null)
  }

  return (
    <div className={adminPageClassName}>
      <AdminPageHeader
        eyebrow="Seguridad"
        title="Usuarios y roles"
        description="Administrá accesos internos con validación de servidor y auditoría."
      />

      <AdminFiltersBar>
        <AdminSearchInput
          title="Buscar usuario"
          ariaLabel="Buscar usuario"
          value={search}
          placeholder="Email, usuario o nombre"
          onChange={setSearch}
        />
      </AdminFiltersBar>

      {message && (
        <AdminInfoBlock
          role="status"
          tone={message.type === "success" ? "success" : "danger"}
        >
          {message.text}
        </AdminInfoBlock>
      )}

      {loading ? (
        <AdminSkeleton rows={5} />
      ) : (
        <div className="space-y-3">
          {filteredUsers.map((managedUser) => {
            const protectedUser =
              managedUser.email?.toLowerCase() ===
              PROTECTED_SUPER_ADMIN_EMAIL
            const lockedSuperAdmin =
              !isSuperAdmin && managedUser.rol === "super_admin"
            const disabled = protectedUser || lockedSuperAdmin

            return (
              <AdminCard
                key={managedUser.id}
                className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_120px] md:items-center"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-black text-white">
                      {managedUser.username || managedUser.nombre}
                    </p>
                    {protectedUser && (
                      <ShieldCheck className="size-4 shrink-0 text-beyonix-sky" />
                    )}
                  </div>
                  <p className="mt-1 truncate text-xs text-white/50">
                    {managedUser.email}
                  </p>
                </div>

                <AdminSelect
                  title={`Rol de ${managedUser.email ?? managedUser.nombre}`}
                  value={draftRoles[managedUser.id] ?? managedUser.rol}
                  disabled={disabled}
                  onChange={(value) =>
                    setDraftRoles((current) => ({
                      ...current,
                      [managedUser.id]: value as UserRole,
                    }))
                  }
                >
                  <option value="cliente">Cliente</option>
                  <option value="operador">Operador</option>
                  <option value="admin">Admin</option>
                  {isSuperAdmin && (
                    <option value="super_admin">Super admin</option>
                  )}
                </AdminSelect>

                <AdminPrimaryButton
                  disabled={
                    disabled ||
                    savingId === managedUser.id ||
                    draftRoles[managedUser.id] === managedUser.rol
                  }
                  onClick={() => void saveRole(managedUser)}
                >
                  <Save className="size-4" />
                  Guardar
                </AdminPrimaryButton>
              </AdminCard>
            )
          })}

          {!filteredUsers.length && (
            <AdminEmptyState
              icon={<Users className="size-5" />}
              title="No se encontraron usuarios."
            />
          )}
        </div>
      )}
    </div>
  )
}
