/*
 * Post-build step that makes this package's published types actually resolve.
 *
 * Two things are wrong with the raw tsc output, and each needs its own fix:
 *
 * 1. tsc does not emit `.d.ts` *inputs* to outDir - it only emits declarations it
 *    generates - so the hand-written ambient declaration for
 *    `@hansekontor/checkout-components` (which ships no types of its own) never
 *    reaches dist. Fixed by copying it.
 *
 * 2. tsc strips the `/// <reference path>` from src/index.ts when emitting
 *    dist/src/index.d.ts, because index.ts itself uses none of the referenced
 *    types - it only re-exports. Fixed by writing the reference back in.
 *
 * Without both, a TypeScript consumer gets TS7016 "Could not find a declaration
 * file for module '@hansekontor/checkout-components'" from every emitted
 * declaration that imports a type from it: merkle, oracle, preimage, script.
 * Verified by compiling a real consumer against the packed tarball, not inferred.
 *
 * One reference is enough for all of them: an ambient `declare module` is global
 * once anything in the program loads it, and dist/src/index.d.ts is always loaded
 * because it is the package's `types` entry.
 *
 * Plain node rather than a shell copy so it behaves the same on Windows and POSIX.
 */
const fs = require('fs')
const path = require('path')

const sdkRoot = path.join(__dirname, '..')
const from = path.join(sdkRoot, 'src', 'types')
const to = path.join(sdkRoot, 'dist', 'src', 'types')
const entry = path.join(sdkRoot, 'dist', 'src', 'index.d.ts')

const REFERENCE = '/// <reference path="./types/checkout-components.d.ts" />'

fs.mkdirSync(to, { recursive: true })

for (const file of fs.readdirSync(from)) {
    if (file.endsWith('.d.ts'))
        fs.copyFileSync(path.join(from, file), path.join(to, file))
}

const declarations = fs.readFileSync(entry, 'utf8')
if (!declarations.includes(REFERENCE))
    fs.writeFileSync(entry, `${REFERENCE}\n${declarations}`)
