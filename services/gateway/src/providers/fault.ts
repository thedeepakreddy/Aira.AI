import type { Fault } from './types.ts';

/**
 * Works out whose problem a provider failure is.
 *
 * Status codes alone are not enough. Anthropic reports an empty wallet as
 * `400 invalid_request_error` — indistinguishable by status from a malformed
 * request, which is Aira's fault and needs the opposite response from the
 * user. So the vendor's own words decide, and the status is the fallback.
 */

/** Phrases vendors use when the account, not the service, is the problem. */
const ACCOUNT_SIGNALS = [
  'credit balance is too low',
  'billing',
  'exceeded your current quota',
  'insufficient_quota',
  'insufficient funds',
  'payment required',
  'plan and billing',
  'quota exceeded',
  'invalid api key',
  'incorrect api key',
  'no active subscription',
  'account is not active',
  'access denied',
];

/** Phrases that mean the service is struggling and a retry may work. */
const PROVIDER_SIGNALS = [
  'rate limit',
  'rate_limit',
  'overloaded',
  'temporarily unavailable',
  'service unavailable',
  'try again later',
  'capacity',
  'timeout',
  'timed out',
];

export function classifyFault(status: number | undefined, raw: string | undefined): Fault {
  const text = (raw ?? '').toLowerCase();

  // Wording wins over status: a 400 saying "credit balance is too low" is an
  // account problem however it is numbered.
  if (ACCOUNT_SIGNALS.some((signal) => text.includes(signal))) return 'account';
  if (PROVIDER_SIGNALS.some((signal) => text.includes(signal))) return 'provider';

  if (status === 401 || status === 402 || status === 403) return 'account';
  if (status === 429) return 'provider';
  if (status !== undefined && status >= 500) return 'provider';

  // A 4xx we could not otherwise explain is most often a request Aira built
  // wrong — the Gemini thought_signature bug arrived exactly this way.
  return 'gateway';
}

/** What the user should be told to do about it. */
export function faultAdvice(fault: Fault): string {
  switch (fault) {
    case 'account':
      return 'Check your provider account — this usually means credit, quota, or an expired key.';
    case 'provider':
      return 'The model provider is busy or unavailable. Waiting and retrying usually works.';
    case 'gateway':
      return 'This is a problem on Aira’s side, not your account.';
  }
}
