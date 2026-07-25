import { HomeClient } from "@/components/home-client"
import { getFeaturedProduct } from "@/lib/supabase/queries/store-server"

export const revalidate = 60

export default async function HomePage() {
  let featuredProduct = null

  try {
    featuredProduct = await getFeaturedProduct()
  } catch (error) {
    console.error("Error cargando el producto destacado del Home:", error)
  }

  return (
    <main className="min-h-screen beyonix-home-bg">
      <HomeClient featuredProduct={featuredProduct} />
    </main>
  )
}
