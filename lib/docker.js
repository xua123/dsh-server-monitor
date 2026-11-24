/**
 * Docker images and containers for the on-demand details drawer.
 *
 * Everything here is read-only. Mutating actions are executed by the Host
 * endpoint after validating the target against the last collected snapshot.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function splitImages(text) {
  const images = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const fields = line.split('\t')
    if (fields.length < 5) continue
    images.push({
      repository: fields[0] === '<none>' ? '' : fields[0],
      tag: fields[1] === '<none>' ? '' : fields[1],
      id: fields[2],
      shortId: fields[2].replace(/^sha256:/, '').slice(0, 12),
      size: fields[3],
      created: fields[4],
    })
    if (images.length >= 80) break
  }
  return images
}

function splitContainers(text) {
  const containers = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.trim() === '') continue
    const fields = line.split('\t')
    if (fields.length < 5) continue
    containers.push({
      id: fields[0],
      shortId: fields[0].slice(0, 12),
      name: fields[1],
      image: fields[2],
      status: fields[3],
      ports: fields[4] === '<no value>' ? '' : fields[4],
      networks: fields[5] === '<no value>' ? '' : (fields[5] || ''),
    })
    if (containers.length >= 80) break
  }
  return containers
}

/**
 * Parse the `DOCKER` section emitted by REMOTE_DETAILS_SCRIPT.
 * Markers start with `::` so they cannot collide with the `@@` section labels.
 */
export function parseDockerSection(text) {
  const result = { available: false, images: [], running: [], stopped: [] }
  let phase = 'images'
  let lines = []
  const finish = () => {
    if (phase === 'images') result.images = splitImages(lines.join('\n'))
    else if (phase === 'running') result.running = splitContainers(lines.join('\n'))
    else result.stopped = splitContainers(lines.join('\n'))
    lines = []
  }
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '')
    const marker = line.trim()
    if (marker === 'OK') {
      result.available = true
      continue
    }
    if (marker === '::IMAGES_END') {
      finish()
      phase = 'running'
      continue
    }
    if (marker === '::RUNNING_END') {
      finish()
      phase = 'stopped'
      continue
    }
    if (result.available) lines.push(line)
  }
  finish()
  const byRef = new Map()
  for (const image of result.images) {
    if (image.repository === '') continue
    byRef.set(`${image.repository}:${image.tag}`.toLowerCase(), image.id)
    byRef.set(image.repository.toLowerCase(), image.id)
  }
  for (const container of [...result.running, ...result.stopped]) {
    const ref = String(container.image || '').toLowerCase()
    const normalized = ref.replace(/^sha256:/, '')
    const byId = normalized === ''
      ? undefined
      : result.images.find((image) => (
        image.id && (normalized.startsWith(image.id) || image.id.startsWith(normalized))
      ))
    container.imageId = byRef.get(ref) || (byId && byId.id) || (ref.startsWith('sha256:') ? ref : '')
  }
  return result
}

const EMPTY_DOCKER = { available: false, images: [], running: [], stopped: [] }

/** Read images and containers on the local machine (best effort). */
export async function collectLocalDocker() {
  try {
    await execFileAsync('docker', ['info'], { timeout: 5000, windowsHide: true })
  } catch {
    return { ...EMPTY_DOCKER }
  }
  const imageFormat = '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}\t{{.CreatedSince}}'
  const containerFormat = '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}\t{{.Networks}}'
  const run = async (args) => {
    try {
      const { stdout } = await execFileAsync('docker', args, { timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 })
      return stdout
    } catch {
      return ''
    }
  }
  const [images, running, stopped] = await Promise.all([
    run(['images', '--format', imageFormat]),
    run(['ps', '--format', containerFormat]),
    run(['ps', '-a', '--filter', 'status=exited', '--filter', 'status=created', '--filter', 'status=dead', '--format', containerFormat]),
  ])
  return {
    available: true,
    images: splitImages(images),
    running: splitContainers(running),
    stopped: splitContainers(stopped),
  }
}

