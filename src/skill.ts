/** Load the bundled `dynamic-workflows` skill (SKILL.md frontmatter + body). */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadedSkill {
  description: string
  whenToUse?: string
  content: string
}

export function loadSkillContent(dir: string): LoadedSkill | undefined {
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (match === null) return { description: 'Authoring contract for dynamic-workflow scripts (create_workflow).', content: text }
  const front = match[1]!
  const field = (key: string): string | undefined => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(front)?.[1]?.trim()
    if (line === undefined) return undefined
    if (line.startsWith('"') && line.endsWith('"')) {
      try {
        return JSON.parse(line) as string
      } catch {
        return line.slice(1, -1)
      }
    }
    return line
  }
  const description = field('description') ?? 'Authoring contract for dynamic-workflow scripts (create_workflow).'
  const whenToUse = field('when_to_use')
  const body = text.slice(match[0].length)
  const resources = ['patterns.md', 'examples.md'].filter(name => existsSync(join(dir, name)))
  const footer = resources.length === 0
    ? ''
    : `\n\n---\nResources next to this skill (read them with the read tool when §"Going deeper" points at them): ${resources.map(name => join(dir, name)).join(', ')}`
  return { description, ...whenToUse === undefined ? {} : { whenToUse }, content: body + footer }
}
