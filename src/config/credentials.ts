import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { flexDirs } from '../sandbox/index.js'

/** User-local credentials kept separate from project configuration. */
export const credentialEntrySchema = z.object({
  apiKey: z.string().min(1).optional(),
  authToken: z.string().min(1).optional(),
})

export const credentialsSchema = z.record(z.string(), credentialEntrySchema)
export type CredentialEntry = z.infer<typeof credentialEntrySchema>
export type StoredCredentials = z.infer<typeof credentialsSchema>

export function credentialsPath(): string {
  return join(flexDirs().configDir, 'credentials.json')
}

export function loadCredentials(): StoredCredentials {
  const path = credentialsPath()
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const result = credentialsSchema.safeParse(parsed)
    if (result.success) return result.data
    process.stderr.write(`flex: ignoring invalid credentials file at ${path}\n`)
    return {}
  } catch (err) {
    process.stderr.write(
      `flex: could not read credentials at ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return {}
  }
}

/** Merge user-local credentials without ever writing them into a project config. */
export function saveCredentials(patch: StoredCredentials): void {
  const path = credentialsPath()
  const current = loadCredentials()
  const merged: StoredCredentials = { ...current }
  for (const [provider, entry] of Object.entries(patch)) {
    const existing = merged[provider]
    merged[provider] = { ...existing, ...entry }
  }
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function hasCredential(entry: CredentialEntry | undefined): boolean {
  return Boolean(entry?.apiKey || entry?.authToken)
}

/** Safe diagnostics: only the presence of a secret is reported. */
export function redactCredential(entry: CredentialEntry | undefined): string {
  return hasCredential(entry) ? 'configured' : 'missing'
}
