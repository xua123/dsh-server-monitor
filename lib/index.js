/**
 * dsh-server-monitor — host half.
 *
 * Owns three things:
 *   1. the SSH pool and the two collectors (local / remote),
 *   2. a short-lived snapshot cache so a burst of browser polls does not fan out
 *      into a burst of SSH commands,
 *   3. the small HTTP surface the browser half (and a plain browser tab) uses:
 *        GET  /dsh-server-monitor/api/snapshot[?force=1]
 *        GET  /dsh-server-monitor/api/targets
 *        POST /dsh-server-monitor/api/targets
 *        DEL  /dsh-server-monitor/api/targets/<id>
 *        GET  /dsh-server-monitor/            → the standalone dashboard page
 *
 * The route deliberately lives outside `/plugins` (owned by dsh-client-modules)
 * and `/api` (owned by the API gateway) so it cannot shadow the plugin's own
 * client bundle.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectLocal, collectLocalDetails } from './collect-local.js'
import { collectRemote, collectRemoteDetails } from './collect-remote.js'
import { isSafeDockerRef, runLocalDocker, summarizeDockerInspect } from './docker.js'
import { loadTargets, mergeTargets, resolveWorkspacePath, resolveWorkspaceSession, toPublicTarget } from './machines.js'
import {
  addManualTarget,
  buildTransientTarget,
  deleteManualTarget,
  hiddenTargetKey,
  hideTarget,
  loadHiddenTargets,
  loadHostPrefs,
  loadManualTargets,
  loadSelection,
  loadTargetAliases,
  publicManualTarget,
  saveSelection,
  setHostPrefs,
  setTargetAlias,
  toSshTarget,
  unhideTarget,
  updateManualTarget,
} from './manual-targets.js'
import { SshPool, friendlyError } from './ssh.js'
import { createLimiter, dshHome, sleep, targetKey } from './util.js'

export const name = 'dsh-server-monitor'

const PREFIX = '/dsh-server-monitor'

/** Plugin defaults. Override any field from the profile's cordis config. */
const DEFAULTS = {
  /** Suggested browser refresh interval. */
  refreshMs: 60000,
  /** How long one collected snapshot is reused for non-forced requests. */
  cacheMs: 2500,
  /** Retry delay after a failed host, so an offline box is not dialed every poll. */
  errorCacheMs: 15000,
  includeSshConfig: true,
  sshConfigFile: '',
  ignoreHosts: [],
  maxConcurrent: 6,
  commandTimeoutMs: 12000,
  connectTimeoutMs: 8000,
  idleCloseMs: 120000,
  hostKeyPolicy: 'tofu',
  showLocal: true,
  /** Hide hosts whose login failed, so the dashboard only shows useful cards. */
  hideAuthFailures: true,
  /** How long one browser request waits before returning "collecting" cards. */
  waitMs: 800,
}

function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
  config.refreshMs = Math.max(1000, Number(config.refreshMs) || DEFAULTS.refreshMs)
  config.cacheMs = Math.max(500, Number(config.cacheMs) || DEFAULTS.cacheMs)
  config.errorCacheMs = Math.max(1000, Number(config.errorCacheMs) || DEFAULTS.errorCacheMs)
  config.maxConcurrent = Math.max(1, Math.min(16, Number(config.maxConcurrent) || DEFAULTS.maxConcurrent))
  config.commandTimeoutMs = Math.max(2000, Number(config.commandTimeoutMs) || DEFAULTS.commandTimeoutMs)
  config.connectTimeoutMs = Math.max(2000, Number(config.connectTimeoutMs) || DEFAULTS.connectTimeoutMs)
  config.idleCloseMs = Math.max(10000, Number(config.idleCloseMs) || DEFAULTS.idleCloseMs)
  config.waitMs = Math.max(500, Math.min(15000, Number(config.waitMs) || DEFAULTS.waitMs))
  config.showLocal = config.showLocal !== false
  config.hideAuthFailures = config.hideAuthFailures !== false
  config.includeSshConfig = config.includeSshConfig !== false
  config.ignoreHosts = Array.isArray(config.ignoreHosts) ? config.ignoreHosts : []
  return config
}

function loadDashboardHtml() {
  try {
    return fs.readFileSync(new URL('../assets/dashboard.html', import.meta.url), 'utf8')
  } catch (error) {
    return `<!doctype html><meta charset="utf-8"><title>资源监控</title>
<body style="font:14px/1.6 system-ui;padding:24px;background:#12151c;color:#e8ecf5">
<h1>资源监控</h1><p>仪表盘页面缺失：${String(error && error.message)}</p></body>`
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
    'x-content-type-options': 'nosniff',
  })
  res.end(html)
}

/**
 * Merge one collector result with its target into the public card shape.
 * Nothing credential-shaped is ever copied here.
 */
function remoteView(target, record) {
  const data = record.data !== null && typeof record.data === 'object' ? record.data : {}
  return {
    ...toPublicTarget(target),
    status: record.error === null ? 'online' : 'offline',
    stale: record.error !== null && record.data !== null,
    error: record.error === null ? null : { code: record.error.code, message: record.error.message },
    lastSuccessAt: record.lastSuccessAt || null,
    hostname: data.hostname || '',
    osName: data.osName || '',
    kernel: data.kernel || '',
    platform: data.platform || 'linux',
    cpu: data.cpu || { usage: null, cores: null, model: '' },
    memory: data.memory || { total: null, used: null, percent: null },
    swap: data.swap || null,
    gpus: Array.isArray(data.gpus) ? data.gpus : [],
    disk: data.disk || { percent: null, mounts: [] },
    load: data.load || null,
    network: data.network || null,
    container: data.container || null,
    processes: data.processes || null,
    uptime: data.uptime ?? null,
    latencyMs: data.latencyMs ?? null,
    sampledAt: data.sampledAt || null,
  }
}

