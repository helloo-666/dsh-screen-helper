/**
 * Ship the PowerShell input helpers next to the compiled output.
 *
 * The installed bundle contains only `lib/`, so a helper resolved from the
 * package root would be missing at runtime. Copying it into `lib/scripts/`
 * keeps `background-input.ps1` adjacent to the JS that spawns it, in both the
 * source tree and every installed copy.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'scripts', 'background-input.ps1')
const destDir = join(root, 'lib', 'scripts')
const dest = join(destDir, 'background-input.ps1')

if (!existsSync(src)) {
  console.error('copy-helpers: missing', src)
  process.exit(1)
}
mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
console.log('copy-helpers: shipped background-input.ps1 ->', dest)
