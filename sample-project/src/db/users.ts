import { database } from './client.ts'
import { generateId } from '../utils/ids.ts'
import type { User } from '../types/index.ts'

export function createUser(
  email: string,
  displayName: string,
  passwordHash: string
): User {
  const user: User = {
    id: generateId('usr'),
    email: email.toLowerCase(),
    displayName,
    passwordHash,
    createdAt: new Date().toISOString()
  }
  database.insert('users', user.id, user)
  return user
}

export function findUserById(id: string): User | undefined {
  return database.get('users', id)
}

export function findUserByEmail(email: string): User | undefined {
  const needle = email.toLowerCase()
  return database.all('users').find((user) => user.email === needle)
}

export function listUsers(): User[] {
  return database.all('users')
}
