import { fnv1a } from '../utils/ids.ts'

const SALT = 'shop-api-sample-salt'

/** Hashes a plaintext password. Not suitable for production use. */
export function hashPassword(plaintext: string): string {
  return fnv1a(`${SALT}:${plaintext}`)
}

export function verifyPassword(plaintext: string, hash: string): boolean {
  return hashPassword(plaintext) === hash
}
