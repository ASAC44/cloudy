import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { StoreError } from './store.js'
import type { ScreenLayout } from './types/store.js'

export const DEFAULT_SCREEN_LAYOUT: ScreenLayout = {
  left: ['app:github'],
  right: ['app:gmail'],
  down: ['app:codex'],
}

export class LocalPodLayoutStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists pod_screen_layouts (
        pod_id text primary key,
        layout text not null,
        revision integer not null check (revision >= 0)
      ) strict;
    `)
  }

  get(podId: string): { layout: ScreenLayout; revision: number } {
    const row = this.db.prepare('select layout, revision from pod_screen_layouts where pod_id = ?').get(podId) as { layout: string; revision: number } | undefined
    if (!row) return { layout: DEFAULT_SCREEN_LAYOUT, revision: 0 }
    const layout = JSON.parse(row.layout) as Record<string, unknown>
    const saved = 'left' in layout ? layout as ScreenLayout : DEFAULT_SCREEN_LAYOUT
    return { layout: { left: saved.left.slice(0, 6), right: saved.right.slice(0, 6), down: saved.down.slice(0, 6) }, revision: row.revision }
  }

  update(podId: string, expectedRevision: number, layout: ScreenLayout) {
    if (Object.values(layout).some((feeds) => feeds.length > 6)) throw new StoreError('invalid_pod_layout')
    this.db.exec('begin immediate')
    try {
      const current = this.get(podId)
      if (current.revision !== expectedRevision) throw new StoreError('pod_layout_conflict')
      const revision = current.revision + 1
      this.db.prepare(`
        insert into pod_screen_layouts(pod_id, layout, revision) values (?, ?, ?)
        on conflict(pod_id) do update set layout = excluded.layout, revision = excluded.revision
      `).run(podId, JSON.stringify(layout), revision)
      this.db.exec('commit')
      return { layout, revision }
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }
}
