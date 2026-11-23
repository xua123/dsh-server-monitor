/**
 * Manually added SSH targets.
 *
 * The plugin can monitor servers the user adds from the dashboard, not only the
 * machines already saved by dsh-remote or present in ~/.ssh/config. Records live
 * in `$DSH_HOME/server-monitor/targets.json`; pasted private keys are written to
 * `$DSH_HOME/server-monitor/keys/<id>.key` with owner-only permissions.
 *
 * Secrets never leave the host process: `publicManualTarget()` is the only shape
 * returned to the browser, and it only exposes booleans.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, expandPath, isDialableHost, readJsonFile, writeJsonFile } from './util.js'

/** Directory that owns manual targets, keys and the TOFU host-key store. */
export function monitorHome() {
  return path.join(dshHome(), 'server-monitor')
}

export function targetsFile() {
  return path.join(monitorHome(), 'targets.json')
}

export function keysDir() {
  return path.join(monitorHome(), 'keys')
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    /* Windows ignores POSIX modes; the user profile ACL still applies */
  }
}

function loadRawList() {
  const data = readJsonFile(targetsFile())
  const list = Array.isArray(data?.targets) ? data.targets : []
  return list.filter((entry) => entry !== null && typeof entry === 'object')
}

function saveRawList(list) {
  ensurePrivateDir(monitorHome())
  writeJsonFile(targetsFile(), { version: 1, targets: list })
  try {
    fs.chmodSync(targetsFile(), 0o600)
  } catch {
    /* see ensurePrivateDir */
  }
}

function normalizeStored(entry) {
  const auth = entry.auth === 'key' ? 'key' : 'password'
  return {
    id: String(entry.id || ''),
    name: String(entry.name || entry.host || '').slice(0, 80),
    host: String(entry.host || ''),
    port: Number(entry.port) || 22,
    username: String(entry.username || ''),
    auth,
    password: auth === 'password' ? String(entry.password || '') : '',
    privateKeyPath: auth === 'key' ? String(entry.privateKeyPath || '') : '',
    passphrase: auth === 'key' ? String(entry.passphrase || '') : '',
    createdAt: String(entry.createdAt || ''),
    updatedAt: String(entry.updatedAt || entry.createdAt || ''),
  }
}

/** All manual targets, with secrets, for the collector. */
export function loadManualTargets() {
  return loadRawList()
    .map(normalizeStored)
    .filter((entry) => entry.id !== '' && isDialableHost(entry.host) && entry.username !== '')
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim().slice(0, max)
}

function writeKeyFile(id, text) {
  ensurePrivateDir(keysDir())
  const file = path.join(keysDir(), `${id}.key`)
  const body = text.endsWith('\n') ? text : `${text}\n`
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* see ensurePrivateDir */
  }
  return file
}

function removeKeyFile(file) {
  if (file === '') return
  const root = path.resolve(keysDir())
  const target = path.resolve(file)
  if (!target.startsWith(root + path.sep)) return
  try {
    fs.unlinkSync(target)
  } catch {
    /* already gone */
  }
}

/**
 * Add one server.
 *
 * @param {object} input
 * @param {string} [input.name]
 * @param {string} input.host
 * @param {number|string} [input.port]
 * @param {string} input.username
 * @param {'password'|'key'} [input.auth]
 * @param {string} [input.password]
 * @param {string} [input.privateKey] pasted key body
 * @param {string} [input.privateKeyPath] path to an existing key
 * @param {string} [input.passphrase]
 * @returns {object} public target
 */
export function addManualTarget(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const host = cleanText(source.host, 255)
  if (!isDialableHost(host)) throw new Error('服务器地址格式不正确')
  const port = Number(source.port) || 22
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535')
  const username = cleanText(source.username, 128)
  if (username === '' || /\s/.test(username)) throw new Error('请填写有效的 SSH 用户名')
  const auth = source.auth === 'key' ? 'key' : 'password'
  const name = cleanText(source.name, 80) || host
  const now = new Date().toISOString()
  const id = `manual-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`

  let password = ''
  let privateKeyPath = ''
  let passphrase = ''
  if (auth === 'password') {
    password = cleanText(source.password, 4096)
    if (password === '') throw new Error('请填写 SSH 密码')
  } else {
    const pasted = cleanText(source.privateKey, 128 * 1024)
    const keyPathInput = cleanText(source.privateKeyPath, 1024)
    if (pasted !== '') {
      privateKeyPath = writeKeyFile(id, pasted)
    } else if (keyPathInput !== '') {
      const expanded = expandPath(keyPathInput)
      let stat
      try {
        stat = fs.statSync(expanded)
      } catch {
        throw new Error(`私钥文件不存在：${expanded}`)
      }
      if (!stat.isFile()) throw new Error(`私钥路径不是文件：${expanded}`)
      privateKeyPath = expanded
    } else {
      throw new Error('请粘贴私钥、选择私钥文件，或填写私钥路径')
    }
    passphrase = cleanText(source.passphrase, 4096)
  }

  const record = {
    id,
    name,
    host,
    port,
    username,
    auth,
    password,
    privateKeyPath,
    passphrase,
    createdAt: now,
    updatedAt: now,
  }
  const list = loadRawList().map(normalizeStored)
  list.push(record)
  saveRawList(list)
  return publicManualTarget(record)
}