function localView(data, error) {
  if (data === null || data === undefined) {
    return {
      id: 'local',
      kind: 'local',
      source: 'local',
      name: '本机',
      host: '',
      status: 'offline',
      stale: false,
      error: { code: 'INTERNAL', message: error || '本机指标采集失败' },
      lastSuccessAt: null,
      cpu: { usage: null, cores: null, model: '' },
      memory: { total: null, used: null, percent: null },
      swap: null,
      gpus: [],
      disk: { percent: null, mounts: [] },
      load: null,
      uptime: null,
      latencyMs: 0,
      sampledAt: null,
    }
  }
  return {
    id: 'local',
    kind: 'local',
    source: 'local',
    name: data.hostname || '本机',
    host: data.hostname || '',
    status: 'online',
    stale: false,
    error: null,
    lastSuccessAt: data.sampledAt || Date.now(),
    ...data,
  }
}

/**
 * A card for a host whose first collection has not finished yet.
 * The browser shows it as "采集中" instead of pretending the host is offline.
 */
function pendingView(target) {
  return {
    ...toPublicTarget(target),
    status: 'connecting',
    stale: false,
    error: null,
    lastSuccessAt: null,
    hostname: '',
    osName: '',
    kernel: '',
    platform: 'linux',
    cpu: { usage: null, cores: null, model: '' },
    memory: { total: null, used: null, percent: null },
    swap: null,
    gpus: [],
    disk: { percent: null, mounts: [] },
    load: null,
    processes: null,
    uptime: null,
    latencyMs: null,
    sampledAt: null,
  }
}

function pausedView(target) {
  return {
    ...pendingView(target),
    status: 'paused',
    paused: true,
  }
}

/**
 * Collect one host at most once at a time, reusing a fresh cached record.
 *
 * @param {object} target
 * @param {object} config
 * @param {object} state
 * @param {boolean} force
 */
async function collectTarget(target, config, state, force) {
  const key = targetKey(target)
  const cached = state.metrics.get(key)
  const age = cached === undefined ? Number.POSITIVE_INFINITY : Date.now() - cached.at
  const ttl = cached !== undefined && cached.error !== null ? config.errorCacheMs : config.cacheMs
  if (!force && cached !== undefined && age < ttl) return remoteView(target, cached)

  const running = state.inflight.get(key)
  if (running !== undefined) return running

  const task = (async () => {
    try {
      const data = await collectRemote(state.pool, target, { timeoutMs: config.commandTimeoutMs })
      if (data.network && cached && cached.data && cached.data.network && cached.data.sampledAt) {
        const dt = (data.sampledAt - cached.data.sampledAt) / 1000
        if (dt > 0 && data.network.rxBytes >= cached.data.network.rxBytes && data.network.txBytes >= cached.data.network.txBytes) {
          data.network.rxBps = Math.round((data.network.rxBytes - cached.data.network.rxBytes) / dt)
          data.network.txBps = Math.round((data.network.txBytes - cached.data.network.txBytes) / dt)
        }
      }
      const record = {
        at: Date.now(),
        data,
        error: null,
        lastSuccessAt: data.sampledAt || Date.now(),
      }
      state.metrics.set(key, record)
      return remoteView(target, record)
    } catch (error) {
      const message = friendlyError(error)
      const code = (error && error.code) || 'INTERNAL'
      const record = {
        at: Date.now(),
        // Keep the last good sample so a briefly unreachable host still shows
        // the load it had a moment ago, clearly marked as stale.
        data: cached === undefined ? null : cached.data,
        error: { code, message },
        lastSuccessAt: cached === undefined ? null : cached.lastSuccessAt,
      }
      state.metrics.set(key, record)
      return remoteView(target, record)
    }
  })()
  state.inflight.set(key, task)
  task.finally(() => {
    if (state.inflight.get(key) === task) state.inflight.delete(key)
  })
  return task
}

/** A host that failed authentication is hidden from the dashboard by default. */
function isAuthFailure(entry) {
  return entry.status === 'offline'
    && entry.error !== null
    && entry.error !== undefined
    && (entry.error.code === 'AUTH' || entry.error.code === 'NO_CREDENTIALS')
}

/**
 * Build one snapshot. Remote hosts are collected through a concurrency-limited
 * pool; per-host failures become card-level errors and never reject the whole
 * snapshot.
 */
