import { UploadScreen } from '@/components/upload/UploadScreen'
import { requireOperator } from '@/lib/auth/authorize'

export const dynamic = 'force-dynamic'

export default async function UploadPage() {
  await requireOperator()
  return <UploadScreen />
}
