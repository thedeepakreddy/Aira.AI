/**
 * Pages you read, kept so you can find them again.
 *
 * The problem this solves is that every "second brain" dies of neglect: it only
 * holds what someone remembered to put in it, and nobody does. Aira has a
 * browser, so it can fill itself from reading the user was doing anyway.
 *
 * THE SAFETY RULE, which is the whole design:
 *
 *   Page text is written by whoever owns the page, not by the user. `contextFor`
 *   prepends recalled memory to the SYSTEM PROMPT — so a page stored in an
 *   ordinary surface would let any site write instructions into Aira's system
 *   prompt on the user's next message. That is why `browser` was removed from
 *   MEMORY_SURFACES, and nothing here may quietly undo it.
 *
 *   Pages therefore live in a reserved surface that `contextFor` excludes. They
 *   are RETRIEVABLE — the user can search them and gets the URL back — and never
 *   AMBIENT. Nothing a page said reaches a model unless the user went looking
 *   for it, and then it arrives as quoted material in a user turn, labelled
 *   with where it came from, never as instruction.
 *
 * Everything else follows from keeping that line: no summarisation pass over
 * page text with a model that could be steered by it, no automatic recall, no
 * fact extraction from pages.
 */

import { memory, trim } from './store.ts';

/** Reserved. `memoryInput` rejects it, and `contextFor` skips it. */
export const PAGE_SURFACE = '__pages';

/** Guards the reserved surface against a client claiming to be a page. */
export function isPageSurface(surface: string): boolean {
  return surface === PAGE_SURFACE;
}

export interface VisitedPage {
  url: string;
  title: string;
  /** The page's visible text. Trimmed hard — this is for finding, not archiving. */
  text: string;
}

export interface PageHit {
  url: string;
  title: string;
  /** The part of the page that matched, with the match in the middle. */
  excerpt: string;
  at: string;
}

/**
 * Field markers.
 *
 * Chosen to survive the store's whitespace collapsing and to be absent from
 * real titles and URLs. Not newlines, which do not survive it.
 */
const URL_MARK = '::at::';
const TEXT_MARK = '::said::';

/** How much of a page is worth keeping to make it findable later. */
const EXCERPT_LIMIT = 2_000;

/**
 * Pages worth keeping.
 *
 * A browser fires navigations constantly that are not reading: blank tabs, auth
 * redirects, local dev servers, the search engine on the way to the result. All
 * of them would bury the pages that matter.
 */
export function worthKeeping(page: { url: string; title: string; text: string }): boolean {
  const url = page.url?.trim() ?? '';
  if (!/^https?:\/\//i.test(url)) return false;
  // Local and private hosts: these are the user's own running software, not
  // something they were reading, and their content changes every reload.
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(url)) return false;
  // A page has to have said something. Cookie walls and redirects have almost
  // no text; so does a page that has not finished loading.
  if ((page.text?.trim().length ?? 0) < 400) return false;
  // Somewhere on the way to somewhere else.
  if (/\/(login|signin|oauth|auth|callback|logout)(\/|\?|$)/i.test(url)) return false;
  return true;
}

/**
 * The stored form: provenance first, then the text.
 *
 * The URL leads because it is what makes a hit actionable — a remembered
 * paragraph the user cannot get back to is a tease. The marker is there so
 * anything reading this row can tell at a glance that the body is quoted from
 * the web rather than said by the user.
 */
export function formatPage(page: VisitedPage): string {
  const title = page.title?.trim() || page.url;
  const body = page.text.trim().slice(0, EXCERPT_LIMIT);
  // Token delimiters, not newlines. The store's `trim` collapses every run of
  // whitespace into one space before writing, so a newline-delimited format
  // stored fine and then could not be parsed back — the row matched the search
  // and was dropped on the way out, which read as "nothing was ever saved".
  return `[web] ${title} ${URL_MARK} ${page.url} ${TEXT_MARK} ${body}`;
}

/** Parses a stored row back into its parts. */
export function parsePage(text: string, at: string): PageHit | null {
  const match = new RegExp(`^\\[web\\] (.*?) ${URL_MARK} (\\S+) ${TEXT_MARK} ([\\s\\S]*)$`).exec(text);
  if (!match) return null;
  return { title: match[1].trim(), url: match[2], excerpt: match[3].trim(), at };
}

/**
 * Records a page, if it is worth recording.
 *
 * Never throws. Browsing must not break because memory is down, and the user is
 * not doing this on purpose — there is nothing to report a failure to.
 */
export async function rememberPage(userId: string | null, page: VisitedPage): Promise<boolean> {
  if (!userId || !worthKeeping(page)) return false;
  try {
    if (!await memory().enabled(userId)) return false;
    // Re-reading a page replaces nothing: the store is append-only and the
    // retention window clears duplicates in time. Deduplicating here would need
    // a read before every navigation, which is the wrong cost for a background
    // write nobody asked for.
    await memory().remember(userId, {
      at: new Date().toISOString(),
      surface: PAGE_SURFACE,
      role: 'user',
      text: trim(formatPage(page)),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds pages whose text mentions the query.
 *
 * Substring matching, which is what the store offers and is enough: the user is
 * trying to get back to something they remember a phrase from. Returns the URL
 * every time, because getting back there is the point.
 */
export async function searchPages(userId: string | null, query: string, limit = 8): Promise<PageHit[]> {
  if (!userId || !query.trim()) return [];
  try {
    const entries = await memory().recall(userId, 200, query.trim());
    return entries
      .filter((entry) => entry.surface === PAGE_SURFACE)
      .map((entry) => parsePage(entry.text, entry.at))
      .filter((hit): hit is PageHit => hit !== null)
      .map((hit) => ({ ...hit, excerpt: around(hit.excerpt, query.trim()) }))
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * The matching phrase with its surroundings, rather than the opening of the page.
 *
 * A hit that shows the first paragraph of every article makes every result look
 * the same; showing the sentence that matched is what tells the user whether
 * this is the one they meant.
 */
export function around(text: string, query: string, width = 180): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