async function buildSnapshot(config, state, { force = false, onlyHost = '' } = {}) {
  const loaded = loadTargets(config)
  const manualTargets = loadManualTargets().map(toSshTarget)
  const hidden = new Set(loadHiddenTargets().map((entry) => entry.key))
  const merged = mergeTargets(loaded.targets, manualTargets)
  const selection = loadSelection()
  let afterHidden = merged
  let targets = merged
  if (onlyHost !== '') {
    // Workspace tab: show exactly the bound server, even if it is hidden,
    // filtered out by the selection whitelist, or failing authentication.
    const wanted = String(onlyHost).toLowerCase()
    targets = merged.filter((target) => (
      String(target.id || '').toLowerCase() === wanted
      || String(target.host || '').toLowerCase() === wanted
      || String(target.name || '').toLowerCase() === wanted
    ))
  } else {
    afterHidden = hidden.size === 0
      ? merged
      : merged.filter((target) => !hidden.has(hiddenTargetKey(target.host, target.port)))
    // Discovered servers are opt-in when the user chose "only selected"; servers
    // added by hand are always visible because they were explicit.
    const selected = new Set(selection.keys)
    targets = selection.mode === 'selected'
      ? afterHidden.filter((target) => target.manualId !== undefined || selected.has(hiddenTargetKey(target.host, target.port)))
      : afterHidden
  }
  const limiter = createLimiter(config.maxConcurrent)
  const startedAt = Date.now()
  const prefs = loadHostPrefs()
  const pausedIds = new Set(Object.entries(prefs).filter(([, item]) => item.monitorPaused).map(([id]) => id))
  const activeTargets = targets.filter((target) => !pausedIds.has(target.id))

  const localTask = (async () => {
    if (!config.showLocal) return null
    try {
      return localView(await collectLocal(), null)
    } catch (error) {
      return localView(null, friendlyError(error))
    }
  })()

  const remoteTasks = activeTargets.map((target) => limiter(() => collectTarget(target, config, state, force)))

  // Don't let one dead host hold the whole dashboard hostage: wait a short
  // while, then answer with cards for what we have. Collection continues in the
  // background and the next poll picks the results up (per-target in-flight
  // promises prevent a second SSH attempt for the same host).
  const local = onlyHost !== '' && onlyHost.toLowerCase() !== 'local' ? null : await localTask
  const aliases = loadTargetAliases()
  if (local !== null) {
    if (aliases.local) {
      local.defaultName = local.name
      local.name = aliases.local
    }
    const localPref = prefs.local || {}
    local.pinned = Boolean(localPref.pinned)
    local.tags = Array.isArray(localPref.tags) ? localPref.tags : []
    local.paused = Boolean(localPref.monitorPaused)
    if (local.paused) local.status = 'paused'
  }
  const raced = await Promise.race([
    Promise.all(remoteTasks),
    sleep(config.waitMs).then(() => null),
  ])
  const collected = targets.map((target) => {
    if (pausedIds.has(target.id)) return pausedView(target)
    if (raced !== null) return raced.find((entry) => entry.id === target.id) || pendingView(target)
    const key = targetKey(target)
    const cached = state.metrics.get(key)
    return cached === undefined ? pendingView(target) : remoteView(target, cached)
  })
  collected.forEach((entry) => {
    if (aliases[entry.id]) {
      entry.defaultName = entry.name
      entry.name = aliases[entry.id]
    }
    const pref = prefs[entry.id] || {}
    entry.pinned = Boolean(pref.pinned)
    entry.tags = Array.isArray(pref.tags) ? pref.tags : []
    entry.paused = Boolean(pref.monitorPaused)
  })
  const allRemotes = collected.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
  const hiddenAuth = onlyHost !== ''
    ? []
    : (config.hideAuthFailures ? allRemotes.filter(isAuthFailure) : [])
  const remoteList = hiddenAuth.length > 0
    ? allRemotes.filter((entry) => !hiddenAuth.includes(entry))
    : allRemotes
  const online = remoteList.filter((entry) => entry.status === 'online').length + (local && local.status === 'online' ? 1 : 0)
  const collecting = remoteList.filter((entry) => entry.status === 'connecting').length
  const total = remoteList.length + (local === null ? 0 : 1)

  return {
    ok: true,
    generatedAt: Date.now(),
    tookMs: Date.now() - startedAt,
    refreshMs: config.refreshMs,
    cacheMs: config.cacheMs,
    local,
    remotes: remoteList,
    summary: {
      total,
      online,
      offline: total - online - collecting,
      collecting,
      hiddenAuth: hiddenAuth.length,
      hiddenRemoved: onlyHost !== '' ? 0 : merged.length - afterHidden.length,
      selectionMode: selection.mode,
      selectedCount: selection.keys.length,
    },
    sources: {
      sshConfig: loaded.sources.sshConfig,
      manual: manualTargets.length,
      hidden: hidden.size,
      selectionMode: selection.mode,
      visible: targets.length,
      sshConfigFile: loaded.sources.sshConfigFile,
    },
    home: dshHome(),
  }
}

/**
 * Build the runtime pieces without a Cordis context.
 *
 * Exported so the bundled dev server (`scripts/dev-server.mjs`) and tests use
 * exactly the same collectors, cache and SSH pool as the plugin itself.
 *
 * @param {object} [rawConfig]
 */
