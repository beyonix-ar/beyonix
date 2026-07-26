import type { Metadata } from "next"

import { AdminClient } from "./admin-client"

export const metadata: Metadata = {
  title: {
    default: "Panel administrativo | BEYONIX",
    template: "%s | BEYONIX",
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
  },
}

export default function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <AdminClient>{children}</AdminClient>
}
