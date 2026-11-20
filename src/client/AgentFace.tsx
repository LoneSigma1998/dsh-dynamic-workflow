/**
 * Subagent tile face & crisp workflow icons (ported from ZCode `WorkflowAgentFace.tsx` and
 * `workflow-face-motion.ts`, Apache-2.0).
 *
 * Every subagent shares this rounded-square face (`viewBox="0 0 20 20"`, `rx=7`) across timeline
 * pills, collapsed spine avatar clusters, and subagent change cards:
 *   - 9 curated identity colors cycled by `avatarIndex` (or hashed from name);
 *   - expressive eyes (`dots` when waiting, `pill`/`focused`/`confused` while running, `happy` when
 *     done, `sad` when failed) driven by lightweight DOM attribute updates (zero React re-renders);
 *   - optional bottom-left green completion checkmark badge (`showCompletionMark`).
 */

import { useEffect, useRef, type CSSProperties } from 'react'
import type { StepRunStatus } from './model/graph/types.ts'

export const FACE_COLORS = [
  '#54B9A6',
  '#F19D38',
  '#6464EF',
  '#885CF5',
  '#3C82F6',
  '#ED712E',
  '#EB4699',
  '#5BC67A',
  '#EA4045',
] as const

export function avatarColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360
  return FACE_COLORS[hash % FACE_COLORS.length]!
}

