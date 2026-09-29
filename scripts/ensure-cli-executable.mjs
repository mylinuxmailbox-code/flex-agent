import { chmodSync, existsSync } from 'node:fs'

const path = 'dist/cli/main.js'
if (existsSync(path)) chmodSync(path, 0o755)
