/*
 * Post-build step that makes this package's published types resolve.
 *
 * Several of the emitted declarations import types from
 * `@hansekontor/checkout-components`, which ships none of its own. The ambient
 * declaration that supplies them lives in @bbridge/sdk and is published with it;
 * this package deliberately does not carry a second copy, because two
 * `declare module` blocks for one specifier do not merge -- one wins, and neither
 * package chooses which. (That collision is exactly what broke this package's own
 * build when the sdk's copy was first published.)
 *
 * But a consumer only loads the sdk's declaration if something pulls it in, and
 * nothing here does: this package's public signatures use its own types plus
 * primitives, so tsc emits no import of @bbridge/sdk into index.d.ts even though
 * the implementation depends on it.
 *
 * `/// <reference types="..." />` is the mechanism for that. It resolves through
 * node_modules rather than by relative path, so it keeps working wherever the
 * dependency is hoisted to, and it transitively brings in the sdk's own reference
 * to the ambient declaration.
 *
 * Verified by compiling a real consumer against the packed tarball -- without this,
 * every declaration importing from checkout-components fails with TS7016.
 *
 * Plain node so it behaves the same on Windows and POSIX.
 */
const fs = require('fs')
const path = require('path')

const entry = path.join(__dirname, '..', 'dist', 'src', 'index.d.ts')
const REFERENCE = '/// <reference types="@bbridge/sdk" />'

const declarations = fs.readFileSync(entry, 'utf8')
if (!declarations.includes(REFERENCE))
    fs.writeFileSync(entry, `${REFERENCE}\n${declarations}`)
