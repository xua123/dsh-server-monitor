/**
 * SSH transport for metric collection.
 *
 * One persistent connection per `host:port:user`, reused across snapshots and
 * closed after an idle period. Connections are established with ssh2 using the
 * credentials already stored by dsh-remote (password / private key / agent), so
 * the plugin does not invent a second authentication story.
 *
 * Host keys use trust-on-first-use: the SHA-256 fingerprint of every host is
 * recorded under `$DSH_HOME/server-monitor/known-hosts.json` on first contact,
 * and a changed fingerprint is refused instead of silently accepted. Set
 * `hostKeyPolicy: 'off'` to disable that check.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { dshHome, expandPath, readJsonFile, targetKey, writeJsonFile } from './util.js'

// Resolve ssh2 through CommonJS. On some DSH builds the host plugin is loaded by
// an ESM loader that produced an empty namespace for this CJS package
// (`import { Client }` / `import * as ssh2` both yielded undefined). `require`
// is the one resolution path that does not depend on ESM/CJS interop.
const require = createRequire(import.meta.url)
const ssh2 = require('ssh2')
const SshClient = ssh2 && ssh2.Client

if (typeof SshClient !== 'function') {
  throw new Error(`dsh-server-monitor: ssh2.Client is unavailable (exports: ${Object.keys(ssh2 || {}).join(', ')})`)
}

/** A failure with a stable, UI-friendly code. */
export class MonitorError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'MonitorError'
    this.code = code
    Object.assign(this, extra)
  }
}

/** Human sentence for a failure code. */
export function friendlyError(error) {
  const code = error && error.code
  if (code === 'AUTH') return '认证失败：用户名、密码或密钥不被该主机接受'
  if (code === 'NETWORK') return '无法连接：网络不可达或 SSH 端口未开放'
  if (code === 'TIMEOUT') return '连接超时：主机在限定时间内没有响应'
  if (code === 'HOSTKEY') return '主机密钥已变化，已阻止连接（如确认安全请清理 known-hosts.json）'
  if (code === 'UNSUPPORTED') return '暂不支持该主机的系统类型（目前支持 Linux 远程主机）'
  if (code === 'NO_CREDENTIALS') return '没有可用凭据：请在 dsh-remote 中配置密码或密钥'
  const raw = error && error.message ? String(error.message) : '未知错误'
  return raw
}

/** Map an ssh2/network error onto the plugin's failure vocabulary. */
export function classifyError(error) {
  if (error instanceof MonitorError) return error
  const message = error && error.message ? String(error.message) : String(error || '')
  const code = String((error && error.code) || '')
  if (/host key|host denied|fingerprint/i.test(message)) {
    return new MonitorError('HOSTKEY', message, { cause: error })
  }
  if (/authentication methods failed|permission denied|authentication failure|no auth/i.test(message)) {
    return new MonitorError('AUTH', message, { cause: error })
  }
  if (/timed out|timeout/i.test(message) || code === 'ETIMEDOUT') {
    return new MonitorError('TIMEOUT', message, { cause: error })
  }
  if (['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EPIPE'].includes(code)) {
    return new MonitorError('NETWORK', message, { cause: error })
  }
  return new MonitorError('INTERNAL', message, { cause: error })
}

function sha256Fingerprint(key) {
  const raw = Buffer.isBuffer(key) ? key : Buffer.from(key || '')
  return `SHA256:${crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`
}

/** Trust-on-first-use host-key store, persisted as one small JSON object. */
class KnownHosts {
  constructor(file, policy, log) {
    this.file = file
    this.policy = policy === 'off' ? 'off' : 'tofu'
    this.log = typeof log === 'function' ? log : () => {}
    this.records = null
    this.dirty = false
  }

  #load() {
    if (this.records !== null) return this.records
    const data = readJsonFile(this.file)
    this.records = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
    return this.records
  }

  /**
   * @param {object} target
   * @param {Buffer} key raw host key blob from ssh2
   * @returns {boolean} true when the connection may proceed
   */
  verify(target, key) {
    if (this.policy === 'off') return true
    const records = this.#load()
    const id = `${String(target.host).toLowerCase()}:${Number(target.port) || 22}`
    const fingerprint = sha256Fingerprint(key)
    const known = records[id]
    if (known === undefined) {
      records[id] = { fingerprint, firstSeen: new Date().toISOString(), label: target.name || target.host }
      this.dirty = true
      this.#flush()
      return true
    }
    if (known.fingerprint === fingerprint) return true
    this.log(`host key changed for ${id}: ${known.fingerprint} -> ${fingerprint}`)
    return false
  }

  #flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      writeJsonFile(this.file, this.records)
    } catch {
      /* trust records are a convenience; a read-only home must not break metrics */
    }
  }
}

/** Resolve the connection options for one target. */
function localUsername() {
  try {
    return os.userInfo().username
  } catch {
    return process.env.USERNAME || process.env.USER || 'root'
  }
}

function connectionOptions(target, connectTimeoutMs) {
  const port = Number(target.port) || 22
  const options = {
    host: target.host,
    port,
    username: target.username || localUsername(),
    readyTimeout: Math.max(2000, Number(connectTimeoutMs) || 8000),
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    tryKeyboard: true,
  }

  if (target.password) options.password = target.password

  let keyPath = target.privateKeyPath ? expandPath(target.privateKeyPath) : ''
  if (keyPath === '' && !target.password) {
    for (const candidate of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const full = path.join(os.homedir(), '.ssh', candidate)
      try {
        if (fs.statSync(full).isFile()) {
          keyPath = full
          break
        }
      } catch {
        /* keep looking */
      }
    }
  }
  if (keyPath !== '') {
    try {
      options.privateKey = fs.readFileSync(keyPath)
      if (target.passphrase) options.passphrase = target.passphrase
      options.privateKeyPath = keyPath
    } catch {
      /* an unreadable explicit key falls back to password/agent below */
    }
  }

  if (options.password === undefined && options.privateKey === undefined) {
    const agent = process.env.SSH_AUTH_SOCK
      || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : '')
    if (agent) options.agent = agent
  }

  return options
}

