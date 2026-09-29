import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Flex keeps per-user state. `FLEX_HOME` relocates all of it, which is
 * what lets tests and sandboxed runs stay out of the real home directory.
 * Evaluated on every call, never cached at import time, so a test that sets
 * the variable after import still takes effect.
 */
export function flexHome(): string {
  return process.env.FLEX_HOME ?? join(homedir(), '.flex')
}
