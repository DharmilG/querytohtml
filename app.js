'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

// app.js — Query to HTML
//
// This file is the whole application. It is built one small function at a
// time. Each function has one job, so you can read and change it alone.

/**
 * Turn a search query into a name that is safe for folders and files.
 *
 * Queries can contain slashes, emoji, or nothing at all. Those characters
 * must never reach the file system, so this function is the single place
 * where text becomes a name. It keeps letters from every language, turns
 * everything else into dashes, and refuses to return an empty name.
 *
 * @param {string} input - the raw query or other text to clean up
 * @param {number} maxLength - longest name to return (default 48)
 * @returns {string} a name safe to use in a path
 */
function slugify(input, maxLength = 48) {
  const name = String(input ?? '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  if (!name) return 'query';

  // Windows keeps these names for itself. Adding a prefix avoids errors
  // when someone searches for a word like "con" or "com1".
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    return `q-${name}`;
  }

  return name;
}

/**
 * Resolve a path inside a chosen base folder and refuse anything outside it.
 *
 * The app accepts a folder from the browser. That is user input, so it must
 * not be trusted blindly: a name with ".." or a full drive path could point
 * somewhere the user never chose. This function resolves the final path and
 * checks that it still sits under the base before returning it.
 *
 * @param {string} base - the folder the user chose
 * @param {...string} parts - path pieces to add under that folder
 * @returns {string} the resolved absolute path
 */
function resolveInside(base, ...parts) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts);

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('That path is outside the chosen download folder');
  }

  return target;
}

/**
 * Build the name of one run's folder: safe query plus a timestamp.
 *
 * Two runs of the same query must never share a folder. The time is added
 * down to the second, so each run gets its own place to put files. A Date
 * can be passed in, which makes the function easy to test.
 *
 * @param {string} query - the search query
 * @param {Date} now - time to use (defaults to the current moment)
 * @returns {string} folder name such as "typescript-generics_20261124-143002"
 */
function runFolderName(query, now = new Date()) {
  const pad = (number) => String(number).padStart(2, '0');
  const date = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('');
  const time = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');

  return `${slugify(query)}_${date}-${time}`;
}

/**
 * Turn HTML entities into the characters they stand for.
 *
 * Search pages rarely hand us clean links. They escape "&" as "&amp;" and
 * quotes as "&quot;". There is no browser DOM in Node, so this small
 * replacement chain does the decoding before we parse a URL.
 *
 * @param {string} text - text taken out of HTML
 * @returns {string} the same text with entities decoded
 */
function decodeHtmlEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|apos);/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

/**
 * Pull every href value out of the anchor tags in an HTML page.
 *
 * @param {string} html - a page of search results
 * @returns {string[]} raw href values, still escaped
 */
function extractHrefs(html) {
  const hrefs = [];
  const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;

  while ((match = anchor.exec(String(html ?? ''))) !== null) {
    hrefs.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  return hrefs;
}

const SEARCH_HOST_PATTERN = /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|googleapis\.com|duckduckgo\.com|duck\.co|startpage\.com|bing\.com)$/i;

/**
 * Clean one raw href into a usable result URL, or reject it.
 *
 * Google wraps links as /url?q=REAL_URL and DuckDuckGo wraps them as
 * /l/?uddg=REAL_URL. This function unwraps both forms, drops internal
 * search-engine links, and keeps only normal http(s) addresses.
 *
 * @param {string} raw - an href value from a search page
 * @param {string} base - the search page address, for relative links
 * @returns {string|null} a clean URL, or null if it is not a result
 */