/** Update an existing manual target; blank credentials keep existing secrets. */
export function updateManualTarget(id, input) {
  const cleanId = String(id == null ? '' : id).trim()
  const list = loadRawList().map(normalizeStored)
  const index = list.findIndex((entry) => entry.id === cleanId)
  if (index < 0) throw new Error('找不到该服务器')
  const prev = list[index]
  const source = input !== null && typeof input === 'object' ? input : {}

  const username = source.username !== undefined ? cleanText(source.username, 128) : prev.username
  if (username === '' || /\s/.test(username)) throw new Error('请填写有效的 SSH 用户名')
  const name = source.name !== undefined ? (cleanText(source.name, 80) || prev.host) : prev.name
  const auth = source.auth === 'key' ? 'key' : source.auth === 'password' ? 'password' : prev.auth

  let password = prev.password
  let privateKeyPath = prev.privateKeyPath
  let passphrase = prev.passphrase

  if (auth === 'password') {
    const nextPass = cleanText(source.password, 4096)
    if (nextPass !== '') {
      password = nextPass
    } else if (prev.auth !== 'password' || password === '') {
      throw new Error('请填写 SSH 密码')
    }
    if (prev.privateKeyPath) removeKeyFile(prev.privateKeyPath)
    privateKeyPath = ''
    passphrase = ''
  } else {
    password = ''
    const pasted = cleanText(source.privateKey, 128 * 1024)
    const keyPathInput = cleanText(source.privateKeyPath, 1024)
    if (pasted !== '') {
      if (prev.privateKeyPath) removeKeyFile(prev.privateKeyPath)
      privateKeyPath = writeKeyFile(cleanId, pasted)
    } else if (keyPathInput !== '') {
      const expanded = expandPath(keyPathInput)
      let stat
      try {
        stat = fs.statSync(expanded)
      } catch {
        throw new Error(`私钥文件不存在：${expanded}`)
      }
      if (!stat.isFile()) throw new Error(`私钥路径不是文件：${expanded}`)
      if (prev.privateKeyPath && prev.privateKeyPath !== expanded) removeKeyFile(prev.privateKeyPath)
      privateKeyPath = expanded
    } else if (prev.auth !== 'key' || privateKeyPath === '') {
      throw new Error('请粘贴私钥、选择私钥文件，或填写私钥路径')
    }
    if (source.passphrase !== undefined) {
      const nextPhrase = cleanText(source.passphrase, 4096)
      if (nextPhrase !== '' || pasted !== '' || keyPathInput !== '') passphrase = nextPhrase
    }
  }

  const updated = {
    ...prev,
    name,
    username,
    auth,
    password,
    privateKeyPath,
    passphrase,
    updatedAt: new Date().toISOString(),
  }
  list[index] = updated
  saveRawList(list)
  return publicManualTarget(updated)
}

/** Build a non-persisted SSH target for connection testing. */
export function buildTransientTarget(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const existing = source.id
    ? loadManualTargets().find((entry) => entry.id === String(source.id).trim())
    : undefined
  const host = existing ? existing.host : cleanText(source.host, 255)
  if (!isDialableHost(host)) throw new Error('服务器地址格式不正确')
  const port = existing ? existing.port : (Number(source.port) || 22)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535')
  const username = cleanText(source.username, 128) || (existing ? existing.username : '')
  if (username === '' || /\s/.test(username)) throw new Error('请填写有效的 SSH 用户名')
  const auth = source.auth === 'key' ? 'key' : 'password'

  if (auth === 'password') {
    const password = cleanText(source.password, 4096) || (existing && existing.auth === 'password' ? existing.password : '')
    if (password === '') throw new Error('请填写 SSH 密码')
    return { id: `test:${host}:${port}`, host, port, username, password, privateKeyPath: '', passphrase: '' }
  }
  const pasted = cleanText(source.privateKey, 128 * 1024)
  if (pasted !== '') {
    return {
      id: `test:${host}:${port}`,
      host,
      port,
      username,
      password: '',
      privateKey: pasted,
      passphrase: cleanText(source.passphrase, 4096),
    }
  }
  const keyPath = cleanText(source.privateKeyPath, 1024)
  const resolvedPath = keyPath !== '' ? expandPath(keyPath) : (existing && existing.auth === 'key' ? existing.privateKeyPath : '')
  if (resolvedPath === '') throw new Error('请粘贴私钥或选择私钥文件')
  return {
    id: `test:${host}:${port}`,
    host,
    port,
    username,
    password: '',
    privateKeyPath: resolvedPath,
    passphrase: cleanText(source.passphrase, 4096) || (existing ? existing.passphrase : ''),
  }
}

