/**
 * Environment scrubbing for commands the model chose to run.
 *
 * Flex's own process holds API keys (ANTHROPIC_API_KEY, GEMINI_API_KEY, ...).
 * A test script or an `npm install` hook the agent runs has no business seeing
 * them, and a prompt-injected command could print them straight into the
 * conversation. Anything secret-shaped is dropped; identity and toolchain
 * variables pass through so builds still work.
 */

/** Env var names that must never reach a command the model chose. */
export const SECRET_NAME_RE =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE|CERT|DSN|^PAT$|^GH_|^GITHUB_|^AWS_|^AZURE_|^GCP_|^GOOGLE_|^GEMINI_|^OPENAI_|^ANTHROPIC_|^CLAUDE_|^NPM_|^DOCKER_|^STRIPE_|^SLACK_|^SENDGRID_|^TWILIO_)/i

export function scrubEnv(
  source: Readonly<Record<string, string | undefined>>,
  passthrough: readonly string[] = [],
): Record<string, string> {
  const allow = new Set(passthrough)
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (allow.has(key) || !SECRET_NAME_RE.test(key)) out[key] = value
  }
  return out
}
