/**
 * The credentials dialog is editable: address and port can be corrected too.
 * These tests pin the storage contract behind that form.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-monitor-edit-'))
process.env.DSH_HOME = tempHome

const {
  addManualTarget,
  buildTransientTarget,
  loadManualTargets,
  updateManualTarget,
} = await import('../lib/manual-targets.js')

function addTarget(name, port) {
  return addManualTarget({
    name,
    host: '127.0.0.1',
    port,
    username: 'nobody',
    auth: 'password',
    password: 'secret',
  })
}

test('updating a manual target can change its address and port', () => {
  const created = addTarget('editable', 2201)
  const updated = updateManualTarget(created.id, {
    host: '127.0.0.1',
    port: 2203,
    username: 'nobody',
    auth: 'password',
    password: '',
  })
  assert.equal(updated.port, 2203)
  assert.equal(updated.host, '127.0.0.1')

  const stored = loadManualTargets().find((entry) => entry.id === created.id)
  assert.equal(stored.port, 2203)
})

test('a second manual target cannot take an address that is already in use', () => {
  addTarget('first', 2211)
  const second = addTarget('second', 2212)

  assert.throws(
    () => updateManualTarget(second.id, { host: '127.0.0.1', port: 2211 }),
    /该地址和端口已经有另一台手动服务器/,
  )
})

test('an invalid address is rejected when editing', () => {
  const created = addTarget('invalid', 2221)
  assert.throws(
    () => updateManualTarget(created.id, { host: 'not a host', port: 2221 }),
    /服务器地址格式不正确/,
  )
})

test('the connection test uses the address currently typed in the form', () => {
  const created = addTarget('probe', 2231)
  const target = buildTransientTarget({
    id: created.id,
    host: '127.0.0.1',
    port: 2299,
    username: 'nobody',
    auth: 'password',
    password: 'secret',
  })
  assert.equal(target.host, '127.0.0.1')
  assert.equal(target.port, 2299)
  assert.match(target.id, /^test:127\.0\.0\.1:2299$/)
})