/** Delete one manual target and its owned key file. */
export function deleteManualTarget(id) {
  const clean = String(id == null ? '' : id).trim()
  const list = loadRawList().map(normalizeStored)
  const index = list.findIndex((entry) => entry.id === clean)
  if (index < 0) throw new Error('找不到该服务器')
  const [removed] = list.splice(index, 1)
  removeKeyFile(removed.privateKeyPath)
  saveRawList(list)
  return publicManualTarget(removed)
}

/** Browser-safe projection: no password, passphrase or key path. */
export function publicManualTarget(record) {
  return {
    id: record.id,
    name: record.name || record.host,
    host: record.host,
    port: Number(record.port) || 22,
    username: record.username,
    auth: record.auth === 'key' ? 'key' : 'password',
    hasPassword: record.auth !== 'key' && record.password !== '',
    hasKey: record.auth === 'key' && record.privateKeyPath !== '',
    createdAt: record.createdAt || '',
  }
}

/** Shape consumed by the SSH pool. */
export function toSshTarget(record) {
  return {
    id: `manual:${record.id}`,
    manualId: record.id,
    kind: 'remote',
    source: 'manual',
    name: record.name || record.host,
    alias: record.name || record.host,
    host: record.host,
    port: Number(record.port) || 22,
    username: record.username,
    password: record.password,
    privateKeyPath: record.privateKeyPath,
    passphrase: record.passphrase,
    saved: false,
    manual: true,
  }
}

/* ── targets hidden from the dashboard ────────────────────────────────────── */

export function hiddenFile() {
  return path.join(monitorHome(), 'hidden.json')
}

export function hiddenTargetKey(host, port) {
  return `${String(host == null ? '' : host).toLowerCase()}:${Number(port) || 22}`
}

/** Targets the user removed from the dashboard without touching their source. */
export function loadHiddenTargets() {
  const data = readJsonFile(hiddenFile())
  const list = Array.isArray(data?.targets) ? data.targets : []
  return list
    .filter((entry) => entry !== null && typeof entry === 'object' && isDialableHost(entry.host))
    .map((entry) => ({
      host: String(entry.host),
      port: Number(entry.port) || 22,
      key: String(entry.key || hiddenTargetKey(entry.host, entry.port)),
      hiddenAt: String(entry.hiddenAt || ''),
    }))
}

function saveHiddenTargets(list) {
  ensurePrivateDir(monitorHome())
  writeJsonFile(hiddenFile(), { version: 1, targets: list })
  try {
    fs.chmodSync(hiddenFile(), 0o600)
  } catch {
    /* Windows ignores POSIX modes */
  }
}

/** Hide one discovered target (dsh-remote / ssh-config) from the dashboard. */
export function hideTarget(host, port) {
  const cleanHost = String(host == null ? '' : host).trim()
  if (!isDialableHost(cleanHost)) throw new Error('服务器地址格式不正确')
  const cleanPort = Number(port) || 22
  const list = loadHiddenTargets()
  const key = hiddenTargetKey(cleanHost, cleanPort)
  if (!list.some((entry) => entry.key === key)) {
    list.push({ host: cleanHost, port: cleanPort, key, hiddenAt: new Date().toISOString() })
    saveHiddenTargets(list)
  }
  return { host: cleanHost, port: cleanPort, key }
}

/** Restore one hidden target. `key` is `host:port`. */
export function unhideTarget(key) {
  const clean = String(key == null ? '' : key).trim()
  const list = loadHiddenTargets()
  const index = list.findIndex((entry) => entry.key === clean)
  if (index < 0) throw new Error('找不到该隐藏记录')
  const [removed] = list.splice(index, 1)
  saveHiddenTargets(list)
  return removed
}

export function aliasesFile() {
  return path.join(monitorHome(), 'aliases.json')
}

/** Load custom display names keyed by target id (`local` or `target.id`). */
export function loadTargetAliases() {
  const data = readJsonFile(aliasesFile())
  const raw = data && typeof data.aliases === 'object' && data.aliases !== null ? data.aliases : {}
  const result = Object.create(null)
  for (const [id, name] of Object.entries(raw)) {
    const cleanId = String(id || '').trim()
    const cleanName = cleanText(name, 80)
    if (cleanId !== '' && cleanName !== '') result[cleanId] = cleanName
  }
  return result
}