/**
 * A small SSH connection pool with idle eviction.
 */
export class SshPool {
  /**
   * @param {object} config
   * @param {number} [config.idleCloseMs]
   * @param {string} [config.knownHostsFile]
   * @param {string} [config.hostKeyPolicy]
   * @param {(message: string) => void} [config.log]
   */
  constructor(config = {}) {
    this.idleCloseMs = Math.max(10000, Number(config.idleCloseMs) || 120000)
    this.connectTimeoutMs = Math.max(2000, Number(config.connectTimeoutMs) || 8000)
    this.knownHosts = new KnownHosts(
      config.knownHostsFile || path.join(dshHome(), 'server-monitor', 'known-hosts.json'),
      config.hostKeyPolicy,
      config.log,
    )
    this.log = typeof config.log === 'function' ? config.log : () => {}
    this.entries = new Map()
    this.sweeper = setInterval(() => this.#sweep(), 30000)
    if (typeof this.sweeper.unref === 'function') this.sweeper.unref()
  }

  #sweep() {
    const now = Date.now()
    for (const [key, entry] of [...this.entries]) {
      if (now - entry.lastUsed > this.idleCloseMs) {
        this.log(`closing idle SSH connection ${key}`)
        this.#drop(key, entry)
      }
    }
  }

  #drop(key, entry) {
    if (entry === undefined) return
    if (this.entries.get(key) === entry) this.entries.delete(key)
    try {
      entry.client.end()
    } catch {
      /* already gone */
    }
  }

  async #client(target) {
    const key = targetKey(target)
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      existing.lastUsed = Date.now()
      try {
        await existing.ready
        return existing.client
      } catch (error) {
        this.#drop(key, existing)
        throw error
      }
    }

    const entry = { client: new SshClient(), lastUsed: Date.now(), ready: null, key }
    this.entries.set(key, entry)
    entry.ready = this.#connect(target, entry).catch((error) => {
      this.#drop(key, entry)
      throw classifyError(error)
    })
    // Avoid an unhandled rejection when nobody awaits before the catch above.
    entry.ready.catch(() => {})
    await entry.ready
    entry.lastUsed = Date.now()
    return entry.client
  }

  #connect(target, entry) {
    const client = entry.client
    const options = connectionOptions(target, this.connectTimeoutMs)
    const hostKeyPolicy = this.knownHosts

    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }

      client.once('ready', () => settle(resolve, undefined))
      client.once('error', (error) => settle(reject, error))
      client.once('close', () => {
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
        settle(reject, new MonitorError('NETWORK', 'SSH 连接已关闭'))
      })
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => target.password || ''))
      })

      client.connect({
        ...options,
        hostVerifier: (key, verify) => {
          let allowed = false
          try {
            allowed = hostKeyPolicy.verify(target, key)
          } catch {
            allowed = false
          }
          if (typeof verify === 'function') {
            verify(allowed)
            return undefined
          }
          return allowed
        },
      })
    })
  }

  /**
   * Execute one command on a target and return its output.
   *
   * @param {object} target
   * @param {string} command
   * @param {{timeoutMs?: number, maxBytes?: number}} [options]
   * @returns {Promise<{stdout: string, stderr: string, code: number, ms: number}>}
   */
  async exec(target, command, options = {}) {
    const client = await this.#client(target)
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 12000)
    const maxBytes = Math.max(16 * 1024, Number(options.maxBytes) || 512 * 1024)
    const started = Date.now()

    return await new Promise((resolve, reject) => {
      let settled = false
      let stream = null
      let stdout = ''
      let stderr = ''
      let truncated = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      const timer = setTimeout(() => {
        finish(reject, new MonitorError('TIMEOUT', `命令在 ${timeoutMs}ms 内没有完成`))
        try {
          stream?.close()
        } catch {
          /* stream might not exist yet */
        }
        this.#drop(targetKey(target), this.entries.get(targetKey(target)))
      }, timeoutMs)

      client.exec(command, (error, nextStream) => {
        if (error) {
          finish(reject, classifyError(error))
          this.#drop(targetKey(target), this.entries.get(targetKey(target)))
          return
        }
        stream = nextStream
        stream.setEncoding('utf8')
        stream.on('data', (chunk) => {
          if (stdout.length < maxBytes) stdout += chunk
          else truncated = true
        })
        stream.stderr.setEncoding('utf8')
        stream.stderr.on('data', (chunk) => {
          if (stderr.length < 64 * 1024) stderr += chunk
        })
        stream.once('error', (streamError) => {
          finish(reject, classifyError(streamError))
          this.#drop(targetKey(target), this.entries.get(targetKey(target)))
        })
        stream.once('close', (code) => {
          finish(resolve, {
            stdout: truncated ? stdout.slice(0, maxBytes) : stdout,
            stderr,
            code: Number.isInteger(code) ? code : 0,
            ms: Date.now() - started,
          })
        })
      })
    })
  }

  /** Close every connection and stop the idle sweeper. */
  closeAll() {
    clearInterval(this.sweeper)
    for (const [key, entry] of [...this.entries]) this.#drop(key, entry)
  }
}
