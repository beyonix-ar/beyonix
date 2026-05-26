import { supabase } from '@/lib/supabase/client'

export async function uploadProductImage(
  file: File,
  productoId: number
) {
  const fileExt =
    file.name.split('.').pop()

  const fileName =
    `${crypto.randomUUID()}.${fileExt}`

  const filePath =
    `productos/${fileName}`

  const { error: uploadError } =
    await supabase.storage
      .from('imagenes-productos')
      .upload(filePath, file)

  if (uploadError) {
    throw uploadError
  }

  const {
    data: { publicUrl },
  } = supabase.storage
    .from('imagenes-productos')
    .getPublicUrl(filePath)

  const { error: dbError } =
    await supabase
      .from('imagenes_producto')
      .insert({
        producto_id: productoId,
        url: publicUrl,
        orden: 1,
      })

  if (dbError) {
    throw dbError
  }

  return publicUrl
}