/** Validate a Docker id/name before it is interpolated into a shell command. */
export function isSafeDockerRef(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value)
}

function inspectPorts(ports) {
  const out = []
  for (const [containerPort, bindings] of Object.entries(ports || {})) {
    if (!Array.isArray(bindings) || bindings.length === 0) {
      out.push(containerPort)
      continue
    }
    for (const binding of bindings) {
      const host = binding.HostIp && binding.HostIp !== '0.0.0.0' ? binding.HostIp : ''
      out.push(`${host ? host + ':' : ''}${binding.HostPort || ''}->${containerPort}`)
    }
  }
  return out
}

function maskEnv(list) {
  return (Array.isArray(list) ? list : []).slice(0, 60).map((entry) => {
    const text = String(entry)
    const index = text.indexOf('=')
    if (index < 0) return text
    const key = text.slice(0, index)
    const value = text.slice(index + 1)
    if (/pass(word)?|secret|token|api[_-]?key|credential|auth/i.test(key)) return `${key}=***`
    return `${key}=${value}`
  })
}

/** Convert `docker inspect` JSON into a small, secret-free summary. */
export function summarizeDockerInspect(raw) {
  const parsed = JSON.parse(String(raw || ''))
  const info = Array.isArray(parsed) ? parsed[0] : parsed
  if (info === null || typeof info !== 'object') throw new Error('Docker inspect 返回为空')
  const state = info.State || {}
  const config = info.Config || {}
  const host = info.HostConfig || {}
  const settings = info.NetworkSettings || {}
  return {
    id: String(info.Id || ''),
    shortId: String(info.Id || '').slice(0, 12),
    name: String(info.Name || '').replace(/^\//, ''),
    image: String(config.Image || info.Image || ''),
    command: [info.Path, ...(info.Args || [])].filter(Boolean).join(' '),
    entrypoint: Array.isArray(config.Entrypoint) ? config.Entrypoint.map(String) : [],
    cmd: Array.isArray(config.Cmd) ? config.Cmd.map(String) : [],
    env: maskEnv(config.Env),
    user: String(config.User || ''),
    workingDir: String(config.WorkingDir || ''),
    privileged: host.Privileged === true,
    capAdd: Array.isArray(host.CapAdd) ? host.CapAdd.map(String) : [],
    devices: (host.Devices || []).map((device) => `${device.PathOnHost || ''}:${device.PathInContainer || ''}`),
    runtime: String(host.Runtime || ''),
    memory: host.Memory === undefined ? null : Number(host.Memory),
    nanoCpus: host.NanoCpus === undefined ? null : Number(host.NanoCpus),
    created: String(info.Created || ''),
    status: String(state.Status || ''),
    running: state.Running === true,
    exitCode: state.ExitCode === undefined ? null : Number(state.ExitCode),
    startedAt: String(state.StartedAt || ''),
    finishedAt: String(state.FinishedAt || ''),
    restartPolicy: String((host.RestartPolicy && host.RestartPolicy.Name) || ''),
    networkMode: String(host.NetworkMode || ''),
    networks: Object.entries(settings.Networks || {}).map(([name, value]) => ({
      name,
      ip: String(value.IPAddress || ''),
      gateway: String(value.Gateway || ''),
    })),
    ports: inspectPorts(settings.Ports),
    mounts: (info.Mounts || []).map((mount) => ({
      type: String(mount.Type || ''),
      source: String(mount.Source || ''),
      destination: String(mount.Destination || ''),
      readOnly: mount.RW === false,
    })),
  }
}

/** Run one local docker command and return its exit status instead of throwing. */
export async function runLocalDocker(args) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return {
      code: Number(error && error.code) || 1,
      stdout: String((error && error.stdout) || ''),
      stderr: String((error && error.stderr) || (error && error.message) || ''),
    }
  }
}