function normalizeResultUrl(raw, base) {
  let value = decodeHtmlEntities(raw).trim();

  if (!value || value.startsWith('#') || /^(javascript|mailto|tel):/i.test(value)) {
    return null;
  }
  if (value.startsWith('//')) value = `https:${value}`;

  let url;
  try {
    const candidate = new URL(value, base);
    const wrapped = candidate.searchParams.get('q')
      || candidate.searchParams.get('uddg')
      || candidate.searchParams.get('url');
    const isWrapper = /^\/url\/?$/i.test(candidate.pathname)
      || /^\/l\/?$/i.test(candidate.pathname)
      || (SEARCH_HOST_PATTERN.test(candidate.hostname) && Boolean(wrapped));

    url = isWrapper && wrapped ? new URL(wrapped, base) : candidate;
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (SEARCH_HOST_PATTERN.test(url.hostname.toLowerCase())) return null;

  url.hash = '';
  return url.toString();
}

/**
 * Remove duplicate URLs while keeping the order they appeared in.
 *
 * @param {string[]} urls - URLs in the order they were found
 * @returns {string[]} the same URLs, each appearing once
 */
function uniqueUrls(urls) {
  return [...new Set(urls)];
}

const GOOGLE_SEARCH_BASE = 'https://www.google.com/search';

/**
 * Pull the result links out of a Google results page.
 *
 * Google mixes real results with links to its own settings, images, and
 * next page of results. normalizeResultUrl() removes the internal ones,
 * so what is left should be the pages the user actually searched for.
 *
 * @param {string} html - the raw HTML of a Google results page
 * @returns {string[]} result URLs in the order Google listed them
 */
function parseGoogleResults(html) {
  return uniqueUrls(
    extractHrefs(html)
      .map((href) => normalizeResultUrl(href, GOOGLE_SEARCH_BASE))
      .filter(Boolean)
  );
}

const DUCKDUCKGO_SEARCH_BASE = 'https://html.duckduckgo.com/html/';

/**
 * Pull the result links out of a DuckDuckGo HTML results page.
 *
 * DuckDuckGo sends result addresses through a /l/?uddg= redirect, which
 * normalizeResultUrl() already knows how to unwrap. Having a parser for
 * this source means a Google CAPTCHA does not have to stop the run.
 *
 * @param {string} html - the raw HTML of a DuckDuckGo results page
 * @returns {string[]} result URLs in the order DuckDuckGo listed them
 */
function parseDuckDuckGoResults(html) {
  return uniqueUrls(
    extractHrefs(html)
      .map((href) => normalizeResultUrl(href, DUCKDUCKGO_SEARCH_BASE))
      .filter(Boolean)
  );
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Recognise a page that is a bot check rather than a list of results.
 *
 * Both search engines sometimes answer with a challenge page instead of
 * results. Treating that as "no results" is safer than saving the challenge
 * as if it were a search result, and it lets the caller try the fallback.
 *
 * @param {string} html - search page body
 * @returns {boolean} true if the page looks like a block
 */
function looksBlocked(html) {
  return !html || /unusual traffic|detected unusual|captcha|\/sorry\/|anomaly|bot check|enable javascript and cookies/i.test(html);
}

/**
 * Fetch one page of search results.
 *
 * @param {string} url - address of the results page
 * @param {number} timeoutMs - how long to wait before giving up
 * @returns {Promise<string|null>} the page HTML, or null on failure
 */
async function fetchSearchPage(url, timeoutMs) {
  try {
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  }
}

/**
 * Read enough result pages from one provider to reach the wanted count.
 *
 * Search engines show ten links per page, so this asks for page two only
 * when page one did not provide enough. Five pages is a hard ceiling: a
 * run should not keep hitting a search engine forever.
 *
 * @param {'google'|'duckduckgo'} provider - which engine to ask
 * @param {string} query - the search query
 * @param {number} count - how many URLs to collect
 * @param {number} timeoutMs - per-request timeout
 * @returns {Promise<string[]>} result URLs, up to count
 */
async function collectResults(provider, query, count, timeoutMs) {
  const urls = [];

  for (let page = 0; page < 5 && urls.length < count; page += 1) {
    const start = page * 10;
    const url = provider === 'google'
      ? `https://www.google.com/search?q=${encodeURIComponent(query)}&num=10&start=${start}&hl=en`
      : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${start}`;

    const html = await fetchSearchPage(url, timeoutMs);
    if (looksBlocked(html)) break;

    const found = provider === 'google'
      ? parseGoogleResults(html)
      : parseDuckDuckGoResults(html);
    if (found.length === 0) break;

    urls.push(...found);
  }

  return uniqueUrls(urls).slice(0, count);
}

/**
 * Get result URLs for a query, trying Google and then DuckDuckGo.
 *
 * The source setting controls the order: "auto" tries both, while a named
 * provider is used alone. The returned object always says which provider
 * supplied the links, whether the run was blocked, and whether the full
 * count was reached, so the interface can tell the truth about the result.
 *
 * @param {string} query - the search query
 * @param {number} count - how many URLs are wanted
 * @param {'auto'|'google'|'duckduckgo'} source - provider choice
 * @param {number} timeoutMs - per-request timeout
 * @returns {Promise<{urls: string[], source: string, blocked: boolean, complete: boolean, notes: string[]}>}
 */
async function searchWeb(query, count = 10, source = 'auto', timeoutMs = 15000) {
  const providers = source === 'duckduckgo' || source === 'google'
    ? [source]
    : ['google', 'duckduckgo'];
  const notes = [];

  for (const provider of providers) {
    const urls = await collectResults(provider, query, count, timeoutMs);
    if (urls.length > 0) {
      return {
        urls,
        source: provider,
        blocked: false,
        complete: urls.length >= count,
        notes,
      };
    }
    notes.push(`${provider} returned no usable results`);
  }

  return {
    urls: [],
    source: providers[providers.length - 1],
    blocked: true,
    complete: false,
    notes,
  };
}

const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/**
 * Read a response body, but never keep more than maxBytes.
 *
 * A page can be enormous. Reading it all into memory would let one strange
 * site use up the whole process, so this reader stops at the cap and
 * reports that the saved file is only the first part.
 *
 * @param {ReadableStream<Uint8Array>} body - the response stream
 * @param {number} maxBytes - byte limit
 * @returns {Promise<{text: string, truncated: boolean}>}
 */
async function readLimitedBody(body, maxBytes) {
  if (!body) return { text: '', truncated: false };

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    try {
      if (truncated) await reader.cancel();
    } catch { /* the stream may already be closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  const bytes = Buffer.concat(chunks);
  let text = bytes.toString('utf8');
  return { text, truncated };
}

/**
 * Download one web page as text.
 *
 * Failures are returned, not thrown: one dead link should not stop the
 * other nine pages from being saved. The caller gets an ok flag and a
 * short reason it can show in the results list.
 *
 * @param {string} url - page address to download
 * @param {number} timeoutMs - how long to wait before giving up
 * @returns {Promise<{ok: boolean, html: string, error: string, status: number|null, truncated: boolean}>}
 */
async function fetchPage(url, timeoutMs = 15000) {
  const failed = (error, status = null) => ({ ok: false, html: '', error, status, truncated: false });

  try {
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return failed(`HTTP ${response.status}`, response.status);

    const contentType = response.headers.get('content-type') || '';
    if (/^(image|audio|video)\/|application\/(pdf|octet-stream|zip|json)/i.test(contentType)) {
      return failed(`Not an HTML page (${contentType.split(';')[0]})`, response.status);
    }

    const { text, truncated } = await readLimitedBody(response.body, MAX_PAGE_BYTES);
    return { ok: true, html: text, error: '', status: response.status, truncated };
  } catch (error) {
    return failed(error?.name === 'TimeoutError' ? 'Timed out' : String(error?.message || error));
  }
}

/**
 * Add a base tag pointing at the page's original address.
 *
 * Saved pages contain relative links and images like /logo.png. Without
 * a base tag, a browser opened from disk looks for that file on the local
 * drive and finds nothing. The base tag tells it to resolve those paths
 * against the original website instead.
 *
 * @param {string} html - raw HTML of a saved page
 * @param {string} url - the address the HTML came from
 * @returns {string} the HTML with one base tag
 */
function injectBaseTag(html, url) {
  const source = String(html ?? '');
  const safeUrl = String(url ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  const tag = `<base href="${safeUrl}">`;

  if (/<base\b/i.test(source)) {
    return source.replace(/<base\b[^>]*>/gi, tag);
  }
  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/(<head\b[^>]*>)/i, `$1\n  ${tag}`);
  }
  return `${tag}\n${source}`;
}

/**
 * Escape text before putting it into HTML.
 *
 * Page addresses and error messages come from the internet. Writing them
 * straight into a stub file could inject markup, so this function makes
 * them plain text first.
 *
 * @param {string} text - text to make safe for HTML
 * @returns {string} escaped text
 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a small readable HTML file when a page could not be downloaded.
 *
 * A run always produces ten files. When one address is dead, this stub
 * keeps the count honest and explains what went wrong instead of leaving
 * an empty file that looks like a bug.
 *
 * @param {string} url - the address that failed
 * @param {string} error - short reason for the failure
 * @returns {string} a complete HTML document
 */
function errorStub(url, error) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Could not save page</title></head>
<body>
  <h1>Could not save this page</h1>
  <p>The search found this address, but the page could not be downloaded.</p>
  <p><strong>Address:</strong> ${escapeHtml(url)}</p>
  <p><strong>Reason:</strong> ${escapeHtml(error || 'Unknown error')}</p>
</body>
</html>
`;
}

module.exports = { slugify, resolveInside, runFolderName, decodeHtmlEntities, extractHrefs, normalizeResultUrl, uniqueUrls, parseGoogleResults, parseDuckDuckGoResults, looksBlocked, fetchSearchPage, collectResults, searchWeb, readLimitedBody, fetchPage, injectBaseTag, escapeHtml, errorStub };
