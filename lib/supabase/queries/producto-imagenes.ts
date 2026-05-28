import { supabase } from "@/lib/supabase/client"

export const PRODUCTO_IMAGES_BUCKET =
  "imagenes-productos"

const getFilePath = (
  productoId: number,
  file: File
) => {
  const ext =
    file.name.split(".").pop() || "jpg"

  return `productos/${productoId}/${crypto.randomUUID()}.${ext}`
}

export async function uploadProductoImages(
  productoId: number,
  files: File[],
  startOrden = 0
) {
  const validFiles = files.filter((file) =>
    file.type.startsWith("image/")
  )

  const urls: string[] = []

  for (const [index, file] of validFiles.entries()) {
    const path = getFilePath(
      productoId,
      file
    )

    const {
      data,
      error: uploadError,
    } = await supabase.storage
      .from(PRODUCTO_IMAGES_BUCKET)
      .upload(path, file)

    if (uploadError) {
      throw uploadError
    }

    const {
      data: { publicUrl },
    } = supabase.storage
      .from(PRODUCTO_IMAGES_BUCKET)
      .getPublicUrl(data.path)

    const { error: dbError } =
      await supabase
        .from("imagenes_producto")
        .insert({
          producto_id: productoId,
          url: publicUrl,
          orden: startOrden + index + 1,
        })

    if (dbError) {
      throw dbError
    }

    urls.push(publicUrl)
  }

  return urls
}