/** Set or clear (when `name` is blank) a custom display name for a host. */
export function setTargetAlias(id, name) {
  const cleanId = String(id == null ? '' : id).trim()
  if (cleanId === '' || cleanId.length > 200) throw new Error('无效的服务器标识')
  const cleanName = cleanText(name, 80)
  const aliases = loadTargetAliases()
  if (cleanName === '') delete aliases[cleanId]
  else aliases[cleanId] = cleanName
  ensurePrivateDir(monitorHome())
  writeJsonFile(aliasesFile(), { version: 1, aliases })
  try {
    fs.chmodSync(aliasesFile(), 0o600)
  } catch {
    /* Windows ignores POSIX modes */
  }
  return { id: cleanId, name: cleanName }
}

export function prefsFile() {
  return path.join(monitorHome(), 'prefs.json')
}

function cleanTags(tags) {
  const arr = Array.isArray(tags)
    ? tags
    : String(tags == null ? '' : tags).split(/[,，\n]/)
  const out = []
  const seen = new Set()
  for (const raw of arr) {
    const t = cleanText(raw, 24)
    if (t === '' || seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 8) break
  }
  return out
}

/** Load per-host UI preferences (`pinned`, `tags`) keyed by target id. */
export function loadHostPrefs() {
  const data = readJsonFile(prefsFile())
  const raw = data && typeof data.prefs === 'object' && data.prefs !== null ? data.prefs : {}
  const result = Object.create(null)
  for (const [id, item] of Object.entries(raw)) {
    const cleanId = String(id || '').trim()
    if (cleanId === '' || !item || typeof item !== 'object') continue
    const pinned = Boolean(item.pinned)
    const tags = cleanTags(item.tags)
    const monitorPaused = Boolean(item.monitorPaused)
    if (pinned || monitorPaused || tags.length > 0) result[cleanId] = { pinned, tags, monitorPaused }
  }
  return result
}

/** Update `pinned` and/or `tags` for one host (`local` or `target.id`). */
export function setHostPrefs(id, patch = {}) {
  const cleanId = String(id == null ? '' : id).trim()
  if (cleanId === '' || cleanId.length > 200) throw new Error('无效的服务器标识')
  const all = loadHostPrefs()
  const current = all[cleanId] || { pinned: false, tags: [], monitorPaused: false }
  const next = {
    pinned: patch.pinned !== undefined ? Boolean(patch.pinned) : current.pinned,
    tags: patch.tags !== undefined ? cleanTags(patch.tags) : current.tags,
    monitorPaused: patch.monitorPaused !== undefined ? Boolean(patch.monitorPaused) : current.monitorPaused,
  }
  if (!next.pinned && next.tags.length === 0 && !next.monitorPaused) delete all[cleanId]
  else all[cleanId] = next
  ensurePrivateDir(monitorHome())
  writeJsonFile(prefsFile(), { version: 1, prefs: all })
  try {
    fs.chmodSync(prefsFile(), 0o600)
  } catch {
    /* Windows ignores POSIX modes */
  }
  return { id: cleanId, ...next }
}

/* ── which discovered servers the dashboard shows ─────────────────────────── */

export function selectionFile() {
  return path.join(monitorHome(), 'selection.json')
}

/**
 * `mode: 'all'` shows every discovered server (the historical default).
 * `mode: 'selected'` shows only the keys in `keys`; manually added servers are
 * always shown because the user typed them in explicitly.
 */
export function loadSelection() {
  const data = readJsonFile(selectionFile())
  const mode = data !== undefined && data !== null && data.mode === 'selected' ? 'selected' : 'all'
  const keys = Array.isArray(data?.keys)
    ? [...new Set(data.keys.map((key) => String(key == null ? '' : key).trim()).filter((key) => /^.+:\d+$/.test(key)))].slice(0, 500)
    : []
  return { mode, keys }
}

export function saveSelection(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const mode = source.mode === 'selected' ? 'selected' : 'all'
  const keys = Array.isArray(source.keys)
    ? [...new Set(source.keys.map((key) => String(key == null ? '' : key).trim()).filter((key) => /^.+:\d+$/.test(key)))].slice(0, 500)
    : []
  ensurePrivateDir(monitorHome())
  writeJsonFile(selectionFile(), { version: 1, mode, keys })
  try {
    fs.chmodSync(selectionFile(), 0o600)
  } catch {
    /* Windows ignores POSIX modes */
  }
  return { mode, keys }
}
