#!/usr/bin/env node
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { Bridge, CloudyApi } from './bridge.js'

const home = process.env.CLOUDY_BRIDGE_HOME || join(homedir(), '.config', 'cloudy')
const configPath = join(home, 'bridge.json')

async function load() { return JSON.parse(await readFile(configPath, 'utf8')) }
async function save(config) {
  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(configPath, 0o600)
}

async function pair(apiUrl) {
  const api = new CloudyApi(apiUrl)
  const result = await api.request('POST', '/v1/codex/bridge/pairing-sessions')
  process.stdout.write(`Enter ${result.pairing_code} on the Cloudy Codex page.\n`)
  api.token = result.bridge_token
  while (true) {
    const { status } = await api.request('GET', `/v1/codex/bridge/pairing-sessions/${result.session_id}`)
    if (status === 'paired') break
    if (status === 'revoked') throw new Error('Bridge pairing was revoked')
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  await save({ apiUrl, token: result.bridge_token, workspaces: [], threads: [] })
  process.stdout.write('Cloudy bridge paired. Add a workspace next.\n')
}

async function addWorkspace(value) {
  const config = await load()
  const path = await realpath(value)
  if (!config.workspaces.some((workspace) => workspace.path === path)) config.workspaces.push({ id: randomUUID(), label: basename(path), path })
  await save(config)
  process.stdout.write(`Added ${path}\n`)
}

async function removeWorkspace(value) {
  const config = await load()
  const path = await realpath(value)
  config.workspaces = config.workspaces.filter((workspace) => workspace.path !== path)
  const retained = new Set(config.workspaces.map((workspace) => workspace.id))
  config.threads = (config.threads || []).filter((thread) => retained.has(thread.workspaceId))
  await save(config)
}

async function install() {
  const node = process.execPath
  const cli = await realpath(fileURLToPath(import.meta.url))
  if (platform() === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', 'com.cloudy.codex-bridge.plist')
    const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.cloudy.codex-bridge</string><key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>${escapeXml(cli)}</string><string>run</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, xml)
    spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { stdio: 'inherit' })
  } else if (platform() === 'linux') {
    const file = join(homedir(), '.config', 'systemd', 'user', 'cloudy-codex-bridge.service')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `[Unit]\nDescription=Cloudy Codex Bridge\n[Service]\nExecStart=${JSON.stringify(node)} ${JSON.stringify(cli)} run\nRestart=always\n[Install]\nWantedBy=default.target\n`)
    spawnSync('systemctl', ['--user', 'enable', '--now', 'cloudy-codex-bridge.service'], { stdio: 'inherit' })
  } else throw new Error('Background service installation supports macOS and Linux')
}

async function uninstall() {
  if (platform() === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', 'com.cloudy.codex-bridge.plist')
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, file], { stdio: 'inherit' }); await rm(file, { force: true })
  } else if (platform() === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'cloudy-codex-bridge.service'], { stdio: 'inherit' })
    await rm(join(homedir(), '.config', 'systemd', 'user', 'cloudy-codex-bridge.service'), { force: true })
  }
}

async function main() {
  const [command, value] = process.argv.slice(2)
  if (command === 'pair') return pair(value || process.env.CLOUDY_API_URL || 'http://localhost:3001')
  if (command === 'add-workspace') return addWorkspace(value || '.')
  if (command === 'remove-workspace') return removeWorkspace(value || '.')
  if (command === 'install-service') return install()
  if (command === 'uninstall-service') return uninstall()
  if (command === 'status') return process.stdout.write(`${JSON.stringify(await load(), (key, item) => key === 'token' ? '<redacted>' : item, 2)}\n`)
  if (command === 'run') { const bridge = new Bridge(await load(), { onConfigChange: save }); process.once('SIGTERM', () => bridge.stop()); process.once('SIGINT', () => bridge.stop()); return bridge.start() }
  process.stdout.write('Usage: cloudy-bridge pair [API_URL] | add-workspace [PATH] | remove-workspace [PATH] | run | status | install-service | uninstall-service\n')
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
