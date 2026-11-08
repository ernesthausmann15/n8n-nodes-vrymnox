/**
 * Safe Mode: the local fallback the node uses when the Vrymdor AI Node (gateway) cannot answer in time, is
 * unreachable, or refuses because the Community plan's monthly requests are used up (HTTP 402).
 *
 * It holds only public-grade detectors: well known key prefixes and public formats (email addresses, card numbers
 * that pass the Luhn check, US Social Security numbers, PEM private keys, OpenAI, Anthropic, Stripe, GitHub, AWS,
 * Google and Slack keys, bearer tokens and JWTs), plus string values stored under obviously secret field names.
 * It has no runtime dependencies and none of the gateway's own engine. It masks aggressively on purpose: during an
 * outage over-masking is better than a leak. Masked values use the gateway's format, for example [REDACTED:EMAIL].
 */

export type Redactions = Record<string, number>

const MAX_DEPTH = 64

// One alternation, tried left to right at each position (the same idea as the gateway's builtin list): the
// earliest match wins, so "Bearer eyJ..." is one BEARER_TOKEN and a key inside a PEM block is part of the block.
const PATTERNS: ReadonlyArray<readonly [string, string]> = [
  ['PRIVATE_KEY', String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`],
  ['BEARER_TOKEN', String.raw`\b[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+[A-Za-z0-9._~+/-]{16,}=*`],
  ['JWT', String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`],
  ['VRYMNOX_TOKEN', String.raw`\bvrym_(?:live|agent)_[A-Za-z0-9]{16,}`],
  ['ANTHROPIC_KEY', String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`],
  ['OPENAI_KEY', String.raw`\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}`],
  ['STRIPE_KEY', String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`],
  ['GITHUB_TOKEN', String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})`],
  ['AWS_ACCESS_KEY', String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`],
  ['GOOGLE_API_KEY', String.raw`\bAIza[0-9A-Za-z_-]{35}`],
  ['SLACK_TOKEN', String.raw`\bxox[abeprs]-[A-Za-z0-9-]{10,}`],
  ['SLACK_WEBHOOK', String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9_/-]{10,}`],
  ['EMAIL', String.raw`\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b`],
  ['SSN', String.raw`\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b`],
  ['CREDIT_CARD', String.raw`\b\d(?:[ -]?\d){12,18}\b`],
]
const COMBINED = PATTERNS.map(([name, src]) => `(?<${name}>${src})`).join('|')

// An AWS secret access key has no prefix; it is caught by the name written next to it.
const AWS_SECRET = /\b(aws_secret_access_key|aws_secret_key|secret_access_key|secretAccessKey)(["']?\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi

// A string stored under a field whose name says it is secret is masked whole (n8n credential blocks, .env as JSON).
const SECRET_FIELD = /(?:^|[_-])(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|authorization|private[_-]?key|client[_-]?secret|access[_-]?key)$/i

export function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function count(redactions: Redactions, type: string): string {
  redactions[type] = (redactions[type] ?? 0) + 1
  return `[REDACTED:${type}]`
}

/** Masks one string. Counts each masked value by type into `redactions`. */
export function maskText(text: string, redactions: Redactions = {}): string {
  let out = text.replace(AWS_SECRET, (_m, name: string, sep: string) => `${name}${sep}${count(redactions, 'AWS_SECRET_KEY')}`)
  out = out.replace(new RegExp(COMBINED, 'g'), (match: string, ...rest: unknown[]) => {
    const groups = rest[rest.length - 1] as Record<string, string | undefined>
    const type = PATTERNS.find(([name]) => groups[name] !== undefined)?.[0]
    if (!type) return match
    if (type === 'CREDIT_CARD') {
      const digits = match.replace(/[ -]/g, '')
      if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return match
    }
    return count(redactions, type)
  })
  return out
}

/**
 * Masks every string in a JSON value (objects and arrays are walked, keys are kept). Long integers that are valid
 * card numbers are masked too. Returns a new value; the input is not changed.
 */
export function maskValue(value: unknown, redactions: Redactions = {}): { output: unknown; redactions: Redactions } {
  const walk = (v: unknown, key: string | null, depth: number): unknown => {
    if (depth > MAX_DEPTH) return count(redactions, 'UNINSPECTED')
    if (typeof v === 'string') {
      if (key !== null && v.length >= 8 && SECRET_FIELD.test(key) && !/^\[REDACTED:[A-Z_]+\]$/.test(v)) {
        return count(redactions, 'SECRET')
      }
      return maskText(v, redactions)
    }
    if (typeof v === 'number' && Number.isInteger(v)) {
      const digits = String(Math.abs(v))
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return count(redactions, 'CREDIT_CARD')
      return v
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, null, depth + 1))
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k, depth + 1)
      return out
    }
    return v
  }
  return { output: walk(value, null, 0), redactions }
}