export function createMonitor(rawConfig) {
  const config = normalizeConfig(rawConfig)
  const state = {
    config,
    pool: new SshPool({
      idleCloseMs: config.idleCloseMs,
      connectTimeoutMs: config.connectTimeoutMs,
      hostKeyPolicy: config.hostKeyPolicy,
      log: (message) => {
        try {
          console.warn(`[dsh-server-monitor] ${message}`)
        } catch {
          /* logging must never break collection */
        }
      },
    }),
    metrics: new Map(),
    inflight: new Map(),
    hostCache: new Map(),
    detailsCache: new Map(),
    detailsInflight: new Map(),
    cache: { at: 0, data: null, inflight: null },
    /** Guards POST/DELETE; injected into the dashboard page only. */
    token: crypto.randomBytes(24).toString('hex'),
  }

  /** Build once at a time; refresh in the background while stale data is shown. */
  const startBuild = (force) => {
    if (state.cache.inflight !== null) return state.cache.inflight
    let task
    task = buildSnapshot(config, state, { force })
      .then((value) => {
        state.cache.data = value
        state.cache.at = Date.now()
        return value
      })
      .finally(() => {
        if (state.cache.inflight === task) state.cache.inflight = null
      })
    state.cache.inflight = task
    return task
  }

  /**
   * Stale-while-revalidate. A dashboard poll gets the previous snapshot
   * immediately and a background build refreshes it, so a slow `npu-smi` /
   * `hy-smi` host never blocks the page for seconds.
   */
  const snapshot = async ({ force = false, onlyHost = '' } = {}) => {
    if (onlyHost !== '') {
      const key = String(onlyHost).toLowerCase()
      const cached = state.hostCache.get(key)
      if (cached !== undefined && !force && Date.now() - cached.at < config.cacheMs) {
        return { ...cached.data, stale: false, ageMs: 0 }
      }
      const value = await buildSnapshot(config, state, { force, onlyHost })
      state.hostCache.set(key, { at: Date.now(), data: value })
      return { ...value, stale: false, ageMs: 0 }
    }
    const now = Date.now()
    if (state.cache.data !== null && !force) {
      const age = now - state.cache.at
      if (age >= config.cacheMs) void startBuild(false).catch(() => {})
      return { ...state.cache.data, stale: age >= config.cacheMs, ageMs: age }
    }
    const fresh = await (state.cache.inflight !== null ? state.cache.inflight : startBuild(force))
    return { ...fresh, stale: false, ageMs: 0 }
  }

  /** On-demand process & accelerator process details for one host (`local` or target.id). */
  const hostDetails = async (hostId, { force = false } = {}) => {
    const id = String(hostId || '').trim()
    if (id === '') throw Object.assign(new Error('缺少主机 ID'), { statusCode: 400 })
    if (loadHostPrefs()[id] && loadHostPrefs()[id].monitorPaused) {
      return { ok: true, hostId: id, paused: true, processes: [], accelerators: [], acceleratorProcesses: [], docker: null }
    }
    const now = Date.now()
    const cached = state.detailsCache.get(id)
    if (!force && cached !== undefined && now - cached.at < 1500) {
      return cached.data
    }
    const running = state.detailsInflight.get(id)
    if (running !== undefined) return running

    const task = (async () => {
      let data
      if (id === 'local') {
        if (!config.showLocal) throw Object.assign(new Error('本机监控已禁用'), { statusCode: 404 })
        data = await collectLocalDetails()
      } else {
        const loaded = loadTargets(config)
        const manualTargets = loadManualTargets().map(toSshTarget)
        const merged = mergeTargets(loaded.targets, manualTargets)
        const target = merged.find((item) => item.id === id)
        if (!target) throw Object.assign(new Error('找不到对应服务器'), { statusCode: 404 })
        data = await collectRemoteDetails(state.pool, target, { timeoutMs: config.commandTimeoutMs })
      }
      const payload = { ok: true, hostId: id, ...data }
      state.detailsCache.set(id, { at: Date.now(), data: payload })
      return payload
    })()

    state.detailsInflight.set(id, task)
    task.finally(() => {
      if (state.detailsInflight.get(id) === task) state.detailsInflight.delete(id)
    })
    return task
  }

  const killHostProcess = async (hostId, pidInput, signalInput = 'TERM') => {
    const id = String(hostId || '').trim()
    const pid = Number(pidInput)
    const signal = String(signalInput || 'TERM').toUpperCase()
    if (id === '') throw Object.assign(new Error('缺少主机 ID'), { statusCode: 400 })
    if (!Number.isInteger(pid) || pid <= 0) throw Object.assign(new Error('PID 无效'), { statusCode: 400 })
    if (!['TERM', 'KILL', 'INT'].includes(signal)) {
      throw Object.assign(new Error('不支持的信号'), { statusCode: 400 })
    }
    const details = await hostDetails(id)
    const known = [...(details.processes || []), ...(details.acceleratorProcesses || [])]
    if (!known.some((entry) => Number(entry.pid) === pid)) {
      throw Object.assign(new Error('该 PID 不在当前进程列表中，请先刷新详情'), { statusCode: 400 })
    }
    if (id === 'local') {
      try {
        process.kill(pid, `SIG${signal}`)
        await new Promise((resolve) => setTimeout(resolve, 600))
        try {
          process.kill(pid, 0)
        } catch (probe) {
          if (probe && probe.code === 'ESRCH') {
            state.detailsCache.delete(id)
            return { ok: true, pid, signal }
          }
        }
        throw Object.assign(new Error('进程仍在运行：SIGTERM 未生效，可能权限不足或进程处于不可中断状态'), { statusCode: 400 })
      } catch (error) {
        if (error && error.statusCode) throw error
        throw Object.assign(new Error(killErrorMessage(error && error.message)), { statusCode: 400 })
      }
    }
    const loaded = loadTargets(config)
    const manualTargets = loadManualTargets().map(toSshTarget)
    const target = mergeTargets(loaded.targets, manualTargets).find((item) => item.id === id)
    if (!target) throw Object.assign(new Error('找不到对应服务器'), { statusCode: 404 })
    try {
      const result = await state.pool.exec(
        target,
        `kill -${signal} ${pid} 2>&1; rc=$?; sleep 1; if kill -0 ${pid} 2>/dev/null; then echo "__ALIVE"; exit 42; fi; exit $rc`,
        { timeoutMs: 6000 },
      )
      const exitMatch = String(result.stdout || '').match(/__EXIT:(\d+)/)
      const code = exitMatch === null ? result.code : Number(exitMatch[1])
      if (code === 0) {
        state.detailsCache.delete(id)
        return { ok: true, pid, signal }
      }
      if (String(result.stdout || '').includes('__ALIVE')) {
        throw Object.assign(new Error('进程仍在运行：SIGTERM 未生效，可能权限不足、被容器自动重启或进程处于不可中断状态'), { statusCode: 400 })
      }
      const raw = String(result.stderr || result.stdout || '')
        .replace(/__EXIT:\d+/g, '')
        .replace(/__ALIVE/g, '')
        .trim()
      throw Object.assign(new Error(killErrorMessage(raw)), { statusCode: 400 })
    } catch (error) {
      if (error && error.statusCode) throw error
      throw Object.assign(new Error(killErrorMessage(error && error.message)), { statusCode: 500 })
    }
  }

  const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
  const runDockerCommand = async (hostId, args) => {
    if (hostId === 'local') return runLocalDocker(args)
    const loaded = loadTargets(config)
    const manualTargets = loadManualTargets().map(toSshTarget)
    const target = mergeTargets(loaded.targets, manualTargets).find((item) => item.id === hostId)
    if (!target) throw Object.assign(new Error('找不到对应服务器'), { statusCode: 404 })
    const result = await state.pool.exec(
      target,
      `docker ${args.map(shellQuote).join(' ')} 2>&1; echo "__EXIT:$?"`,
      { timeoutMs: 30000 },
    )
    const match = String(result.stdout || '').match(/__EXIT:(\d+)/)
    return {
      code: match === null ? result.code : Number(match[1]),
      stdout: String(result.stdout || '').replace(/__EXIT:\d+/g, '').trim(),
      stderr: String(result.stderr || ''),
    }
  }
  const findImageBlockers = async (hostId, imageId) => {
    try {
      const result = await runDockerCommand(hostId, [
        'ps', '-a', '--filter', `ancestor=${imageId}`,
        '--format', '{{.ID}}\t{{.Names}}\t{{.Status}}',
      ])
      if (result.code !== 0) return []
      return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const [id, name, status] = line.split('\t')
        return { id: String(id || ''), name: String(name || ''), status: String(status || '') }
      })
    } catch {
      return []
    }
  }

  const dockerHostAction = async (hostId, actionInput, kindInput, targetRef) => {
    const id = String(hostId || '').trim()
    const action = String(actionInput || '').trim().toLowerCase()
    const kind = String(kindInput || '').trim().toLowerCase()
    if (id === '') throw Object.assign(new Error('缺少主机 ID'), { statusCode: 400 })
    if (kind === 'image' && action !== 'rmi') throw Object.assign(new Error('镜像只支持删除'), { statusCode: 400 })
    if (kind === 'container' && !['start', 'stop', 'restart', 'rm'].includes(action)) {
      throw Object.assign(new Error('容器只支持启动、停止、重启、删除'), { statusCode: 400 })
    }
    if (kind !== 'image' && kind !== 'container') throw Object.assign(new Error('类型无效'), { statusCode: 400 })
    const details = await hostDetails(id)
    const docker = details.docker || {}
    let resolved = ''
    if (kind === 'image') {
      const image = (docker.images || []).find((entry) => (
        entry.id === targetRef || entry.shortId === targetRef || `${entry.repository}:${entry.tag}` === targetRef
      ))
      if (image === undefined) throw Object.assign(new Error('镜像不在当前列表中，请先刷新详情'), { statusCode: 400 })
      resolved = image.id
    } else {
      const container = [...(docker.running || []), ...(docker.stopped || [])].find((entry) => (
        entry.id === targetRef || entry.shortId === targetRef || entry.name === targetRef
      ))
      if (container === undefined) throw Object.assign(new Error('容器不在当前列表中，请先刷新详情'), { statusCode: 400 })
      resolved = container.id
    }
    if (!isSafeDockerRef(resolved)) throw Object.assign(new Error('Docker ID 无效'), { statusCode: 400 })
    const args = kind === 'image' ? ['rmi', resolved] : [action, resolved]
    const success = () => {
      state.detailsCache.delete(id)
      return { ok: true, action, kind }
    }
    if (id === 'local') {
      const result = await runLocalDocker(args)
      if (result.code !== 0) {
        const blockers = kind === 'image' ? await findImageBlockers(id, resolved) : []
        const suffix = blockers.length ? `；仍被容器使用：${blockers.map((item) => item.name).join('、')}` : ''
        throw Object.assign(new Error(dockerErrorMessage(result.stderr || result.stdout) + suffix), {
          statusCode: 400,
          blockingContainers: blockers,
        })
      }
      return success()
    }
    const loaded = loadTargets(config)
    const manualTargets = loadManualTargets().map(toSshTarget)
    const target = mergeTargets(loaded.targets, manualTargets).find((item) => item.id === id)
    if (!target) throw Object.assign(new Error('找不到对应服务器'), { statusCode: 404 })
    const result = await state.pool.exec(
      target,
      `docker ${args.join(' ')} 2>&1; echo "__EXIT:$?"`,
      { timeoutMs: 45000 },
    )
    const exitMatch = String(result.stdout || '').match(/__EXIT:(\d+)/)
    const code = exitMatch === null ? result.code : Number(exitMatch[1])
    if (code !== 0) {
      const raw = String(result.stderr || result.stdout || '').replace(/__EXIT:\d+/g, '').trim()
      const blockers = kind === 'image' ? await findImageBlockers(id, resolved) : []
      const suffix = blockers.length ? `；仍被容器使用：${blockers.map((item) => item.name).join('、')}` : ''
      throw Object.assign(new Error(dockerErrorMessage(raw) + suffix), {
        statusCode: 400,
        blockingContainers: blockers,
      })
    }
    return success()
  }

  const dockerBatchAction = async (hostId, kind, action, targets) => {
    const list = Array.isArray(targets) ? targets.slice(0, 100) : []
    if (list.length === 0) throw Object.assign(new Error('没有选中目标'), { statusCode: 400 })
    const results = []
    for (const target of list) {
      try {
        await dockerHostAction(hostId, action, kind, target)
        results.push({ target, ok: true })
      } catch (error) {
        results.push({
          target,
          ok: false,
          error: String(error && error.message ? error.message : error),
          blockingContainers: Array.isArray(error && error.blockingContainers) ? error.blockingContainers : [],
        })
      }
    }
    return { ok: results.every((item) => item.ok), results }
  }

  const inspectDockerContainer = async (hostId, targetRef) => {
    const id = String(hostId || '').trim()
    if (id === '') throw Object.assign(new Error('缺少主机 ID'), { statusCode: 400 })
    const details = await hostDetails(id)
    const docker = details.docker || {}
    const container = [...(docker.running || []), ...(docker.stopped || [])].find((entry) => (
      entry.id === targetRef || entry.shortId === targetRef || entry.name === targetRef
    ))
    if (container === undefined) {
      throw Object.assign(new Error('容器不在当前列表中，请先刷新详情'), { statusCode: 400 })
    }
    if (!isSafeDockerRef(container.id)) throw Object.assign(new Error('Docker ID 无效'), { statusCode: 400 })
    let text = ''
    if (id === 'local') {
      const result = await runLocalDocker(['inspect', container.id])
      if (result.code !== 0) throw Object.assign(new Error(dockerErrorMessage(result.stderr || result.stdout)), { statusCode: 400 })
      text = result.stdout
    } else {
      const loaded = loadTargets(config)
      const manualTargets = loadManualTargets().map(toSshTarget)
      const target = mergeTargets(loaded.targets, manualTargets).find((item) => item.id === id)
      if (!target) throw Object.assign(new Error('找不到对应服务器'), { statusCode: 404 })
      const result = await state.pool.exec(target, `docker inspect ${container.id} 2>&1`, { timeoutMs: 15000 })
      if (result.code !== 0) throw Object.assign(new Error(dockerErrorMessage(result.stderr || result.stdout)), { statusCode: 400 })
      text = result.stdout
    }
    try {
      return { ok: true, container: summarizeDockerInspect(text) }
    } catch (error) {
      throw Object.assign(new Error(`容器详情解析失败：${error.message}`), { statusCode: 500 })
    }
  }

  return {
    config,
    state,
    snapshot,
    hostDetails,
    killHostProcess,
    dockerHostAction,
    dockerBatchAction,
    inspectDockerContainer,
    close: () => state.pool.closeAll(),
  }
}