export function agentColor(avatarIndex: number | undefined, name: string): string {
  if (avatarIndex === undefined) return avatarColor(name)
  return FACE_COLORS[((avatarIndex % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length]!
}

export type FaceState = 'idle' | 'waiting' | 'scanning' | 'content' | 'sad'
export type EyeExpression = 'dots' | 'pill' | 'happy' | 'sleepy' | 'focused' | 'sad' | 'confused'

export function faceState(status: StepRunStatus | undefined): FaceState {
  return status === 'running'
    ? 'scanning'
    : status === 'done'
      ? 'content'
      : status === 'failed'
        ? 'sad'
        : 'waiting'
}

export const BASE_EXPRESSION: Record<FaceState, EyeExpression> = {
  idle: 'pill',
  waiting: 'dots',
  scanning: 'pill',
  content: 'happy',
  sad: 'sad',
}

const SPECIAL: Record<FaceState, readonly EyeExpression[]> = {
  idle: [],
  scanning: ['focused', 'confused'],
  waiting: [],
  content: [],
  sad: [],
}

function startFaceMotion(face: SVGSVGElement, state: FaceState): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  let timer: ReturnType<typeof setTimeout> | undefined
  let visible = true
  let rounds = 0
  let lookingLeft = false
  let previous: EyeExpression | undefined
  const random = (min: number, max: number) => min + Math.random() * (max - min)
  const later = (delay: number, action: () => void) => { timer = setTimeout(action, delay) }
  const motion = (value: string) => { face.dataset.motion = value }
  const base = () => {
    face.dataset.expression = BASE_EXPRESSION[state]
    motion('idle')
    face.style.setProperty('--wf-face-x', '0px')
    face.style.setProperty('--wf-face-y', state === 'sad' ? '0.3px' : '0px')
  }
  const pause = () => {
    motion('idle')
    later(
      state === 'waiting' ? random(1500, 3000)
        : state === 'scanning' ? random(1000, 2000)
          : state === 'sad' ? random(1800, 4000)
            : random(6000, 10000),
      cycle,
    )
  }
  const morph = (expression: EyeExpression, next: () => void) => {
    motion('morph')
    later(80, () => {
      face.dataset.expression = expression
      later(100, () => {
        motion('idle')
        next()
      })
    })
  }
  const maybeExpression = () => {
    if (state === 'idle' || SPECIAL[state].length === 0) {
      pause()
      return
    }
    rounds += 1
    const probability = state === 'scanning' ? 0.45 : 0.25
    if (rounds < 2 || Math.random() >= probability) {
      pause()
      return
    }
    const choices = SPECIAL[state].filter(e => e !== previous)
    const pool = choices.length > 0 ? choices : SPECIAL[state]
    const expression = pool[Math.floor(Math.random() * pool.length)]!
    previous = expression
    rounds = 0
    const hold = expression === 'confused' ? random(2200, 3800) : random(800, 1800)
    morph(expression, () => later(hold, () => morph(BASE_EXPRESSION[state], pause)))
  }
  const glance = () => {
    motion('glance')
    lookingLeft = !lookingLeft
    face.style.setProperty('--wf-face-x', lookingLeft ? '-3.2px' : '0px')
    later(360, maybeExpression)
  }
  function cycle(): void {
    if (state === 'waiting') {
      motion('dots-wave')
      later(900, pause)
      return
    }
    if (state === 'sad') {
      const floats = Math.random() < 0.5 ? 1 : 2
      face.style.setProperty('--wf-face-floats', String(floats))
      motion('float')
      later(floats * 600, pause)
      return
    }
    if (state === 'content') {
      const duration = random(260, 320)
      face.style.setProperty('--wf-face-blinks', '1')
      face.style.setProperty('--wf-face-blink-time', `${duration}ms`)
      motion('blink')
      later(duration, () => {
        face.dataset.expression = 'happy'
        pause()
      })
      return
    }
    const blinks = Math.random() < 0.5 ? 2 : 3
    const duration = state === 'scanning' ? random(200, 260) : random(260, 320)
    face.style.setProperty('--wf-face-blinks', String(blinks))
    face.style.setProperty('--wf-face-blink-time', `${duration}ms`)
    motion('blink')
    later(duration * blinks, glance)
  }
  const restart = () => {
    clearTimeout(timer)
    timer = undefined
    rounds = 0
    lookingLeft = false
    base()
    if (!document.hidden && !media?.matches && visible) later(random(1200, 2800), cycle)
  }
  const observer = typeof IntersectionObserver === 'undefined'
    ? undefined
    : new IntersectionObserver((entries) => {
      const next = entries[0]?.isIntersecting ?? true
      if (next !== visible) {
        visible = next
        restart()
      }
    })
  observer?.observe(face)
  document.addEventListener('visibilitychange', restart)
  media?.addEventListener?.('change', restart)
  restart()
  return () => {
    clearTimeout(timer)
    observer?.disconnect()
    document.removeEventListener('visibilitychange', restart)
    media?.removeEventListener?.('change', restart)
    base()
  }
}

const EXPRESSIONS = ['pill', 'happy', 'sleepy', 'focused', 'sad', 'confused'] as const

function Eyes() {
  return (
    <g className="wf-face-eyes">
      <g className="wf-face-bounce">
        <g className="wf-face-lids">
          <g data-eye-expression="dots" fill="var(--wf-face-eye)">
            {[5, 10, 15].map(cx => <circle key={cx} cx={cx} cy={10} r={1.5} />)}
          </g>
          {EXPRESSIONS.map(expression => (
            <g key={expression} data-eye-expression={expression} fill="var(--wf-face-eye)">
              {[5.2, 11.2].map((x, i) => {
                if (expression === 'pill' || expression === 'confused') {
                  const short = expression === 'confused' && i === 1
                  return <rect key={x} x={x} y={short ? 8 : 6} width={3.6} height={short ? 4 : 6} rx={1.8} />
                }
                const paths = {
                  happy: 'M0 11 V8 A1.8 1.8 0 0 1 3.6 8 V11 Z',
                  sleepy: i === 0 ? 'M0 8 L3.6 7 V9 A1.8 1.8 0 0 1 0 9 Z' : 'M0 7 L3.6 8 V9 A1.8 1.8 0 0 1 0 9 Z',
                  focused: i === 0 ? 'M0 6 L3.6 8 V10 A1.8 1.8 0 0 1 0 10 Z' : 'M0 8 L3.6 6 V10 A1.8 1.8 0 0 1 0 10 Z',
                  sad: i === 0 ? 'M0 8 L3.6 6 V10 A1.8 1.8 0 0 1 0 10 Z' : 'M0 6 L3.6 8 V10 A1.8 1.8 0 0 1 0 10 Z',
                }
                return <path key={x} transform={`translate(${x} 0)`} d={paths[expression]} />
              })}
            </g>
          ))}
        </g>
        <g className="wf-face-closed" fill="var(--wf-face-eye)">
          {[5.2, 11.2].map(x => <rect key={x} x={x} y={8.2} width={3.6} height={1.8} rx={0.9} />)}
        </g>
      </g>
    </g>
  )
}

export function AgentFace({
  avatarIndex,
  name,
  status,
  idle = false,
  showCompletionMark = false,
  size = 20,
  className,
  color,
}: {
  avatarIndex?: number | undefined
  name: string
  status?: StepRunStatus | undefined
  idle?: boolean
  showCompletionMark?: boolean
  size?: number
  className?: string
  color?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const state = idle ? 'idle' : faceState(status)
  useEffect(() => {
    if (ref.current !== null && !showCompletionMark) return startFaceMotion(ref.current, state)
    return undefined
  }, [state, showCompletionMark])
  const style = { '--wf-face-body': color ?? agentColor(avatarIndex, name), width: size, height: size } as CSSProperties
  return (
    <svg
      aria-hidden
      className={className ? `wf-face ${className}` : 'wf-face'}
      data-face-state={state}
      data-expression={BASE_EXPRESSION[state]}
      data-motion="idle"
      ref={ref}
      style={style}
      viewBox="0 0 20 20"
    >
      <rect className="wf-face-body" fill="var(--wf-face-body)" height={20} rx={6.5} width={20} />
      <Eyes />
      {showCompletionMark ? (
        <g data-subagent-completion-badge="">
          <circle cx={3.2} cy={16.8} r={5.2} fill="var(--dsw-alias-state-success-primary, #22c55e)" stroke="var(--dwf-pill-bg, var(--dsw-alias-bg-base))" strokeWidth={1.6} />
          <path d="m0.9 16.8 1.5 1.5 3.1-3.1" fill="none" stroke="#fff" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : null}
    </svg>
  )
}

export function WorkflowGraphIcon({ size = 15 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.8" y="1.8" width="4.4" height="4.4" rx="1.2" />
      <rect x="9.8" y="9.8" width="4.4" height="4.4" rx="1.2" />
      <path d="M6.2 4h2.3a1.5 1.5 0 0 1 1.5 1.5V9.8" />
      <circle cx="4" cy="12" r="1.8" />
      <path d="M4 6.2v4" />
    </svg>
  )
}

export function ArtifactKindIcon({ kind, contentType }: { kind: string; contentType?: string }) {
  if (kind === 'table' || contentType === 'text/csv') {
    return (
      <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35">
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M2 6.2h12M2 9.8h12M6.5 6.2v7.3" />
      </svg>
    )
  }
  if (kind === 'chart') {
    return (
      <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 13.5h11M3.5 10.5l3-3.2 2.4 2 3.6-4.8" />
      </svg>
    )
  }
  if (kind === 'metrics') {
    return (
      <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round">
        <rect x="2" y="3" width="5" height="10" rx="1.4" />
        <rect x="9" y="3" width="5" height="10" rx="1.4" />
      </svg>
    )
  }
  if (kind === 'board') {
    return (
      <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35">
        <rect x="2" y="2.5" width="12" height="11" rx="2" />
        <path d="M6 2.5v11M10 2.5v11" />
      </svg>
    )
  }
  if (kind === 'markdown' || contentType === 'text/markdown') {
    return <span className="dwf-md-glyph" aria-hidden>M↓</span>
  }
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h5.5L13 5.5V14H4z" />
      <path d="M9.5 2v3.5H13" />
    </svg>
  )
}

export function SaveFloppyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 3.5A1 1 0 0 1 3.5 2.5h7.3L13.5 5.2v7.3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
      <path d="M5 2.5v3.5h5V2.5M5 13.5V9.2h6v4.3" />
    </svg>
  )
}

export function SparkleIcon({ size = 14 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 1.8c.4 2.8 1.4 3.8 4.2 4.2-2.8.4-3.8 1.4-4.2 4.2-.4-2.8-1.4-3.8-4.2-4.2 2.8-.4 3.8-1.4 4.2-4.2Z" />
      <path d="M12.5 10.5c.2 1.2.6 1.6 1.8 1.8-1.2.2-1.6.6-1.8 1.8-.2-1.2-.6-1.6-1.8-1.8 1.2-.2 1.6-.6 1.8-1.8Z" />
    </svg>
  )
}

export function ExpandDiagonalIcon({ size = 13 }: { size?: number }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.8 2.5h3.7v3.7M13.3 2.7 9.2 6.8M6.2 13.5H2.5V9.8M2.7 13.3l4.1-4.1" />
    </svg>
  )
}

export function ScriptCheckIcon({ done }: { done: boolean }) {
  return done ? (
    <svg aria-hidden className="dwf-script-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8.1 1.7 1.7 3.4-3.5" />
    </svg>
  ) : null
}
