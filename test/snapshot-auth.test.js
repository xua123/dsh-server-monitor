/**
 * Dashboard visibility of hosts whose login failed.
 *
 * A host that rejects every authentication method is shown as a (greyscale)
 * offline card by default, so the dashboard can offer "重连" / "编辑凭据" right on
 * the card. Set `hideAuthFailures: true` to restore the old "collapse them into
 * one footer line" behaviour.
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

const { createMonitor } = await import('../lib/index.js')
const { addManualTarget } = await import('../lib/manual-targets.js')

/** Give one test a fresh DSH home so manual targets never leak between cases. */
function useTempHome(t) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-monitor-auth-'))
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
}

function makeHostKey() {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return privateKey
}

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

/** A wrong-password manual target pointed at the rejecting test server. */
async function addFailingTarget(t, label) {
  const server = await startRejectingServer()
  t.after(() => server.close())
  const created = addManualTarget({
    name: label,
    host: '127.0.0.1',
    port: server.address().port,
    username: 'nobody',
    auth: 'password',
    password: 'definitely-wrong',
  })
  return `manual:${created.id}`
}

test('a failed login is listed as an offline card by default', async (t) => {
  useTempHome(t)
  const id = await addFailingTarget(t, 'auth-default')
  const monitor = createMonitor({ includeSshConfig: false, showLocal: false })
  t.after(() => monitor.close())

  const snapshot = await monitor.snapshot({ force: true })
  const card = (snapshot.remotes || []).find((entry) => entry.id === id)
  assert.ok(card, 'the auth failure must stay visible on the dashboard')
  assert.equal(card.status, 'offline')
  assert.equal(card.error.code, 'AUTH')
  // The browser needs these to render the "编辑凭据" action.
  assert.equal(card.manualId !== undefined, true)
  assert.equal(snapshot.summary.hiddenAuth, 0)
})

test('hideAuthFailures: true still collapses them', async (t) => {
  useTempHome(t)
  const id = await addFailingTarget(t, 'auth-hidden')
  const monitor = createMonitor({ includeSshConfig: false, showLocal: false, hideAuthFailures: true })
  t.after(() => monitor.close())

  const snapshot = await monitor.snapshot({ force: true })
  assert.equal((snapshot.remotes || []).some((entry) => entry.id === id), false)
  assert.equal(snapshot.summary.hiddenAuth, 1)
})
