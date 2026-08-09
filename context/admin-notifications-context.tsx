"use client"

import { createContext, useContext, type ReactNode } from "react"

import type { AdminNotificationGroups } from "@/lib/admin/admin-notifications"

const EMPTY_ADMIN_NOTIFICATION_GROUPS: AdminNotificationGroups = {
  order: 0,
  message: 0,
  payment: 0,
  invoice: 0,
  shipping: 0,
  cancellation: 0,
  claim: 0,
  mercadolibre_return: 0,
  inventory: 0,
}

const AdminNotificationGroupsContext =
  createContext<AdminNotificationGroups>(EMPTY_ADMIN_NOTIFICATION_GROUPS)

export function AdminNotificationGroupsProvider({
  children,
  groups,
}: {
  children: ReactNode
  groups: AdminNotificationGroups
}) {
  return (
    <AdminNotificationGroupsContext.Provider value={groups}>
      {children}
    </AdminNotificationGroupsContext.Provider>
  )
}

export function useAdminNotificationGroups() {
  return useContext(AdminNotificationGroupsContext)
}
