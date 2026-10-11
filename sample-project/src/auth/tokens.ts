import { fnv1a } from '../utils/ids.ts'

const SECRET = 'shop-api-sample-secret'

/** Signs a payload into an opaque token. */
export function signToken(payload: string): string {
  return `${payload}.${fnv1a(`${SECRET}:${payload}`)}`
}

/** Returns the payload when the signature checks out, else `null`. */
export function verifyToken(token: string): string | null {
  const index = token.lastIndexOf('.')
  if (index <= 0) return null
  const payload = token.slice(0, index)
  const signature = token.slice(index + 1)
  return fnv1a(`${SECRET}:${payload}`) === signature ? payload : null
}
