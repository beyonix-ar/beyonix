import type { Metadata } from "next"
import { Suspense } from "react"

import { FavoritosClient } from "./favoritos-client"

export const metadata: Metadata = {
  title: "Favoritos | BEYONIX",
  description: "Consultá tus productos favoritos en BEYONIX.",
}

export default function FavoritosPage() {
  return (
    <Suspense fallback={null}>
      <FavoritosClient />
    </Suspense>
  )
}
