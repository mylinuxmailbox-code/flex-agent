import { describe, expect, it } from 'vitest'
import { htmlToText } from '../src/tools/web/html-to-text.js'
import { canonicalUrl, checkUrl } from '../src/tools/web/ssrf-guard.js'

describe('SSRF guard', () => {
  it('blocks localhost and loopback addresses', () => {
    expect(checkUrl('http://localhost').allowed).toBe(false)
    expect(checkUrl('http://localhost:8080').allowed).toBe(false)
    expect(checkUrl('http://127.0.0.1:3000').allowed).toBe(false)
    expect(checkUrl('http://127.0.1.1').allowed).toBe(false)
    expect(checkUrl('http://0.0.0.0').allowed).toBe(false)
    expect(checkUrl('http://[::1]').allowed).toBe(false)
  })

  it('blocks private RFC-1918 CIDRs', () => {
    expect(checkUrl('http://10.0.0.1/status').allowed).toBe(false)
    expect(checkUrl('http://192.168.1.1/admin').allowed).toBe(false)
    expect(checkUrl('http://172.16.0.1/').allowed).toBe(false)
    expect(checkUrl('http://172.31.255.255/').allowed).toBe(false)
  })

  it('blocks cloud metadata endpoints', () => {
    expect(checkUrl('http://169.254.169.254/latest/meta-data/').allowed).toBe(false)
    expect(checkUrl('http://metadata.google.internal/computeMetadata/v1/').allowed).toBe(false)
  })

  it('blocks non-http(s) schemes', () => {
    expect(checkUrl('file:///etc/passwd').allowed).toBe(false)
    expect(checkUrl('ftp://ftp.example.com').allowed).toBe(false)
    expect(checkUrl('gopher://example.com').allowed).toBe(false)
  })

  it('allows legitimate public web URLs', () => {
    expect(checkUrl('https://example.com').allowed).toBe(true)
    expect(checkUrl('https://docs.github.com/en/rest').allowed).toBe(true)
    expect(checkUrl('http://info.cern.ch').allowed).toBe(true)
  })
})

describe('canonicalUrl', () => {
  it('strips tracking params', () => {
    const raw = 'https://example.com/page?utm_source=twitter&utm_medium=social&id=42&fbclid=xyz'
    const clean = canonicalUrl(raw)
    expect(clean).toContain('id=42')
    expect(clean).not.toContain('utm_source')
    expect(clean).not.toContain('utm_medium')
    expect(clean).not.toContain('fbclid')
  })
})

describe('htmlToText', () => {
  it('strips scripts, styles and navigational elements', () => {
    const html = `
      <html>
        <head><style>body { color: red; }</style></head>
        <body>
          <script>alert("evil")</script>
          <nav><a href="/">Home</a></nav>
          <h1>API Reference</h1>
          <p>This is <strong>important</strong> documentation.</p>
          <pre><code>const x = 1;</code></pre>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `
    const text = htmlToText(html, 'https://docs.example.com/api')
    expect(text).not.toContain('alert("evil")')
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('Copyright 2026')
    expect(text).toContain('# API Reference')
    expect(text).toContain('This is important documentation.')
    expect(text).toContain('const x = 1;')
    expect(text).toContain('Source: https://docs.example.com/api')
  })

  it('handles HTML entities', () => {
    const html = '<p>&quot;Hello&quot; &amp; &lt;World&gt; &#39;test&#39;</p>'
    const text = htmlToText(html, 'https://example.com')
    expect(text).toContain('"Hello" & <World> \'test\'')
  })
})
