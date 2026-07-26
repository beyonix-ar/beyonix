import type { Metadata } from "next"

import { AdminUsuarios } from "@/app/admin/sections/usuarios/admin-usuarios"

export const metadata: Metadata = { title: "Usuarios y roles" }

export default function AdminUsersAndRolesPage() {
  return <AdminUsuarios />
}
