/**
 * Turns raw provider errors into something a paying user should see.
 *
 * Vendor errors leak internals (request ids, JSON envelopes, billing consoles
 * that belong to us, not to the customer). They are useful in the logs, which
 * keep the original text; only what reaches the UI is rewritten.
 */
const PATTERNS: Array<{ match: RegExp; message: string }> = [
  {
    // Ours to fix, not the user's — never send them to a billing page.
    match: /credit balance is too low|insufficient_quota|credit_balance_exhausted|billing/i,
    message: 'Aira is temporarily unable to reach this model. This is on our side — please try again shortly.',
  },
  {
    match: /rate limit|too many requests|429/i,
    message: 'Aira is busy right now. Give it a moment and try again.',
  },
  {
    match: /context.{0,20}(length|window)|too many tokens|prompt is too long/i,
    message: 'This conversation has grown too long for the selected model. Start a new chat to continue.',
  },
  {
    match: /authentication|invalid.{0,10}api key|unauthorized|401/i,
    message: 'Aira could not authenticate with the model provider. This is on our side.',
  },
  {
    match: /overloaded|capacity|503|502|internal server error/i,
    message: 'The model provider is having trouble. Please try again in a moment.',
  },
];

export function humanize(raw: string): string {
  for (const { match, message } of PATTERNS) {
    if (match.test(raw)) return message;
  }
  // Unrecognised: say something honest rather than dumping a JSON envelope.
  return 'Something went wrong reaching the model. Please try again.';
}
