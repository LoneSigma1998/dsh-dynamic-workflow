/**
 * User-facing artifact store (`artifact.file` / `artifact.markdown`): bytes are
 * copied at publish time into the plugin state directory, one file per version,
 * and the journal row only carries the record (never the bytes). Caps follow
 * the facade: 20 MiB per file, 256 KB per markdown.
 */

import { copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ARTIFACT_CAPS, WorkflowError, type ArtifactPublishRequest, type ArtifactVersionRecord } from '@zcode/dynamic-workflow'

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json',
  '.html': 'text/html', '.htm': 'text/html', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.ts': 'text/x-typescript', '.js': 'text/javascript', '.py': 'text/x-python', '.yaml': 'text/yaml', '.yml': 'text/yaml',
  '.xml': 'application/xml', '.zip': 'application/zip',
}

export interface ArtifactStore {
  publish(cwd: string, request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>
  /** Absolute path of a stored version (for the Web client's download route). */
  pathOf(runId: string, id: string, version: number): string
  root: string
}

function within(cwd: string, target: string): boolean {
  const rel = relative(cwd, target)
  return !(rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel))
}

function options(raw: unknown): { title?: string; description?: string; primary?: boolean; contentType?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const out: { title?: string; description?: string; primary?: boolean; contentType?: string } = {}
  if (typeof record.title === 'string') out.title = record.title.slice(0, 120)
  if (typeof record.description === 'string') out.description = record.description.slice(0, 500)
  if (record.primary === true) out.primary = true
  if (typeof record.contentType === 'string') out.contentType = record.contentType
  return out
}

/** Artifact ids name a directory under the run's directory: one safe path segment, nothing else. */
const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/u

export function createArtifactStore(root: string): ArtifactStore {
  const pathOf = (runId: string, id: string, version: number): string => {
    // Every part is validated, not just escaped: `id` reaches here from scripts and from the HTTP
    // download route (decoded), so `..` or a separator would leave the run's directory.
    if (!SAFE_SEGMENT.test(id)) throw new WorkflowError('ArtifactSpecInvalid', `artifact id ${JSON.stringify(id).slice(0, 80)} is not a safe name (letters, digits, '.', '_', '-').`)
    if (!Number.isSafeInteger(version) || version < 1) throw new WorkflowError('ArtifactSpecInvalid', `artifact version ${String(version)} is not a positive integer.`)
    return join(root, runId.replace(/[^A-Za-z0-9._-]/g, '_'), id, `v${version}`)
  }
  return {
    root,
    pathOf,
    async publish(cwd, request) {
      const opts = options(request.opts)
      const target = pathOf(request.runId, request.id, request.version)
      await mkdir(join(target, '..'), { recursive: true })
      if (request.op === 'markdown') {
        const content = request.content
        if (typeof content !== 'string') throw new WorkflowError('DriverError', `artifact.markdown("${request.id}"): content must be a string.`)
        const bytes = Buffer.byteLength(content, 'utf8')
        if (bytes > ARTIFACT_CAPS.maxMarkdownBytes) {
          throw new WorkflowError('ArtifactTooLarge', `artifact.markdown("${request.id}"): ${bytes} bytes, over the ${ARTIFACT_CAPS.maxMarkdownBytes}-byte cap.`)
        }
        await writeFile(target, content, 'utf8')
        return {
          id: request.id, kind: 'markdown', version: request.version, contentType: 'text/markdown', bytes,
          uri: `dsh-dwf-artifact://${request.runId}/${request.id}/v${request.version}`, publishedAt: Date.now(),
          ...opts.title === undefined ? {} : { title: opts.title },
          ...opts.description === undefined ? {} : { description: opts.description },
          ...opts.primary === true ? { primary: true as const } : {},
        }
      }
      const path = request.path
      if (typeof path !== 'string' || path.length === 0) throw new WorkflowError('DriverError', `artifact.file("${request.id}"): path must be a non-empty string.`)
      const resolved = resolve(cwd, path)
      if (!within(cwd, resolved)) throw new WorkflowError('ArtifactPathOutsideWorkspace', `artifact.file("${request.id}"): '${path}' is outside the workspace.`)
      let real: string
      try {
        real = await realpath(resolved)
      } catch {
        throw new WorkflowError('ArtifactSourceMissing', `artifact.file("${request.id}"): '${path}' does not exist.`)
      }
      if (!within(await realpath(cwd), real)) throw new WorkflowError('ArtifactPathOutsideWorkspace', `artifact.file("${request.id}"): '${path}' resolves outside the workspace.`)
      const info = await stat(real)
      if (!info.isFile()) throw new WorkflowError('ArtifactSourceMissing', `artifact.file("${request.id}"): '${path}' is not a file.`)
      if (info.size > ARTIFACT_CAPS.maxFileBytes) {
        throw new WorkflowError('ArtifactTooLarge', `artifact.file("${request.id}"): ${info.size} bytes, over the ${ARTIFACT_CAPS.maxFileBytes}-byte cap.`)
      }
      await copyFile(real, target)
      return {
        id: request.id, kind: 'file', version: request.version,
        contentType: opts.contentType ?? CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        bytes: info.size, uri: `dsh-dwf-artifact://${request.runId}/${request.id}/v${request.version}`,
        sourcePath: relative(cwd, resolved).split(sep).join('/'), publishedAt: Date.now(),
        ...opts.title === undefined ? {} : { title: opts.title },
        ...opts.description === undefined ? {} : { description: opts.description },
        ...opts.primary === true ? { primary: true as const } : {},
      }
    },
  }
}
