import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editFileTool, writeFileTool } from '../src/tools/filesystem/edit.js'
import { deleteFileTool, moveFileTool } from '../src/tools/filesystem/mutate.js'
import { PathError, resolvePath } from '../src/tools/filesystem/paths.js'
import { searchRegexTool, searchTextTool } from '../src/tools/filesystem/search.js'
import { SnapshotManager } from '../src/tools/filesystem/snapshots.js'
import { findSymbolTool } from '../src/tools/filesystem/symbols.js'
import { gitDiffTool, gitLogTool, gitStatusTool } from '../src/tools/git/index.js'
import {
  checkOutputTool,
  killAllBackground,
  killProcessTool,
  runCommandTool,
} from '../src/tools/shell/run.js'
import { makeWorkspace, type TestWorkspace } from './helpers/tool-context.js'

let ws: TestWorkspace

beforeEach(async () => {
  ws = await makeWorkspace()
  SnapshotManager.get().clear()
})
afterEach(() => {
  killAllBackground()
  ws.cleanup()
})

const text = (r: { content: string }) => r.content

describe('resolvePath', () => {
  it('resolves relative paths inside the workspace', () => {
    expect(resolvePath('a/b.txt', ws.ctx)).toBe(join(ws.root, 'a/b.txt'))
  })

  it('rejects parent traversal', () => {
    expect(() => resolvePath('../outside.txt', ws.ctx, { allowScratch: false })).toThrow(PathError)
  })

  it('treats a sibling directory that merely shares a prefix as outside', () => {
    expect(() => resolvePath(`${ws.root}-evil/x`, ws.ctx, { allowScratch: false })).toThrow(
      PathError,
    )
  })

  it('does not confuse a file named "..foo" with a parent reference', () => {
    expect(resolvePath('..foo', ws.ctx)).toBe(join(ws.root, '..foo'))
  })

  it('rejects a symlink that points outside the workspace', () => {
    symlinkSync('/etc', join(ws.root, 'link'))
    expect(() => resolvePath('link/passwd', ws.ctx)).toThrow(PathError)
  })

  it('rejects writing a new file beneath an escaping symlink', () => {
    symlinkSync('/tmp', join(ws.root, 'tmplink'))
    expect(() =>
      resolvePath('tmplink/new-file', ws.ctx, { mustBeInWorkspace: true, allowScratch: false }),
    ).toThrow(PathError)
  })

  it('enforces mustExist', () => {
    expect(() => resolvePath('nope.txt', ws.ctx, { mustExist: true })).toThrow(/not found/)
  })

  it('blocks protected locations such as ~/.ssh even when workspace checks are off', () => {
    expect(() => resolvePath('~/.ssh/id_rsa', ws.ctx, { mustBeInWorkspace: false })).toThrow(
      PathError,
    )
  })
})

describe('edit_file', () => {
  it('replaces literally, so "$&" and "$1" in the replacement are not expanded', async () => {
    writeFileSync(join(ws.root, 'a.ts'), 'const price = 1\n')
    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'price = 1', new_string: 'price = "$&" + "$1" + "$$"' },
      ws.ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(readFileSync(join(ws.root, 'a.ts'), 'utf8')).toBe('const price = "$&" + "$1" + "$$"\n')
  })

  it('refuses an ambiguous match unless replace_all is set', async () => {
    writeFileSync(join(ws.root, 'a.ts'), 'x\nx\n')
    const result = await editFileTool.execute(
      { path: 'a.ts', old_string: 'x', new_string: 'y' },
      ws.ctx,
    )
    expect(result.isError).toBe(true)
    expect(readFileSync(join(ws.root, 'a.ts'), 'utf8')).toBe('x\nx\n')
  })

  it('records a snapshot so /undo restores the file, and refuses after outside changes', async () => {
    const file = join(ws.root, 'a.ts')
    writeFileSync(file, 'one\n')
    await editFileTool.execute({ path: 'a.ts', old_string: 'one', new_string: 'two' }, ws.ctx)
    writeFileSync(file, 'user edited this\n')

    const refused = await SnapshotManager.get().undo()
    expect(refused.success).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('user edited this\n')

    const forced = await SnapshotManager.get().undo({ force: true })
    expect(forced.success).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('one\n')

    const redone = await SnapshotManager.get().redo({ force: true })
    expect(redone.success).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('two\n')
  })
})

