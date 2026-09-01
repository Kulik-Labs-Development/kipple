function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

// Human-readable byte sizes for attachment chips ("512 B", "1.5 KB", "3 MB").
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${fmt(Math.round((bytes / 1024) * 10) / 10)} KB`
  if (bytes < 1024 ** 3) return `${fmt(Math.round((bytes / (1024 ** 2)) * 10) / 10)} MB`
  return `${fmt(Math.round((bytes / (1024 ** 3)) * 10) / 10)} GB`
}
