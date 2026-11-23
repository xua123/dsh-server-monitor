# dsh-server-monitor

[English](README.md) | [简体中文](README.zh-CN.md)

在 DeepSeek Harness 中查看本机与 SSH 服务器资源，提供全局面板和会话页签两种入口。

## 功能

- **基础资源**：CPU、内存、Swap、磁盘、网络、负载、运行时间、SSH 延迟。
- **异构算力**：NVIDIA GPU / 华为昇腾 NPU / 海光 DCU 的利用率、显存、温度、功耗。
- **进程**：可搜索、排序的进程表；确认后发送 `SIGTERM`，失败可再确认发送 `SIGKILL`。
- **Docker**：镜像和容器列表、启停/重启/删除、批量删除、启动参数、镜像依赖树。
- **两种入口**：全局服务器面板；跟随当前会话工作区的服务器页签。
- **只读采集**：资源采样只执行只读命令，凭据保存在本地。

## 安装

### npm

```bash
dsh plugin --profile desktop add dsh-server-monitor
```

### GitHub

或在 **设置 → 插件 → 安装** 中填入：

```text
https://github.com/xua123/dsh-server-monitor
```

安装后完全退出 DSH（托盘 Quit）再启动。

## 使用

- 点击左侧栏服务器图标打开全局面板；
- 在会话中打开「资源监控」页签查看当前工作区服务器；
- 需要密码认证的服务器可在面板中手动添加。

## 安全

- 不上传遥测或资源数据；
- 手动添加的密码仅保存在本机 `~/.dsh/server-monitor/targets.json`（`0600`）；
- 仓库中不包含服务器地址、凭据、私有主机名或客户数据。

## 限制

- 远程采集面向 Linux，Windows 仅支持本机；
- 暂不支持 `ProxyJump` / `ProxyCommand`；
- NPU/DCU 功耗上限取决于厂商工具。

## License

MIT
