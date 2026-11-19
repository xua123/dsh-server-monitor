/**
 * A manual credential set must win over the ~/.ssh/config entry for the same
 * address — that is what the dashboard's "设置凭据" action relies on when a
 * discovered host fails to authenticate and the user types a password or key.
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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-monitor-override-'))
process.env.DSH_HOME = tempHome

const { createMonitor } = await import('../lib/index.js')
const { addManualTarget } = await import('../lib/manual-targets.js')

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

test('a manual target overrides the ssh-config entry for the same address', async (t) => {
  const server = await startRejectingServer()
  t.after(() => server.close())
  const port = server.address().port

  const sshConfig = path.join(tempHome, 'ssh_config')
  fs.writeFileSync(
    sshConfig,
    ['Host 127.0.0.1', '  HostName 127.0.0.1', '  User nobody', `  Port ${port}`, ''].join('\n'),
    'utf8',
  )

  const monitor = createMonitor({ sshConfigFile: sshConfig, showLocal: false, waitMs: 600 })
  t.after(() => monitor.close())

  const discovered = await monitor.snapshot({ force: true })
  assert.equal((discovered.remotes || []).length, 1)
  assert.equal(discovered.remotes[0].id, 'ssh:127.0.0.1')
  assert.equal(discovered.remotes[0].source, 'ssh-config')

  const created = addManualTarget({
    name: 'pinned-creds',
    host: '127.0.0.1',
    port,
    username: 'nobody',
    auth: 'password',
    password: 'definitely-wrong',
  })

  const overridden = await monitor.snapshot({ force: true })
  assert.equal((overridden.remotes || []).length, 1, 'the manual record must replace the discovered one')
  const card = overridden.remotes[0]
  assert.equal(card.id, `manual:${created.id}`)
  assert.equal(card.source, 'manual')
  assert.equal(card.status, 'offline')
  assert.equal(card.error.code, 'AUTH')
  assert.equal(overridden.sources.sshConfig, 1)
  assert.equal(overridden.sources.manual, 1)

  // The override is reconnectable like any other target.
  const retried = await monitor.reconnect(`manual:${created.id}`)
  assert.equal(retried.status, 'offline')
  assert.equal(retried.error.code, 'AUTH')
})