function killErrorMessage(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (/operation not permitted|not permitted|permission denied/i.test(text)) {
    return '权限不足：该进程属于其他用户，或需要 root 权限'
  }
  if (/no such process/i.test(text)) return '进程已经退出，或 PID 不存在'
  if (/invalid signal/i.test(text)) return '信号无效'
  if (text === '') return '终止失败：远程命令没有返回原因'
  return `终止失败：${text.split(/\r?\n/)[0]}`
}

function dockerErrorMessage(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (/permission denied|access denied|got permission denied/i.test(text)) {
    return '权限不足：当前用户没有 Docker 权限，请加入 docker 组或使用 root'
  }
  if (/no such container/i.test(text)) return '容器不存在或已被删除'
  if (/no such image/i.test(text)) return '镜像不存在或已被删除'
  if (/container is running|stop the container before removing|you cannot remove a running container/i.test(text)) {
    return '容器正在运行，请先停止再删除'
  }
  if (/conflict|image is being used|container is using/i.test(text)) return '镜像正在被容器使用，请先停止并删除相关容器'
  if (/is not running/i.test(text)) return '容器当前没有运行'
  if (text === '') return 'Docker 操作失败：没有返回原因'
  return `Docker 操作失败：${text.split(/\r?\n/)[0]}`
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function tokenMatches(req, token) {
  const given = String(req.headers['x-monitor-token'] || '')
  if (given.length !== token.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))
  } catch {
    return false
  }
}

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const monitor = createMonitor(rawConfig)
  const { config, state, snapshot: getSnapshot, hostDetails: getHostDetails, killHostProcess, dockerHostAction, dockerBatchAction, inspectDockerContainer } = monitor

  ctx.effect(() => () => {
    monitor.close()
  }, 'dsh-server-monitor: close SSH pool')

  const purgeHiddenServer = (keyInput) => {
    const key = String(keyInput || '').trim()
    const hidden = loadHiddenTargets().find((entry) => entry.key === key)
    if (hidden === undefined) throw Object.assign(new Error('找不到该隐藏记录'), { statusCode: 404 })
    const file = config.sshConfigFile || path.join(os.homedir(), '.ssh', 'config')
    if (!fs.existsSync(file)) {
      throw Object.assign(new Error('SSH 配置文件不存在：' + file), { statusCode: 404 })
    }
    const target = loadTargets(config).targets.find((entry) => (
      String(entry.host || '').toLowerCase() === hidden.host.toLowerCase()
      && (Number(entry.port) || 22) === hidden.port
    ))
    if (target === undefined || !target.alias) {
      throw Object.assign(new Error('SSH 配置中找不到对应 Host，未修改文件'), { statusCode: 404 })
    }
    const raw = fs.readFileSync(file, 'utf8')
    const lines = raw.split(/\r?\n/)
    const out = []
    let skip = false
    let removed = false
    for (const line of lines) {
      const hostMatch = line.match(/^\s*Host\s+(.+)$/i)
      if (hostMatch !== null) {
        skip = false
        const aliases = hostMatch[1].trim().split(/\s+/)
        if (aliases.some((alias) => alias.toLowerCase() === String(target.alias).toLowerCase())) {
          skip = true
          removed = true
          continue
        }
      }
      if (/^\s*Match\s+/i.test(line)) skip = false
      if (!skip) out.push(line)
    }
    if (!removed) {
      throw Object.assign(new Error('SSH 配置中找不到 Host ' + target.alias + '，未修改文件'), { statusCode: 404 })
    }
    const backup = file + '.bak-' + Date.now()
    fs.copyFileSync(file, backup)
    fs.writeFileSync(file, out.join('\n'))
    unhideTarget(key)
    return { file, alias: target.alias, backup }
  }

  const dashboardHtml = loadDashboardHtml()
  const invalidate = () => {
    state.cache.at = 0
    state.cache.data = null
  }

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const method = String(req.method || 'GET').toUpperCase()
          const pathname = url.pathname.replace(/\/+$/, '') || '/'
          const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE'

          if (pathname.startsWith(`${PREFIX}/api/`)) {
            const rejection = webCtx.connection.requestRejection(req)
            if (rejection !== undefined) {
              sendJson(res, rejection, { ok: false, error: rejection === 401 ? '未认证的请求' : '不允许的请求来源' })
              return
            }
          }

          if (isWrite && !tokenMatches(req, state.token)) {
            sendJson(res, 403, { ok: false, error: '无效的写入令牌，请刷新页面后重试' })
            return
          }

          if (pathname === `${PREFIX}/api/resolve-workspace`) {
            if (method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const sessionId = url.searchParams.get('session') || ''
            const workspacePath = url.searchParams.get('path') || ''
            let workspace = null
            try {
              workspace = resolveWorkspaceSession(sessionId)
              if (workspace === null && workspacePath !== '') workspace = resolveWorkspacePath(workspacePath)
            } catch {
              workspace = null
            }
            sendJson(res, 200, { ok: true, workspace })
            return
          }

          if (pathname === `${PREFIX}/api/snapshot`) {
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
            const onlyHost = url.searchParams.get('host') || ''
            const snapshot = await getSnapshot({ force, onlyHost })
            if (method === 'HEAD') {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end()
              return
            }
            sendJson(res, 200, snapshot)
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hosts/`) && pathname.endsWith('/docker/batch')) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawId = pathname.slice(`${PREFIX}/api/hosts/`.length, -'/docker/batch'.length)
            const body = await readJsonBody(req)
            try {
              const result = await dockerBatchAction(
                decodeURIComponent(rawId),
                body.kind,
                body.action,
                body.targets,
              )
              sendJson(res, 200, result)
            } catch (error) {
              sendJson(res, error.statusCode || 400, {
                ok: false,
                error: String(error && error.message ? error.message : error),
                blockingContainers: error.blockingContainers || [],
              })
            }
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hosts/`) && pathname.endsWith('/docker/inspect')) {
            if (method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawId = pathname.slice(`${PREFIX}/api/hosts/`.length, -'/docker/inspect'.length)
            const target = url.searchParams.get('target') || ''
            try {
              sendJson(res, 200, await inspectDockerContainer(decodeURIComponent(rawId), target))
            } catch (error) {
              sendJson(res, error.statusCode || 400, {
                ok: false,
                error: String(error && error.message ? error.message : error),
              })
            }
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hosts/`) && pathname.endsWith('/docker')) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawId = pathname.slice(`${PREFIX}/api/hosts/`.length, -'/docker'.length)
            const body = await readJsonBody(req)
            try {
              const result = await dockerHostAction(
                decodeURIComponent(rawId),
                body.action,
                body.kind,
                body.target,
              )
              sendJson(res, 200, result)
            } catch (error) {
              sendJson(res, error.statusCode || 400, {
                ok: false,
                error: String(error && error.message ? error.message : error),
                blockingContainers: error.blockingContainers || [],
              })
            }
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hosts/`) && pathname.endsWith('/monitor')) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawId = pathname.slice(`${PREFIX}/api/hosts/`.length, -'/monitor'.length)
            const hostId = decodeURIComponent(rawId)
            const body = await readJsonBody(req)
            const pref = setHostPrefs(hostId, { monitorPaused: Boolean(body.paused) })
            state.cache.at = 0
            state.cache.data = null
            state.hostCache.clear()
            state.detailsCache.delete(hostId)
            sendJson(res, 200, { ok: true, id: hostId, paused: pref.monitorPaused })
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hosts/`) && pathname.endsWith('/kill')) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawId = pathname.slice(`${PREFIX}/api/hosts/`.length, -'/kill'.length)
            const body = await readJsonBody(req)
            try {
              const result = await killHostProcess(decodeURIComponent(rawId), body.pid, body.signal || 'TERM')
              sendJson(res, 200, result)
            } catch (error) {
              sendJson(res, error.statusCode || 400, {
                ok: false,
                error: String(error && error.message ? error.message : error),
              })
            }
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hosts/`) && pathname.endsWith('/details')) {
            if (method !== 'GET') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawId = pathname.slice(`${PREFIX}/api/hosts/`.length, -'/details'.length)
            const hostId = decodeURIComponent(rawId)
            const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true'
            const details = await getHostDetails(hostId, { force })
            sendJson(res, 200, details)
            return
          }

          if (pathname === `${PREFIX}/api/selection`) {
            if (method === 'GET' || method === 'HEAD') {
              const selection = loadSelection()
              const hiddenKeys = new Set(loadHiddenTargets().map((entry) => entry.key))
              const discovery = loadTargets(config)
              const manual = loadManualTargets().map(toSshTarget)
              const candidates = mergeTargets(discovery.targets, manual)
                .filter((target) => target.manualId === undefined)
                .filter((target) => !hiddenKeys.has(hiddenTargetKey(target.host, target.port)))
                .map((target) => ({
                  ...toPublicTarget(target),
                  key: hiddenTargetKey(target.host, target.port),
                }))
                .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
              if (method === 'HEAD') {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end()
                return
              }
              sendJson(res, 200, { ok: true, selection, candidates })
              return
            }
            if (method === 'POST') {
              const body = await readJsonBody(req)
              try {
                const selection = saveSelection({ mode: body.mode, keys: body.keys })
                invalidate()
                sendJson(res, 200, { ok: true, selection })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
              }
              return
            }
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }

          if (pathname === `${PREFIX}/api/hidden`) {
            if (method === 'GET' || method === 'HEAD') {
              const targets = loadHiddenTargets()
              if (method === 'HEAD') {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end()
                return
              }
              sendJson(res, 200, { ok: true, targets })
              return
            }
            if (method === 'POST') {
              const body = await readJsonBody(req)
              try {
                const target = hideTarget(body.host, body.port)
                invalidate()
                sendJson(res, 201, { ok: true, target })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
              }
              return
            }
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hidden/`) && pathname.endsWith('/purge')) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const rawKey = pathname.slice(`${PREFIX}/api/hidden/`.length, -'/purge'.length)
            try {
              const result = purgeHiddenServer(decodeURIComponent(rawKey))
              invalidate()
              sendJson(res, 200, { ok: true, ...result })
            } catch (error) {
              sendJson(res, error.statusCode || 400, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/hidden/`)) {
            if (method !== 'DELETE') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const key = decodeURIComponent(pathname.slice(`${PREFIX}/api/hidden/`.length))
            try {
              unhideTarget(key)
              invalidate()
              sendJson(res, 200, { ok: true })
            } catch (error) {
              sendJson(res, 404, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname === `${PREFIX}/api/aliases`) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            try {
              const alias = setTargetAlias(body.id, body.name)
              invalidate()
              sendJson(res, 200, { ok: true, alias })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname === `${PREFIX}/api/prefs`) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            try {
              const pref = setHostPrefs(body.id, { pinned: body.pinned, tags: body.tags })
              invalidate()
              sendJson(res, 200, { ok: true, pref })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname === `${PREFIX}/api/targets/test`) {
            if (method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            const body = await readJsonBody(req)
            try {
              const target = buildTransientTarget(body)
              const snap = await collectRemote(state.pool, target, { timeoutMs: config.commandTimeoutMs })
              sendJson(res, 200, {
                ok: true,
                result: {
                  hostname: snap.hostname,
                  osName: snap.osName,
                  cores: snap.cpu && snap.cpu.cores,
                  latencyMs: snap.latencyMs,
                  gpus: (snap.gpus || []).map((g) => `${String(g.type || 'gpu').toUpperCase()} ${g.name}`),
                },
              })
            } catch (error) {
              sendJson(res, 400, { ok: false, error: friendlyError(error) })
            }
            return
          }

          if (pathname === `${PREFIX}/api/targets`) {
            if (method === 'GET' || method === 'HEAD') {
              const targets = loadManualTargets().map(publicManualTarget)
              if (method === 'HEAD') {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end()
                return
              }
              sendJson(res, 200, { ok: true, targets })
              return
            }
            if (method === 'POST') {
              const body = await readJsonBody(req)
              try {
                const target = addManualTarget(body)
                invalidate()
                sendJson(res, 201, { ok: true, target })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
              }
              return
            }
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }

          if (pathname.startsWith(`${PREFIX}/api/targets/`)) {
            const id = decodeURIComponent(pathname.slice(`${PREFIX}/api/targets/`.length))
            if (method === 'PUT') {
              const body = await readJsonBody(req)
              try {
                const target = updateManualTarget(id, body)
                state.pool.closeAll()
                invalidate()
                sendJson(res, 200, { ok: true, target })
              } catch (error) {
                sendJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) })
              }
              return
            }
            if (method !== 'DELETE') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              deleteManualTarget(id)
              invalidate()
              sendJson(res, 200, { ok: true })
            } catch (error) {
              sendJson(res, 404, { ok: false, error: String(error && error.message ? error.message : error) })
            }
            return
          }

          if (pathname === PREFIX || pathname === `${PREFIX}/index.html`) {
            if (method !== 'GET' && method !== 'HEAD') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (method === 'HEAD') {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
              res.end()
              return
            }
            sendHtml(res, 200, dashboardHtml.replaceAll('__MONITOR_TOKEN__', state.token))
            return
          }

          sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          const status = Number(error && error.statusCode) || 500
          try {
            sendJson(res, status, { ok: false, error: friendlyError(error), code: (error && error.code) || 'INTERNAL' })
          } catch {
            res.destroy()
          }
        }
      },
    }), 'dsh-server-monitor: http routes')
  })

  // Expose a tiny read-only service so a future command or tool can ask for the
  // same snapshot without duplicating the collectors.
  try {
    ctx.provide('serverMonitor', {
      snapshot: (options) => getSnapshot(options),
      invalidate: () => {
        state.cache.at = 0
        state.cache.data = null
        state.metrics.clear()
      },
      config: () => ({ ...config }),
    })
  } catch {
    /* an older Cordis without ctx.provide simply loses the optional service */
  }
}
