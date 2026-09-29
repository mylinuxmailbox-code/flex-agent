/**
 * SSRF guard.
 *
 * web_fetch must not be usable to reach internal services. Every URL — the one
 * the model supplied and every redirect hop after it — goes through here before
 * a request leaves the machine.
 *
 * Two layers:
 *   - `checkUrl` is synchronous and judges the literal URL: scheme, hostname
 *     patterns, and IP literals (parsed numerically, so `[::ffff:7f00:1]`,
 *     `2130706433` and `0x7f.1` are recognised as loopback; WHATWG URL parsing
 *     already normalises the odd IPv4 spellings).
 *   - `checkUrlResolved` additionally resolves the hostname and rejects it if
 *     *any* answer is a private address (defeats `127.0.0.1.nip.io`-style names).
 *
 * Residual risk, stated plainly: DNS can change between our lookup and fetch's
 * own lookup (rebinding). Closing that needs a pinned-address dispatcher; the
 * lookup here narrows the window but does not eliminate it.
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { HostCheckResult } from './types.js'

const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i, // mDNS / Bonjour
  /\.internal$/i,
  /\.lan$/i,
  /\.localdomain$/i,
  /\.home\.arpa$/i,
  /\.corp$/i,
]

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/** Parse dotted IPv4 into 4 octets, or null. */
function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return null
  return nums as [number, number, number, number]
}

function isBlockedIPv4(o: [number, number, number, number]): boolean {
  const [a, b, c] = o
  return (
    a === 0 || // "this network" incl. 0.0.0.0
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  )
}

/** Expand an IPv6 literal to eight 16-bit groups, or null when malformed. */
function parseIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  // Trailing dotted-quad (`::ffff:1.2.3.4`) becomes two hex groups.
  const lastColon = text.lastIndexOf(':')
  const tail = text.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length
    if (missing < 1) return null
    groups = [...head, ...Array<string>(missing).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(Number.parseInt(g, 16))
  }
  return out
}

function embeddedV4(hi: number, lo: number): [number, number, number, number] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255]
}

function isBlockedIPv6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (firstFiveZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true // :: and ::1
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d).
  if (firstFiveZero && (g5 === 0xffff || g5 === 0)) return isBlockedIPv4(embeddedV4(g6, g7))
  // NAT64 well-known prefix 64:ff9b::/96 carries a v4 address in the low bits.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIPv4(embeddedV4(g6, g7))
  }
  // 6to4 (2002::/16) embeds the v4 address in bits 16..47.
  if (g0 === 0x2002) return isBlockedIPv4(embeddedV4(g1, g2))
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true // multicast
  return false
}

/** True when `address` (an IP literal, no brackets) is private, reserved or loopback. */
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    const octets = parseIPv4(address)
    return octets ? isBlockedIPv4(octets) : true
  }
  if (kind === 6) {
    const groups = parseIPv6(address)
    return groups ? isBlockedIPv6(groups) : true
  }
  return true // not an address we can reason about: fail closed
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

const BLOCKED = (host: string): HostCheckResult => ({
  allowed: false,
  reason: `"${host}" is a private/reserved address — fetch cannot reach internal services.`,
})

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
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: 'URLs with embedded credentials are not allowed.' }
  }

  const host = stripBrackets(parsed.hostname.toLowerCase()).replace(/\.$/, '')
  if (!host) return { allowed: false, reason: `Invalid URL: ${rawUrl}` }

  if (isIP(host)) return isBlockedAddress(host) ? BLOCKED(host) : { allowed: true }

  if (BLOCKED_HOST_PATTERNS.some((p) => p.test(host)) || !host.includes('.')) return BLOCKED(host)
  return { allowed: true }
}

/** `checkUrl` plus DNS: every address the name resolves to must be public. */
export async function checkUrlResolved(rawUrl: string): Promise<HostCheckResult> {
  const literal = checkUrl(rawUrl)
  if (!literal.allowed) return literal

  const host = stripBrackets(new URL(rawUrl).hostname.toLowerCase()).replace(/\.$/, '')
  if (isIP(host)) return literal

  let answers: Array<{ address: string }>
  try {
    answers = await lookup(host, { all: true, verbatim: true })
  } catch (err) {
    return { allowed: false, reason: `Could not resolve "${host}": ${(err as Error).message}` }
  }
  const bad = answers.find((a) => isBlockedAddress(a.address))
  if (bad)
    return {
      allowed: false,
      reason: `"${host}" resolves to ${bad.address}, a private/reserved address.`,
    }
  return { allowed: true }
}

/** Strip tracking query params. Deliberately excludes generic names like `ref`/`source`. */
export function canonicalUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  const tracking = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'fbclid',
    'gclid',
    '_ga',
  ]
  for (const param of tracking) url.searchParams.delete(param)
  return url.toString()
}
