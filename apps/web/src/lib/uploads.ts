// Minimal same-origin tus client for the /api/uploads staging endpoints
// (plan row 18 part 1). Creation + offset-append + resume; 5MB chunks so a
// slow link or a proxy timeout never loses the whole file.

export const TUS_CHUNK_SIZE = 5 * 1024 * 1024

export type StagedUploadInfo = {
  id: string
  filename: string
  mime: string
  size: number
  offset: number
  status: 'open' | 'complete' | 'consumed'
  expiresAt: string
}

function b64utf8(value: string): string {
  return btoa(unescape(encodeURIComponent(value)))
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (res.ok) return res.json().catch(() => ({}))
  let message = `upload request failed (${res.status})`
  try {
    const body = (await res.json()) as { message?: string }
    if (body.message) message = body.message
  } catch {
    // keep the status-based message
  }
  throw new Error(message)
}

// Create the staging row, then append the file in chunks. `onProgress`
// receives the server-acknowledged offset after each chunk. On a failed
// chunk the client re-reads the server offset (GET) and resumes — up to
// three chunk failures total before the promise rejects.
export async function stageUpload(
  file: File,
  onProgress: (offset: number) => void,
): Promise<string> {
  const meta = `filename ${b64utf8(file.name)},mime ${b64utf8(file.type || 'application/octet-stream')}`
  const created = await fetch('/api/uploads', {
    method: 'POST',
    headers: {
      'Upload-Length': String(file.size),
      'Upload-Metadata': meta,
    },
  })
  await jsonOrThrow(created)
  const id = created.headers.get('Location')?.replace('/api/uploads/', '')
  if (!id) throw new Error('upload created without a location')

  let offset = 0
  let failedChunks = 0
  while (offset < file.size) {
    const end = Math.min(offset + TUS_CHUNK_SIZE, file.size)
    try {
      const res = await fetch(`/api/uploads/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': String(offset),
        },
        body: file.slice(offset, end),
      })
      if (res.status === 204) {
        failedChunks = 0
        offset = Number(res.headers.get('Upload-Offset') ?? end)
        onProgress(offset)
      } else if (res.status === 409) {
        // offset mismatch (e.g. a previous chunk actually landed) — re-sync
        const info = (await (await fetch(`/api/uploads/${id}`)).json()) as StagedUploadInfo
        offset = info.offset
        onProgress(offset)
      } else {
        await jsonOrThrow(res)
      }
    } catch (error) {
      failedChunks += 1
      if (failedChunks > 3) throw error
      const info = (await (await fetch(`/api/uploads/${id}`)).json()) as StagedUploadInfo
      offset = info.offset
      onProgress(offset)
      await new Promise((resolve) => setTimeout(resolve, 500 * failedChunks))
    }
  }
  return id
}

export async function stagedUploadInfo(id: string): Promise<StagedUploadInfo> {
  const res = await fetch(`/api/uploads/${id}`)
  if (!res.ok) throw new Error('staged upload not found')
  return (await res.json()) as StagedUploadInfo
}

export async function cancelStagedUpload(id: string): Promise<void> {
  await fetch(`/api/uploads/${id}`, { method: 'DELETE' })
}
