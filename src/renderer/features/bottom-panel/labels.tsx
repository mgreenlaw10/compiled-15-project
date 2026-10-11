/**
 * Labels and badges shared by the panel's tabs.
 */

import type { LogChannel } from '../../../shared/ipc'
import type { OperationOutcome } from '../../../shared/types/generation'
import { Badge } from '../../ui'

export const CHANNEL_LABELS: Record<LogChannel, string> = {
  analysis: 'analysis',
  ai: 'ai',
  generation: 'generate',
  validation: 'validate',
  collab: 'collab',
  app: 'app'
}

export function outcomeBadge(status: OperationOutcome['status']): JSX.Element {
  switch (status) {
    case 'applied':
      return <Badge kind="ok">applied</Badge>
    case 'metadata_only':
      return <Badge kind="info">graph only</Badge>
    case 'partial':
      return <Badge kind="pending">partial</Badge>
    case 'unsupported':
      return <Badge kind="pending">not supported</Badge>
    case 'failed':
      return <Badge kind="danger">failed</Badge>
    case 'skipped':
    default:
      return <Badge>skipped</Badge>
  }
}
