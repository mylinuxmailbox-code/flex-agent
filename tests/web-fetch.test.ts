import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FetchBlockedError, guardedFetch, webFetchTool } from '../src/tools/web/fetch.js'
import {
  BraveSearchProvider,
  createSearchProvider,
  DuckDuckGoProvider,
  domainMatches,
  ExaProvider,
  TavilyProvider,
} from '../src/tools/web/providers.js'
import { webSearchTool } from '../src/tools/web/search.js'
import { checkUrl, checkUrlResolved, isBlockedAddress } from '../src/tools/web/ssrf-guard.js'
import { makeWorkspace, type TestWorkspace } from './helpers/tool-context.js'

describe('SSRF guard: address forms', () => {
  it.each([
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f.1/',
    'http://0.0.0.0/',
    'http://0.1.2.3/',
    'http://100.64.0.1/', // CGNAT
    'http://100.127.255.255/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[::]/',
    'http://[64:ff9b::7f00:1]/', // NAT64 → 127.0.0.1
    'http://[2002:7f00:1::]/', // 6to4 → 127.0.0.1
    'http://localhost./',
    'http://foo.localhost/',
    'http://printer.local/',
    'http://intranet/', // single-label host
    'http://user:pass@example.com/',
  ])('blocks %s', (url) => {
    expect(checkUrl(url).allowed).toBe(false)
  })

  it.each([
    'https://example.com/',
    'http://8.8.8.8/',
    'http://100.63.255.255/',
    'http://172.32.0.1/',
    'http://[2606:4700:4700::1111]/',
    'http://[::ffff:8.8.8.8]/',
  ])('allows %s', (url) => {
    expect(checkUrl(url).allowed).toBe(true)
  })

  it('isBlockedAddress fails closed on garbage', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true)
  })

  it('checkUrlResolved rejects names that resolve to loopback', async () => {
    const result = await checkUrlResolved('http://localtest.me/')
    // Either resolves to 127.0.0.1 (blocked) or fails to resolve offline (also blocked).
    expect(result.allowed).toBe(false)
  })
})

describe('domainMatches', () => {
  it('matches the domain and subdomains but not lookalikes', () => {
    expect(domainMatches('docs.example.com', 'example.com')).toBe(true)
    expect(domainMatches('example.com', 'example.com')).toBe(true)
    expect(domainMatches('www.example.com', 'example.com')).toBe(true)
    expect(domainMatches('notexample.com', 'example.com')).toBe(false)
    expect(domainMatches('example.com.evil.io', 'example.com')).toBe(false)
  })
})

function textResponse(body: string, init: ResponseInit & { type?: string } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/html', ...(init.headers as object) },
  })
}

describe('guardedFetch', () => {
  it('follows redirects manually and returns the final URL', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(url)
      expect(init?.redirect).toBe('manual')
      if (url.endsWith('/a'))
        return new Response(null, { status: 302, headers: { location: '/b' } })
      return textResponse('<p>done</p>')
    }) as unknown as typeof fetch
    const page = await guardedFetch('https://example.com/a', { fetchImpl, resolveDns: false })
    expect(page.finalUrl).toBe('https://example.com/b')
    expect(seen).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('blocks a redirect to a private address (the SSRF bypass)', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    }) as unknown as typeof fetch
    await expect(
      guardedFetch('https://example.com/', { fetchImpl, resolveDns: false }),
    ).rejects.toBeInstanceOf(FetchBlockedError)
    expect(seen).toEqual(['https://example.com/'])
  })

  it('blocks a redirect to a non-http scheme', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 301,
        headers: { location: 'file:///etc/passwd' },
      })) as unknown as typeof fetch
    await expect(
      guardedFetch('https://example.com/', { fetchImpl, resolveDns: false }),
    ).rejects.toBeInstanceOf(FetchBlockedError)
  })

  it('gives up after too many redirects', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: '/loop' },
      })) as unknown as typeof fetch
    await expect(
      guardedFetch('https://example.com/', { fetchImpl, resolveDns: false, maxRedirects: 3 }),
    ).rejects.toThrow(/Too many redirects/)
  })

  it('caps the body size', async () => {
    const fetchImpl = (async () => textResponse('x'.repeat(10_000))) as unknown as typeof fetch
    const page = await guardedFetch('https://example.com/', {
      fetchImpl,
      resolveDns: false,
      maxBytes: 1000,
    })
    expect(page.truncated).toBe(true)
    expect(page.body.length).toBe(1000)
  })

  it('applies allowed and blocked domain lists', async () => {
    const fetchImpl = (async () => textResponse('ok')) as unknown as typeof fetch
    await expect(
      guardedFetch('https://bad.example.com/', {
        fetchImpl,
        resolveDns: false,
        blockedDomains: ['example.com'],
      }),
    ).rejects.toThrow(/blockedDomains/)
    await expect(
      guardedFetch('https://other.org/', {
        fetchImpl,
        resolveDns: false,
        allowedDomains: ['example.com'],
      }),
    ).rejects.toThrow(/allowedDomains/)
    await expect(
      guardedFetch('https://docs.example.com/', {
        fetchImpl,
        resolveDns: false,
        allowedDomains: ['example.com'],
      }),
    ).resolves.toBeDefined()
  })

  it('reports HTTP errors', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(
      guardedFetch('https://example.com/', { fetchImpl, resolveDns: false }),
    ).rejects.toThrow(/HTTP 404/)
  })

  it('decodes the declared charset', async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]) // "café" in latin1
    const fetchImpl = (async () =>
      new Response(bytes, {
        headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
      })) as unknown as typeof fetch
    const page = await guardedFetch('https://example.com/', { fetchImpl, resolveDns: false })
    expect(page.body).toBe('café')
  })
})

