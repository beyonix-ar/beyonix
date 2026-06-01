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

function getStoragePathFromUrl(url: string) {
  return url.split(`/${PRODUCTO_IMAGES_BUCKET}/`)[1] ?? null
}

export async function deleteProductoImageByUrl(url: string) {
  const { error: dbError } = await supabase
    .from("imagenes_producto")
    .delete()
    .eq("url", url)

  if (dbError) {
    throw dbError
  }

  const path = getStoragePathFromUrl(url)

  if (path) {
    const { error: storageError } = await supabase.storage
      .from(PRODUCTO_IMAGES_BUCKET)
      .remove([path])

    if (storageError) {
      throw storageError
    }
  }

  return true
}

export async function updateProductoImageOrder(
  urls: string[]
) {
  const results = await Promise.all(
    urls.map((url, index) =>
      supabase
        .from("imagenes_producto")
        .update({
          orden: index + 1,
        })
        .eq("url", url)
    )
  )

  const error = results.find((result) => result.error)?.error

  if (error) {
    throw error
  }
}
