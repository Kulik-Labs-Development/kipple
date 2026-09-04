import { useCallback, useState } from 'react'
import { cancelStagedUpload, stageUpload } from './uploads'

// Composer state for chunked (tus) file staging: pick → stage in the
// background with per-file progress → send references the ready ids. The
// File reference is the entry's identity (pick events mint fresh objects).

export type ComposerUpload = {
  file: File
  id?: string
  offset: number
  status: 'staging' | 'ready' | 'error'
  error?: string
}

export const MAX_COMPOSER_UPLOADS = 10

export function useStagedUploads() {
  const [staged, setStaged] = useState<ComposerUpload[]>([])

  const patchEntry = useCallback((file: File, patch: Partial<ComposerUpload>) => {
    setStaged((current) => current.map((s) => (s.file === file ? { ...s, ...patch } : s)))
  }, [])

  const addFiles = useCallback(
    (files: File[]) => {
      const room = Math.max(0, MAX_COMPOSER_UPLOADS - staged.length)
      const fitting = files
        .slice(0, room)
        .map((file) => ({ file, offset: 0, status: 'staging' as const }))
      if (fitting.length === 0) return
      setStaged((current) => [...current, ...fitting])
      for (const entry of fitting) {
        void stageUpload(entry.file, (offset) => patchEntry(entry.file, { offset }))
          .then((id) => patchEntry(entry.file, { id, status: 'ready', offset: entry.file.size }))
          .catch((err) =>
            patchEntry(entry.file, {
              status: 'error',
              error: err instanceof Error ? err.message : 'upload failed',
            }),
          )
      }
    },
    [staged.length, patchEntry],
  )

  const removeFile = useCallback((file: File) => {
    setStaged((current) => {
      const entry = current.find((s) => s.file === file)
      if (entry?.id) void cancelStagedUpload(entry.id)
      return current.filter((s) => s.file !== file)
    })
  }, [])

  const clear = useCallback(() => {
    setStaged((current) => {
      for (const entry of current) {
        if (entry.id && entry.status !== 'error') void cancelStagedUpload(entry.id)
      }
      return []
    })
  }, [])

  const readyIds = staged
    .filter((s) => s.status === 'ready' && s.id)
    .map((s) => s.id as string)
  const inFlight = staged.some((s) => s.status === 'staging')

  return { staged, addFiles, removeFile, clear, readyIds, inFlight }
}
