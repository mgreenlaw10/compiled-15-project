/**
 * A unified diff, coloured per line.
 */

/** Renders a unified diff with per-line colouring. */
export function DiffBlock({ patch }: { patch: string }): JSX.Element {
  const lines = patch.split('\n')
  return (
    <pre className="diff">
      {lines.map((line, index) => {
        let className = ''
        if (line.startsWith('+++') || line.startsWith('---')) className = 'meta'
        else if (line.startsWith('@@')) className = 'hunk'
        else if (line.startsWith('+')) className = 'add'
        else if (line.startsWith('-')) className = 'del'
        else if (line.startsWith('=')) className = 'meta'
        return (
          <span key={index} className={className}>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}
