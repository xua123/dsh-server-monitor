/**
 * Regression tests for the SSH transport's failure paths.
 *
 * The important one is the authentication failure: ssh2 reports a dead agent as
 * an `error` event (`level: 'agent'`) and then carries on with the other auth
 * methods, so the real failure arrives as a *second* `error` event on the same
 * client. While `SshPool#connect` used a `once` listener, that second emit had
 * no handler and Node rethrew it as a process-level uncaught exception, taking
 * the whole DSH host down instead of showing an offline card.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { SshPool, resolveAgentSocket } from '../lib/ssh.js'

const require = createRequire(import.meta.url)
const ssh2 = require('ssh2')

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

test('authentication failure rejects with AUTH and never escapes as an uncaught error', async (t) => {
  const server = await startRejectingServer()
  t.after(() => server.close())
  const port = server.address().port

  const uncaught = []
  const onUncaught = (error) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  t.after(() => process.off('uncaughtException', onUncaught))

  const pool = new SshPool({ hostKeyPolicy: 'off', connectTimeoutMs: 4000 })
  t.after(() => pool.closeAll())

  const target = {
    host: '127.0.0.1',
    port,
    username: 'nobody',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    name: 'local-test',
  }

  await assert.rejects(
    pool.exec(target, 'true', { timeoutMs: 4000 }),
    (error) => {
      assert.equal(error.code, 'AUTH')
      return true
    },
  )

  // A late second `error` emit would surface after the rejection.
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.deepEqual(uncaught.map((error) => error && error.message), [])
})

test('a dead agent socket is not offered to ssh2', async (t) => {
  const previous = process.env.SSH_AUTH_SOCK
  t.after(() => {
    if (previous === undefined) delete process.env.SSH_AUTH_SOCK
    else process.env.SSH_AUTH_SOCK = previous
  })
  process.env.SSH_AUTH_SOCK = process.platform === 'win32'
    ? '\\\\.\\pipe\\dsh-agent-missing-for-test'
    : '/tmp/dsh-agent-missing-for-test.sock'

  assert.equal(await resolveAgentSocket(), '')
})