describe('web_fetch tool', () => {
  let ws: TestWorkspace
  beforeEach(async () => {
    ws = await makeWorkspace()
  })
  afterEach(() => ws.cleanup())

  it('refuses private targets before any network access', async () => {
    const r = await webFetchTool.execute({ url: 'http://127.0.0.1:1/', timeout_ms: 2000 }, ws.ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Blocked/)
  })

  it('honours web.blockedDomains from config', async () => {
    const ctx = { ...ws.ctx, web: { blockedDomains: ['example.com'] } }
    const r = await webFetchTool.execute({ url: 'https://example.com/', timeout_ms: 2000 }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/blockedDomains/)
  })
})

describe('search providers', () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

  it('Brave maps results, sends the token and filters domains', async () => {
    let req: { url: string; headers: Record<string, string> } | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      req = { url, headers: init.headers as Record<string, string> }
      return json({
        web: {
          results: [
            { url: 'https://docs.example.com/a', title: 'A', description: 'da' },
            { url: 'https://spam.io/b', title: 'B' },
          ],
        },
      })
    }) as unknown as typeof fetch
    const results = await new BraveSearchProvider('k', fetchImpl).search('q', {
      blockDomains: ['spam.io'],
      locale: 'en-US',
    })
    expect(results.map((r) => r.title)).toEqual(['A'])
    expect(req?.headers['X-Subscription-Token']).toBe('k')
    expect(req?.url).toContain('search_lang=en')
  })

  it('Tavily posts a JSON body with domain filters', async () => {
    let body: Record<string, unknown> = {}
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk')
      return json({ results: [{ url: 'https://a.dev/x', title: 'T', content: 'C' }] })
    }) as unknown as typeof fetch
    const results = await new TavilyProvider('tk', fetchImpl).search('q', {
      limit: 3,
      allowDomains: ['a.dev'],
    })
    expect(body).toMatchObject({ query: 'q', max_results: 3, include_domains: ['a.dev'] })
    expect(results[0]).toMatchObject({ title: 'T', snippet: 'C', domain: 'a.dev' })
  })

  it('Exa sends x-api-key and maps results', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('ek')
      return json({ results: [{ url: 'https://e.io/1', title: null, text: 'some  text' }] })
    }) as unknown as typeof fetch
    const results = await new ExaProvider('ek', fetchImpl).search('q')
    expect(results[0]).toMatchObject({ title: 'https://e.io/1', snippet: 'some text' })
  })

  it('surfaces API errors', async () => {
    const fetchImpl = (async () =>
      new Response('bad key', { status: 401 })) as unknown as typeof fetch
    await expect(new BraveSearchProvider('k', fetchImpl).search('q')).rejects.toThrow(/401/)
  })

  it('DuckDuckGo parses result blocks and unwraps redirect URLs', async () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpage">Title &amp; more</a>
      <a class="result__snippet" href="x">A <b>snippet</b></a>`
    const fetchImpl = (async () => textResponse(html)) as unknown as typeof fetch
    const results = await new DuckDuckGoProvider(fetchImpl).search('q')
    expect(results).toEqual([
      {
        url: 'https://example.org/page',
        title: 'Title & more',
        snippet: 'A snippet',
        domain: 'example.org',
      },
    ])
  })

  describe('createSearchProvider', () => {
    it('auto prefers keyed providers, falling back to DuckDuckGo', () => {
      expect(createSearchProvider({}, {})?.id).toBe('duckduckgo')
      expect(createSearchProvider({}, { EXA_API_KEY: 'x' })?.id).toBe('exa')
      expect(createSearchProvider({}, { TAVILY_API_KEY: 'x', EXA_API_KEY: 'x' })?.id).toBe('tavily')
      expect(createSearchProvider({}, { BRAVE_API_KEY: 'x', TAVILY_API_KEY: 'x' })?.id).toBe(
        'brave',
      )
      expect(createSearchProvider({ provider: 'anthropic' }, {})?.id).toBe('duckduckgo')
    })

    it('an explicit provider uses config apiKey or env, and errors without one', () => {
      expect(createSearchProvider({ provider: 'tavily', apiKey: 'k' }, {})?.id).toBe('tavily')
      expect(createSearchProvider({ provider: 'brave' }, { BRAVE_API_KEY: 'k' })?.id).toBe('brave')
      expect(() => createSearchProvider({ provider: 'exa' }, {})).toThrow(/EXA_API_KEY/)
    })

    it('"none" disables search', () => {
      expect(createSearchProvider({ provider: 'none' }, {})).toBeNull()
    })
  })

  it('web_search tool reports disabled and misconfigured states without throwing', async () => {
    const ws = await makeWorkspace({ web: { provider: 'none' } })
    try {
      const disabled = await webSearchTool.execute({ query: 'x' }, ws.ctx)
      expect(disabled.isError).toBe(true)
      expect(disabled.content).toMatch(/disabled/)
    } finally {
      ws.cleanup()
    }
    const saved = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    const ws2 = await makeWorkspace({ web: { provider: 'exa' } })
    try {
      const missing = await webSearchTool.execute({ query: 'x' }, ws2.ctx)
      expect(missing.isError).toBe(true)
      expect(missing.content).toMatch(/EXA_API_KEY/)
    } finally {
      ws2.cleanup()
      if (saved) process.env.EXA_API_KEY = saved
    }
  })
})
