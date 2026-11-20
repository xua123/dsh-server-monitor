# dsh-server-monitor

[English](README.md) | [简体中文](README.zh-CN.md)

A server resource monitor for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It shows local and SSH server usage in the DSH sidebar and in a per-session tab.

![Resource monitor dashboard](docs/preview.png)

## Features

- **Host resources** — CPU, memory, swap, disk mounts, network throughput, load average, uptime and SSH latency.
- **Accelerators** — per-card utilization, memory, temperature and power for NVIDIA GPU, Huawei Ascend NPU and Hygon DCU.
- **Processes** — sortable process table, process search, and confirmed `SIGTERM` termination with a `SIGKILL` fallback.
- **Docker** — image and container lists, start/stop/restart/delete, multi-select deletion with a per-item progress dialog, startup parameters, and an image-to-container dependency tree.
- **Unreachable hosts stay visible** — a failed login becomes a greyscale card you can retry, or fix by entering a password or private key right there.
- **Hide and restore** — hide any server with the eye button in its card; hidden servers are listed under the board and survive restarts.
- **Two scopes** — a global server panel and a session-scoped server tab that follows the current workspace.
- **Read-only collection** — resource samples use read-only commands; credentials stay on the local machine.

## Install

### npm

```bash
dsh plugin --profile desktop add dsh-server-monitor
```

### GitHub

1. Open **Settings → Plugins → Install**.
2. Enter:

```text
https://github.com/xua123/dsh-server-monitor
```

3. Quit DSH completely, then start it again.

### GitHub Release tarball

```text
https://github.com/xua123/dsh-server-monitor/releases/download/v0.2.1/dsh-server-monitor-0.2.1.tgz
```

The URL is pinned to `v0.2.1`, so the asset name can safely contain the version.

Requirements: DSH `>= 0.2.1-rc.1`, Node `>= 20`.

## Usage

### Global panel

Click the server icon in the left sidebar. The panel lists:

- the local machine;
- hosts discovered from `~/.ssh/config`;
- hosts added manually in the panel.

It supports search, tag filters, card/list views, and sorting by remaining accelerator memory, CPU, memory or average utilization.

### Session tab

Open the **资源监控** tab in a conversation. The tab reads the session workspace and shows the matching server only. If no server can be matched, choose one from the selector in the tab header.

### Unreachable servers

Hosts that fail to connect are shown as greyscale offline cards rather than disappearing.

- **重连 / Reconnect** drops the pooled SSH connection and collects the host again.
- **设置凭据 / 编辑凭据 / Set credentials** opens a dialog with the address, port, username and credentials prefilled. The address and port are editable, and the dialog accepts either a password or a private key (pasted key, key file or key path, with an optional passphrase).
- For a host discovered from `~/.ssh/config`, saving stores a manual credential set that overrides the config entry for that address; delete the manual entry later to fall back to `~/.ssh/config`.
- A successful save closes the dialog, flashes the matching card and shows a green confirmation banner for a few seconds. A failed connection keeps the dialog open with the real SSH error so the credentials can be corrected.

Set `hideAuthFailures: true` in the plugin configuration if you prefer authentication failures to be folded into one footer line instead of grey cards.

### Hiding and restoring servers

Click the eye button in the top-right corner of a card to hide that host. Hidden hosts are listed in **已隐藏的服务器 / Hidden servers** at the bottom of the board:

- **恢复 / Restore** brings one host back;
- **全部恢复 / Restore all** brings every hidden host back.

The hidden list lives in `~/.dsh/server-monitor/hidden.json`, so it survives page reloads, plugin reloads and DSH restarts.

## Resource coverage

| Area | Data |
| --- | --- |
| CPU | usage, cores, model, 1/5/15-minute load |
| Memory | used/total, percentage, swap |
| Disk | root and mounted filesystems, used/total, busiest mount |
| Network | receive/transmit rate |
| System | hostname, OS, kernel, uptime, SSH latency |
| GPU | utilization, memory, temperature, power, compute capability |
| NPU | AICore utilization, memory, temperature, power; Ascend 310P/910B compatible |
| DCU | utilization, VRAM, temperature, power; `hy-smi` JSON/table compatible |
| Containers | CPU/memory limits when running inside a container |

### Process details

![Process details](docs/preview-processes.png)

### Accelerator memory

![Accelerator memory details](docs/preview-memory.png)

## Process and Docker operations

Process termination and Docker mutations require the page token and a confirmation dialog.

- A process can only be terminated if its PID is present in the current detail view.
- `SIGTERM` is sent first; if the process remains, a separate **强制杀死（SIGKILL）** action is offered.
- Container start, stop, restart and delete are confirmed.
- Image deletion reports the containers that still reference the image.
- Running containers must be stopped before they can be deleted.
- Multi-select deletion lists every selected image/container, runs the deletions one by one, and reports per-item status and errors (including the containers that block an image).

### Container details

![Container details](docs/preview-docker.png)

## What's new in 0.2.1

- An SSH authentication failure no longer kills the DSH host process; a dead SSH agent is no longer offered to the transport.
- Failed hosts are listed as greyscale cards with reconnect and credential editing (SSH-config hosts included, address and port editable).
- Servers can be hidden with the eye button and restored from a persistent list under the board.
- Batch image/container deletion shows the target list and per-item progress.
- The **显示范围 / display scope** filter (show all / only selected) was removed; use the eye button to hide individual hosts.

## Security and privacy

- Resource collection uses read-only commands such as `/proc`, `df`, `nvidia-smi`, `npu-smi` and `hy-smi`.
- The plugin does not upload telemetry or resource data.
- Manually added passwords are stored locally in `~/.dsh/server-monitor/targets.json` with mode `0600`; use SSH keys where possible.
- Hidden hosts, aliases and per-host preferences are stored locally under `~/.dsh/server-monitor/`.
- The repository contains no server addresses, credentials, private hostnames or customer data.

## Limitations

- Remote collection targets Linux; Windows is supported for the local host only.
- `ProxyJump` / `ProxyCommand` are not supported yet.
- DCGM exporter or Prometheus is not required.
- NPU/DCU power limits depend on the vendor tool; only actual power is shown when no limit is available.
- Session scoping depends on DSH session `cwd` metadata; use the manual selector when it cannot be resolved.

## Development

```bash
npm install
npm test
npm pack
```

## License

MIT