describe('write_file / move_file / delete_file', () => {
  it('write_file replaces a binary file but says it cannot be undone', async () => {
    writeFileSync(join(ws.root, 'img.bin'), Buffer.from([0, 1, 2, 0, 255, 0]))
    const result = await writeFileTool.execute({ path: 'img.bin', content: 'text' }, ws.ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toMatch(/cannot restore/)
    expect(SnapshotManager.get().canUndo()).toBe(false)
  })

  it('move_file is undoable', async () => {
    writeFileSync(join(ws.root, 'from.txt'), 'hello')
    const moved = await moveFileTool.execute({ from: 'from.txt', to: 'to.txt' }, ws.ctx)
    expect(moved.isError).toBeFalsy()
    expect(readFileSync(join(ws.root, 'to.txt'), 'utf8')).toBe('hello')
    expect(SnapshotManager.get().canUndo()).toBe(true)
    await SnapshotManager.get().undo()
    await SnapshotManager.get().undo()
    expect(readFileSync(join(ws.root, 'from.txt'), 'utf8')).toBe('hello')
  })

  it('delete_file will not remove a non-empty directory without recursive', async () => {
    mkdirSync(join(ws.root, 'd'))
    writeFileSync(join(ws.root, 'd', 'f.txt'), 'x')
    const result = await deleteFileTool.execute({ path: 'd' }, ws.ctx)
    expect(result.isError).toBe(true)
    expect(readFileSync(join(ws.root, 'd', 'f.txt'), 'utf8')).toBe('x')
  })

  it('delete_file can be undone', async () => {
    writeFileSync(join(ws.root, 'gone.txt'), 'precious')
    await deleteFileTool.execute({ path: 'gone.txt' }, ws.ctx)
    await SnapshotManager.get().undo()
    expect(readFileSync(join(ws.root, 'gone.txt'), 'utf8')).toBe('precious')
  })
})

describe('search tools', () => {
  beforeEach(() => {
    writeFileSync(join(ws.root, 'a.ts'), 'const Alpha = 1\n-flag here\nalpha two\n')
    writeFileSync(join(ws.root, 'b.md'), 'alpha in markdown\n')
  })

  it('search_text finds literal text and treats regex metacharacters literally', async () => {
    writeFileSync(join(ws.root, 'c.ts'), 'call(a.b)\n')
    const r = await searchTextTool.execute({ pattern: '(a.b)' }, ws.ctx)
    expect(text(r)).toContain('c.ts:1')
  })

  it('finds patterns that begin with a dash', async () => {
    const r = await searchTextTool.execute({ pattern: '-flag' }, ws.ctx)
    expect(r.isError).toBeFalsy()
    expect(text(r)).toContain('a.ts:2')
  })

  it('search_regex works and reports no ANSI escape codes', async () => {
    const r = await searchRegexTool.execute({ pattern: 'alph[a]' }, ws.ctx)
    expect(text(r)).toContain('a.ts')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence of escape codes
    expect(text(r)).not.toMatch(/\u001b\[/)
  })

  it('honours case_sensitive and smart-case', async () => {
    const insensitive = await searchTextTool.execute({ pattern: 'alpha', glob: '*.ts' }, ws.ctx)
    expect(text(insensitive)).toContain('a.ts:1')
    const sensitive = await searchTextTool.execute(
      { pattern: 'alpha', glob: '*.ts', case_sensitive: true },
      ws.ctx,
    )
    expect(text(sensitive)).not.toContain('a.ts:1')
    expect(text(sensitive)).toContain('a.ts:3')
  })

  it('restricts by glob and reports zero matches cleanly', async () => {
    const r = await searchTextTool.execute({ pattern: 'markdown', glob: '*.ts' }, ws.ctx)
    expect(text(r)).toMatch(/No matches/)
  })

  it('caps results per max_results', async () => {
    writeFileSync(join(ws.root, 'many.txt'), `${'hit\n'.repeat(50)}`)
    const r = await searchTextTool.execute({ pattern: 'hit', max_results: 5 }, ws.ctx)
    expect(text(r)).toMatch(/hit/)
    expect(
      text(r)
        .split('\n')
        .filter((l) => l.startsWith('many.txt:')).length,
    ).toBeLessThanOrEqual(5)
  })
})

describe('background processes', () => {
  async function waitFor(fn: () => Promise<boolean>, ms = 5000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error('timed out waiting')
  }

  it('runs a foreground command and returns its output', async () => {
    const r = await runCommandTool.execute({ command: 'echo hello-flex' }, ws.ctx)
    expect(text(r)).toContain('hello-flex')
  })

  it('surfaces a non-zero exit as an error result', async () => {
    const r = await runCommandTool.execute({ command: 'exit 3' }, ws.ctx)
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/3/)
  })

  it('starts a background process, polls output, and kills it', async () => {
    const started = await runCommandTool.execute(
      { command: 'echo up; sleep 30', background: true },
      ws.ctx,
    )
    const id = /bg-\d+/.exec(text(started))?.[0]
    expect(id).toBeDefined()

    await waitFor(async () =>
      text(await checkOutputTool.execute({ process_id: id! }, ws.ctx)).includes('up'),
    )
    const running = await checkOutputTool.execute({ process_id: id! }, ws.ctx)
    expect(text(running)).toMatch(/still running/)

    await killProcessTool.execute({ process_id: id! }, ws.ctx)
    await waitFor(async () =>
      text(await checkOutputTool.execute({ process_id: id! }, ws.ctx)).includes('finished'),
    )
  })

  it('reports an unknown process id', async () => {
    const r = await checkOutputTool.execute({ process_id: 'bg-999' }, ws.ctx)
    expect(r.isError).toBe(true)
  })

  it('does not leak secret environment variables to commands', async () => {
    process.env.OPENAI_API_KEY = 'sk-should-not-leak'
    try {
      const r = await runCommandTool.execute({ command: 'echo "k=[$OPENAI_API_KEY]"' }, ws.ctx)
      expect(text(r)).toContain('k=[]')
    } finally {
      delete process.env.OPENAI_API_KEY
    }
  })
})

describe('git tools', () => {
  const sh = (cmd: string) =>
    execSync(cmd, {
      cwd: ws.root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })

  it('reports status, diff and log for a real repository', async () => {
    sh('git init -q -b main')
    writeFileSync(join(ws.root, 'f.txt'), 'one\n')
    sh('git add . && git commit -qm first')
    writeFileSync(join(ws.root, 'f.txt'), 'two\n')
    writeFileSync(join(ws.root, 'new.txt'), 'x\n')

    const status = await gitStatusTool.execute({}, ws.ctx)
    expect(status.isError).toBeFalsy()
    expect(status.content).toMatch(/f\.txt/)
    expect(status.content).toMatch(/new\.txt/)

    const diff = await gitDiffTool.execute({}, ws.ctx)
    expect(diff.isError).toBeFalsy()
    expect(diff.content).toMatch(/-one/)
    expect(diff.content).toMatch(/\+two/)

    const log = await gitLogTool.execute({}, ws.ctx)
    expect(log.isError).toBeFalsy()
    expect(log.content).toMatch(/first/)
  })

  it('fails cleanly outside a repository', async () => {
    const status = await gitStatusTool.execute({}, ws.ctx)
    expect(status.isError).toBe(true)
  })
})

describe('find_symbol', () => {
  beforeEach(() => {
    writeFileSync(
      join(ws.root, 'a.ts'),
      [
        'export async function fetchUser(id: string) {',
        '  return db.get(id)',
        '}',
        'export class UserService {',
        '  async loadUser(id: string): Promise<User> {',
        '    return fetchUser(id)',
        '  }',
        '}',
        'export const makeThing = (x: number) => x * 2',
        'export interface UserRecord { id: string }',
        'type Alias = string',
      ].join('\n'),
    )
    writeFileSync(
      join(ws.root, 'b.py'),
      'class Repo:\n    def save_user(self, u):\n        pass\n\nMAX_USERS = 10\n',
    )
    writeFileSync(
      join(ws.root, 'c.go'),
      'package x\nfunc (s *Server) Handle(w int) {}\nfunc Plain() {}\n',
    )
    writeFileSync(join(ws.root, 'd.rs'), 'pub fn parse_line() {}\npub struct Token;\n')
  })

  const def = (symbol: string) => findSymbolTool.execute({ symbol }, ws.ctx)

  it.each([
    ['fetchUser', 'a.ts:1'],
    ['UserService', 'a.ts:4'],
    ['loadUser', 'a.ts:5'],
    ['makeThing', 'a.ts:9'],
    ['UserRecord', 'a.ts:10'],
    ['Alias', 'a.ts:11'],
    ['Repo', 'b.py:1'],
    ['save_user', 'b.py:2'],
    ['MAX_USERS', 'b.py:5'],
    ['Handle', 'c.go:2'],
    ['Plain', 'c.go:3'],
    ['parse_line', 'd.rs:1'],
    ['Token', 'd.rs:2'],
  ])('finds the definition of %s', async (symbol, where) => {
    const r = await def(symbol)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain(where)
  })

  it('does not report a call site as a definition', async () => {
    const r = await def('fetchUser')
    expect(r.content).not.toContain('a.ts:6')
  })

  it('finds references, including call sites', async () => {
    const r = await findSymbolTool.execute({ symbol: 'fetchUser', mode: 'references' }, ws.ctx)
    expect(r.content).toContain('a.ts:1')
    expect(r.content).toContain('a.ts:6')
  })

  it('does not match a longer identifier that merely contains the symbol', async () => {
    const r = await findSymbolTool.execute({ symbol: 'User', mode: 'references' }, ws.ctx)
    expect(r.content).not.toContain('a.ts:1:') // fetchUser only
  })

  it('reports a miss clearly and rejects non-identifiers', async () => {
    const miss = await def('doesNotExist')
    expect(miss.isError).toBe(true)
    expect(miss.content).toMatch(/No definition found/)
    expect(() => findSymbolTool.inputSchema.parse({ symbol: 'a b' })).toThrow()
  })
})
