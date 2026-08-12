/**
 * Direct browser → R2 PUT against a presigned URL, with upload progress.
 * Shared by the console's ready-image button and the Upload section (D103).
 * Progress caps at 99 until the server confirms — a full bar that then fails
 * reads as a lie.
 */
export function putUploadedObject(
  url: string,
  file: File,
  contentType: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    request.timeout = 10 * 60 * 1000
    request.setRequestHeader('Content-Type', contentType)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      }
    }
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100)
        resolve()
      } else {
        reject(new Error(`Private image storage returned HTTP ${request.status}.`))
      }
    }
    request.onerror = () => reject(new Error('The browser could not reach private image storage.'))
    request.ontimeout = () => reject(new Error('The image upload took longer than ten minutes.'))
    request.send(file)
  })
}
