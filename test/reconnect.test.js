/**
 * Tests for the dashboard's per-card "reconnect" action.
 *
 * `createMonitor().reconnect(id)` backs `POST /api/hosts/<id>/reconnect`: it drops
 * the pooled SSH connection for one host and collects it again immediately, so a
 * greyed-out card can be retried after the user fixed credentials or the network.
 *
 * DSH_HOME is redirected to a temp directory before the plugin modules are
 * imported, so manual targets created here never touch the real profile.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ssh2 = require('ssh2')

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-monitor-reconnect-'))
process.env.DSH_HOME = tempHome

const { createMonitor } = await import('../lib/index.js')
const { addManualTarget } = await import('../lib/manual-targets.js')

/** A throwaway RSA host key for the in-process test server. */
function makeHostKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return privateKey
}

/** Start a local SSH server that rejects every authentication method. */
function startRejectingServer() {
  const server = new ssh2.Server({ hostKeys: [makeHostKey()] }, (connection) => {
    connection.on('error', () => {})
    connection.on('authentication', (context) => {
      context.reject(['password', 'keyboard-interactive', 'publickey'])
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/** A monitor that only knows about manual targets, so nothing dials the real ssh config. */
function createIsolatedMonitor() {
  return createMonitor({ includeSshConfig: false, showLocal: false })
}

test('reconnect rejects an unknown host id', async (t) => {
  const monitor = createIsolatedMonitor()
  t.after(() => monitor.close())

  await assert.rejects(monitor.reconnect('ssh:does-not-exist'), (error) => {
    assert.equal(error.statusCode, 404)
    return true
  })
})

test('reconnect re-collects a manual target and returns its fresh failure', async (t) => {
  const server = await startRejectingServer()
  t.after(() => server.close())

  const uncaught = []
  const onUncaught = (error) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  t.after(() => process.off('uncaughtException', onUncaught))

  const created = addManualTarget({
    name: 'retry-target',
    host: '127.0.0.1',
    port: server.address().port,
    username: 'nobody',
    auth: 'password',
    password: 'definitely-wrong',
  })

  const monitor = createIsolatedMonitor()
  t.after(() => monitor.close())

  const view = await monitor.reconnect(`manual:${created.id}`)
  assert.equal(view.id, `manual:${created.id}`)
  assert.equal(view.status, 'offline')
  assert.equal(view.error.code, 'AUTH')

  // A second retry must work too: the pooled connection was dropped, not reused.
  const again = await monitor.reconnect(`manual:${created.id}`)
  assert.equal(again.status, 'offline')

  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(uncaught.map((error) => error && error.message), [])
})
