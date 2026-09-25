/**
 * SSRF guard.
 *
 * The web_fetch tool must not be exploitable to reach internal services. This
 * module checks every URL before the request leaves the machine. It is a
 * conservative allow-list: anything not explicitly permitted is blocked.
 */

import type { HostCheckResult } from './types.js'

/** RFC-1918 and loopback CIDR blocks that are always blocked. */
const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^\[::1\]$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // link-local / AWS metadata
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA
  /^fe80:/i, // IPv6 link-local
  /\.local$/i, // mDNS / Bonjour
  /\.internal$/i,
  /\.lan$/i,
  /metadata\.google\.internal$/i,
  /169\.254\.169\.254/, // AWS/GCP/Azure metadata endpoint
]

/** Schemes we are willing to follow. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

export function checkUrl(rawUrl: string): HostCheckResult {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: `Invalid URL: ${rawUrl}` }
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: `Scheme "${parsed.protocol}" is not allowed (only http/https).`,
    }
  }

  const host = parsed.hostname.toLowerCase()

  for (const pattern of PRIVATE_PATTERNS) {
    if (pattern.test(host)) {
      return {
        allowed: false,
        reason: `Blocked: "${host}" is a private/reserved address — fetch cannot reach internal services.`,
      }
    }
  }

  return { allowed: true }
}

/** Strip tracking query params and normalise common URL patterns. */
export function canonicalUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  // Drop the most common tracking params.
  const tracking = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'fbclid',
    'gclid',
    'ref',
    'source',
    '_ga',
  ]
  for (const param of tracking) url.searchParams.delete(param)
  return url.toString()
}
