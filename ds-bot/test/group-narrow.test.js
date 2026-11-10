import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// docs/plans/2026-11-11-group-ui-narrow.md: at 390 px a group chat has no horizontal
// scroll and an approval card fits. These are the rules that keep it so.
const { outputFiles } = await build({
  stdin: {
    contents: "export { CONVERSATION_CSS, SHELL_CSS } from './src/client/styles.js'\nexport { MEMBER_CSS } from './src/client/member-status.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/*'],
})
// The styles need no React at load: stubs keep the bundle's imports quiet.
const module = { exports: {} }
const stub = new Proxy(() => stub, { get: (_target, key) => (key === '__esModule' ? false : stub) })
runInNewContext(outputFiles[0].text, { module, exports: module.exports, require: () => stub, window: {}, document: undefined, navigator: {}, console })
const { CONVERSATION_CSS, SHELL_CSS, MEMBER_CSS } = module.exports
const css = `${SHELL_CSS}\n${CONVERSATION_CSS}\n${MEMBER_CSS}`
const rule = selector => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => sel.split(',').map(part => part.trim()).includes(selector)).map(([, , body]) => body).join(';')

test('group rows shrink and wrap instead of widening the column', () => {
  assert.match(rule('.bt-group-msg'), /min-width:0/)
  assert.match(rule('.bt-group-replies'), /min-width:0/)
  assert.match(rule('.bt-group-name'), /overflow-wrap:anywhere/)
  assert.match(rule('.bt-group-name:has(>.bt-lead)'), /flex-wrap:wrap/)
  assert.match(rule('.bt-event'), /overflow-wrap:anywhere/)
})

test('an approval card stays inside its column, and its buttons wrap', () => {
  assert.match(rule('.bt-mw-card'), /max-width:100%/)
  assert.match(rule('.bt-mw-card'), /box-sizing:border-box/)
  assert.match(rule('.bt-mw-card'), /overflow-wrap:anywhere/)
  assert.match(rule('.bt-mw-actions'), /flex-wrap:wrap/)
  assert.match(rule('.bt-mw-code'), /text-overflow:ellipsis/)
})
