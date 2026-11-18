/**
 * Classification of a child turn that ended with a model-side failure, mapped
 * onto ZCode's three verdicts: stop the run (`ProviderStop`), fail the ask
 * (`ContextLimit`), or redrive the turn after a backoff. DSH's `dsh-llm-retry`
 * already retries transient failures inside a step; a turn that still ends in
 * a transient error is redriven here, invisibly to the script.
 */

import type { ProviderStopDetails } from '@zcode/dynamic-workflow'

export interface ChildFailureFacts {
  code: string
  message: string
  status?: number
  providerRetryAfterMs?: number
}

export type FailureVerdict =
  | { kind: 'stop'; stop: ProviderStopDetails['kind'] }
  | { kind: 'context_exceeded' }
  | { kind: 'transient' }
  | { kind: 'unknown' }

const AUTH = new Set(['AUTH', 'ACCOUNT_SIGN_IN_REQUIRED', 'ACCOUNT_TOKEN_INVALID', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'HTTP_401', 'HTTP_403'])
const NOT_CONFIGURED = new Set(['NO_ADAPTER', 'NO_CREDENTIAL_STORE', 'INVALID_CONFIG', 'REGISTRATION_DISPOSED'])
const MODEL_UNAVAILABLE = new Set(['UNKNOWN_MODEL', 'MODEL_UNSUPPORTED', 'HTTP_404'])
const INVALID_REQUEST = new Set(['INVALID_REQUEST', 'UNSUPPORTED_CONTENT', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_REASONING_EFFORT', 'HTTP_400', 'HTTP_422'])
const QUOTA = new Set(['QUOTA', 'ACCOUNT_QUOTA'])
const TRANSIENT = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'EMPTY_RESPONSE', 'MALFORMED_RESPONSE', 'HTTP_429', 'HTTP_408'])

/**
 * Exhausted-quota wording of Chinese gateways and providers. DSH's adapters already map English
 * wording (`insufficient_quota`, `quota exceeded`, …) to `QUOTA`, but a 429 whose body says
 * 额度已用尽 arrives as a plain rate limit: retried without end and cutting the shared cap.
 */
const CHINESE_QUOTA_TEXT = /(额度|配额|余额|点数|积分|套餐|用量)[^。\n]{0,8}(用尽|耗尽|用完|不足|已满|超限|超出|到期|已达上限)|(余额|额度|配额)不足|欠费|超出(了)?(本月|今日|每日|当日)?(额度|配额|用量)/u

/** Whether a provider failure message reports an exhausted quota in Chinese. */
export function isChineseQuotaText(message: string): boolean {
  return CHINESE_QUOTA_TEXT.test(message)
}

export function classifyChildFailure(facts: ChildFailureFacts): FailureVerdict {
  const code = facts.code
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return { kind: 'context_exceeded' }
  if ((code === 'RATE_LIMIT' || code === 'HTTP_429' || code === 'HTTP_402' || code === 'UNKNOWN') && isChineseQuotaText(facts.message)) return { kind: 'stop', stop: 'quota' }
  if (AUTH.has(code)) return { kind: 'stop', stop: 'auth' }
  if (NOT_CONFIGURED.has(code)) return { kind: 'stop', stop: 'not_configured' }
  if (MODEL_UNAVAILABLE.has(code)) return { kind: 'stop', stop: 'model_unavailable' }
  if (INVALID_REQUEST.has(code)) return { kind: 'stop', stop: 'invalid_request' }
  if (QUOTA.has(code)) return { kind: 'stop', stop: 'quota' }
  if (TRANSIENT.has(code)) return { kind: 'transient' }
  if (/^HTTP_5\d\d$/.test(code)) return { kind: 'transient' }
  return { kind: 'unknown' }
}

/** Consecutive unknown-code failures within one ask before the run stops as `other`. */
export const UNKNOWN_FAILURE_LIMIT = 10

/** Plausible reset window: a day in the past (clock skew) to 35 days ahead (weekly / monthly quotas). */
const QUOTA_RESET_PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000
const QUOTA_RESET_MAX_AHEAD_MS = 35 * 24 * 60 * 60 * 1000
const QUOTA_RESET_TIME_PATTERN = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})?/u
const QUOTA_RESET_WORD_PATTERN = /重置|reset/iu

export function isPlausibleQuotaResetAt(at: number, now: number): boolean {
  return Number.isFinite(at) && at >= now - QUOTA_RESET_PAST_TOLERANCE_MS && at <= now + QUOTA_RESET_MAX_AHEAD_MS
}

/**
 * Reset moment of a quota failure (epoch ms), the only basis for auto-resume (ZCode's rule):
 * the provider's Retry-After first, else an absolute time in the provider message that talks
 * about a reset (zone-less times are read as UTC+8, the zone of the Chinese providers whose
 * messages carry them). Undefined when neither is plausible: then the run only notifies.
 */
export function quotaResetAt(facts: ChildFailureFacts, now: number = Date.now()): number | undefined {
  const retryAfter = facts.providerRetryAfterMs
  if (typeof retryAfter === 'number' && retryAfter > 0 && isPlausibleQuotaResetAt(now + retryAfter, now)) return now + retryAfter
  if (!QUOTA_RESET_WORD_PATTERN.test(facts.message)) return undefined
  const match = QUOTA_RESET_TIME_PATTERN.exec(facts.message)
  if (match === null) return undefined
  const zone = match[3] === undefined ? '+08:00' : match[3] === 'Z' ? 'Z' : match[3].includes(':') ? match[3] : `${match[3].slice(0, 3)}:${match[3].slice(3)}`
  const at = Date.parse(`${match[1]}T${match[2]}${zone}`)
  return isPlausibleQuotaResetAt(at, now) ? at : undefined
}
