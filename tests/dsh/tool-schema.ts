/**
 * The typed `submit_result` tool schema: every ask schema the vendored synthesizer produces —
 * from the skill's examples and from a stress script covering the TypeScript shapes models
 * actually write (optional / nullable fields, literal and object unions, tuples, records,
 * recursive types, JSDoc constraints) — is relaxed into a schema DSH's enforced subset accepts
 * (`assertObjectJsonSchema`), and the relaxation never rejects a value the engine's validator
 * accepts (the engine stays the authority; the tool schema only guides).
 * Run: tsx --tsconfig tsconfig.test.json tests/dsh/tool-schema.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertObjectJsonSchema, validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { validate, type JsonSchema } from '@zcode/dynamic-workflow'
import { exactResultSchema, relaxToDshSchema } from '../../src/driver/driver.ts'
import { compileOnce } from '../../src/service/compile.ts'

const STRESS = `
/** A node of a recursive tree. */
interface TreeNode { name: string; children: TreeNode[] }
interface Stress {
  /** @minimum 1 @maximum 5 */
  score: number
  /** @minLength 3 @pattern ^[a-z]+$ */
  slug: string
  label?: string
  owner: string | null
  severity: "low" | "medium" | "high"
  target: { kind: "file"; path: string } | { kind: "url"; href: string }
  pair: [string, number]
  counts: Record<string, number>
  tags: string[]
  /** @minItems 1 */
  steps: { title: string; done: boolean }[]
  tree: TreeNode
  amount: number | string
}
const result = await agent("Stressor").ask<Stress>("stress")
return result
`

const scripts: { name: string; text: string }[] = [{ name: 'stress', text: STRESS }]
const examples = readFileSync(join(import.meta.dirname, '../../skills/dynamic-workflows/examples.md'), 'utf8')
for (const [, title, text] of examples.matchAll(/^#{2,4}\s+(.+)$[\s\S]*?```ts\n([\s\S]*?)```/gmu)) scripts.push({ name: title!.trim(), text: text! })

let schemas = 0
let lossless = 0
let stressSchema: JsonSchema | undefined
let stressRelaxed: JsonSchemaNode | undefined
for (const script of scripts) {
  let compiled
  try {
    compiled = compileOnce(script.text)
  } catch {
    continue // examples that do not typecheck standalone are covered by the integration tests
  }
  for (const [actor, profile] of compiled.actorSubmitProfiles) {
    if (profile.kind !== 'mono') continue
    const relaxed = relaxToDshSchema(profile.schema)
    assert.ok(relaxed !== undefined, `${script.name}/${actor}: object root relaxes`)
    assertObjectJsonSchema(relaxed.schema) // throws on any keyword outside DSH's enforced subset
    schemas += 1
    if (relaxed.lossless) lossless += 1
    if (script.name === 'stress') { stressSchema = profile.schema; stressRelaxed = relaxed.schema as JsonSchemaNode }
  }
}
assert.ok(stressSchema !== undefined && stressRelaxed !== undefined, 'the stress ask is mono-typed')
console.log(`✓ ${schemas} synthesized ask schemas relax into DSH's enforced subset (${lossless} lossless)`)

// The relaxation is a superset: whatever the engine accepts, DSH's validator accepts too.
const valid = {
  score: 3, slug: 'abc', owner: null, severity: 'high', target: { kind: 'url', href: 'https://x' }, pair: ['a', 1],
  counts: { a: 1 }, tags: [], steps: [{ title: 't', done: false }], tree: { name: 'r', children: [{ name: 'c', children: [] }] }, amount: 'ten',
}
const variants = [
  valid,
  { ...valid, label: 'x', owner: 'me', target: { kind: 'file', path: 'a.ts' }, amount: 10 },
  { ...valid, severity: 'low', tree: { name: 'leaf', children: [] } },
]
for (const value of variants) {
  assert.deepEqual(validate(stressSchema, value), [], `engine accepts ${JSON.stringify(value).slice(0, 60)}`)
  assert.deepEqual(validateJsonSchemaValue(stressRelaxed, value), [], `DSH accepts what the engine accepts: ${JSON.stringify(value).slice(0, 60)}`)
}
// …while structure the model can see is still enforced at the tool boundary
assert.ok(validateJsonSchemaValue(stressRelaxed, { ...valid, severity: 'urgent' }).length > 0, 'literal union kept as enum')
assert.ok(validateJsonSchemaValue(stressRelaxed, { ...valid, steps: 'none' }).length > 0, 'array type kept')
assert.ok(validateJsonSchemaValue(stressRelaxed, (({ slug: _slug, ...rest }) => rest)(valid)).length > 0, 'required kept')
// and constraints the subset cannot express are in the descriptions (the engine enforces them)
const props = stressRelaxed.properties!
assert.match(String(props.score!.description), /minimum 1.*maximum 5/u)
assert.match(String(props.slug!.description), /pattern/u)
assert.ok(validate(stressSchema, { ...valid, score: 9 }).length > 0, 'the engine still rejects score 9')
console.log('✓ relaxed schema accepts every engine-valid value, keeps enums/types/required, restates constraints in descriptions')

// exact mode (the default, ZCode parity): the precise schema crosses as is, $defs hoisted to the root
const exact = exactResultSchema(stressSchema)!
assert.ok(exact.defs !== undefined && 'TreeNode' in exact.defs, 'recursive $defs are hoisted')
assert.ok(!('$defs' in exact.schema), 'the nested result schema carries no $defs of its own')
const exactProps = (exact.schema as { properties: Record<string, Record<string, unknown>> }).properties
assert.equal(exactProps.score!.minimum, 1, 'numeric bounds survive')
assert.ok(Array.isArray(exactProps.target!.anyOf), 'object unions survive as anyOf')
assert.equal(exactProps.tree!.$ref, '#/$defs/TreeNode', 'references resolve from the parameters root')
console.log('✓ exact result schema keeps bounds, unions and references; $defs move to the parameters root')
console.log(`  stress → ${JSON.stringify(stressRelaxed).slice(0, 220)}…`)
console.log('TOOL SCHEMA OK')
