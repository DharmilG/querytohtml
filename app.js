'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PICK_TIMEOUT_MS = 120000;
const DECISION_TIMEOUT_MS = 300000;
const decisionWaiters = new Map();

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

/**
 * Choose a file name for one saved page, avoiding clashes.
 *
 * The name starts with the result number, then the website's host, so the
 * files sort in the same order as the search results. If two results come
 * from the same host, a number is added to the second name.
 *
 * @param {string} url - the page address
 * @param {number} index - zero-based position in the results
 * @param {Set<string>} used - names already taken in this run
 * @returns {string} a file name ending in .html
 */
function pageFileName(url, index, used) {
  let host = 'page';
  try {
    host = new URL(url).hostname.replace(/^www\./i, '');
  } catch { /* keep the fallback name */ }

  const base = `${String(index + 1).padStart(2, '0')}-${slugify(host)}.html`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = base.replace(/\.html$/, `-${suffix}.html`);
    suffix += 1;
  }
  used.add(name);
  return name;
}

/**
 * Work out every file name a run will use, before any writing happens.
 *
 * Doing this first lets the caller ask about clashes once, instead of
 * discovering them halfway through a run. The manifest is included so it
 * is covered by the same question.
 *
 * @param {Array<{url: string}>} pages - fetched pages
 * @param {boolean} saveManifest - whether a manifest will be written
 * @returns {string[]} planned file names in write order
 */
function planFileNames(pages, saveManifest = true) {
  const used = new Set();
  const names = pages.map((page, index) => pageFileName(page.url, index, used));
  if (saveManifest) names.push('manifest.json');
  return names;
}

/**
 * Find a free name by adding -2, -3, and so on before the extension.
 *
 * @param {string} folder - folder to check
 * @param {string} name - name that is already taken
 * @returns {Promise<string>} a name that does not exist yet
 */
async function uniqueOnDisk(folder, name) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let suffix = 2;

  while (true) {
    const candidate = `${stem}-${suffix}${extension}`;
    try {
      await fs.access(resolveInside(folder, candidate));
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

/**
 * Save a whole run into the chosen folder.
 *
 * This function owns the file system work: make the base folder, make a
 * run folder that cannot collide with an earlier one, write every page,
 * and write the manifest. It never assumes a page downloaded correctly;
 * the caller passes the fetch result for each one.
 *
 * @param {string} baseFolder - folder the user chose
 * @param {string} query - the search query
 * @param {Array<{url: string, ok: boolean, html: string, error: string}>} pages - fetched pages
 * @param {object} options - time, base tag, manifest, source, notes, placement,
 *   conflictAction, and the pre-planned file names
 * @returns {Promise<{folder: string, name: string, files: Array<object>, manifest: object|null, placement: string}>}
 */
async function writeRunFiles(baseFolder, query, pages, options = {}) {
  const {
    now = new Date(),
    addBaseTag = true,
    saveManifest = true,
    source = 'unknown',
    notes = [],
    complete = false,
    placement = 'subfolder',
    conflictAction = 'overwrite',
    fileNames = null,
  } = options;

  await fs.mkdir(path.resolve(baseFolder), { recursive: true });

  const name = runFolderName(query, now);
  const direct = placement === 'direct';
  let folder = direct ? resolveInside(baseFolder) : resolveInside(baseFolder, name);

  if (!direct) {
    // Two runs started in the same second must not overwrite each other.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.mkdir(folder);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        folder = resolveInside(baseFolder, `${name}-${attempt + 1}`);
      }
    }
  }

  const planned = fileNames || planFileNames(pages, saveManifest);
  const files = [];

  // One rule decides what to do with any name that is already taken.
  const targetName = async (plannedName) => {
    try {
      await fs.access(resolveInside(folder, plannedName));
    } catch {
      return plannedName;
    }
    if (conflictAction === 'skip') return null;
    if (conflictAction === 'rename') return uniqueOnDisk(folder, plannedName);
    return plannedName;
  };

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const fileName = await targetName(planned[index]);

    if (!fileName) {
      files.push({
        name: planned[index],
        url: page.url,
        ok: false,
        error: 'Skipped because the file already exists',
        bytes: 0,
        skipped: true,
      });
      continue;
    }

    const content = page.ok
      ? (addBaseTag ? injectBaseTag(page.html, page.url) : page.html)
      : errorStub(page.url, page.error);

    await fs.writeFile(resolveInside(folder, fileName), content, 'utf8');
    files.push({
      name: fileName,
      url: page.url,
      ok: Boolean(page.ok),
      error: page.error || '',
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  }

  let manifest = null;
  if (saveManifest) {
    const manifestName = await targetName(planned[pages.length] || 'manifest.json');
    if (manifestName) {
      manifest = { query, createdAt: now.toISOString(), source, complete, notes, files, placement };
      await fs.writeFile(
        resolveInside(folder, manifestName),
        JSON.stringify(manifest, null, 2),
        'utf8'
      );
    }
  }

  return { folder, name: direct ? name : path.basename(folder), files, manifest, placement };
}

/**
 * Compute the CRC-32 checksum used by the ZIP format.
 *
 * A ZIP stores a checksum for every file so a reader can tell whether the
 * file arrived intact. This is the standard ZIP polynomial, calculated a
 * byte at a time. It is slow for huge files but our pages are capped at
 * 5 MB each, which is fine.
 *
 * @param {Buffer} buffer - bytes to checksum
 * @returns {number} unsigned 32-bit checksum
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Convert a JavaScript date into the two small numbers ZIP expects.
 *
 * ZIP stores time and date in a packed 16-bit format with 1980 as the
 * starting year. Dates outside 1980-2107 are clamped so the writer never
 * produces a negative number.
 *
 * @param {Date} date - modification time
 * @returns {{time: number, date: number}} packed ZIP values
 */
function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const packedDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: packedDate };
}

/**
 * Build a ZIP archive in memory from a list of named files.
 *
 * This writes the ZIP "store" format: each file is copied without
 * compression. That would waste space on huge files, but HTML compresses
 * well only with extra libraries, and a stored ZIP keeps this app free of
 * dependencies. Windows, macOS, and Linux all open it without trouble.
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries - files to add
 * @param {Date} now - modification time for the entries
 * @returns {Buffer} the finished ZIP file
 */
function buildZip(entries, now = new Date()) {
  const write16 = (buffer, offset, value) => {
    buffer.writeUInt16LE(value, offset);
    return offset + 2;
  };
  const write32 = (buffer, offset, value) => {
    buffer.writeUInt32LE(value, offset);
    return offset + 4;
  };

  const parts = [];
  const directory = [];
  let offset = 0;
  const { time, date } = dosDateTime(now);

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data ?? ''), 'utf8');
    const checksum = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    let p = 0;
    p = write32(local, p, 0x04034b50);
    p = write16(local, p, 20);
    p = write16(local, p, 0x0800);
    p = write16(local, p, 0);
    p = write16(local, p, time);
    p = write16(local, p, date);
    p = write32(local, p, checksum);
    p = write32(local, p, data.length);
    p = write32(local, p, data.length);
    p = write16(local, p, nameBytes.length);
    p = write16(local, p, 0);
    nameBytes.copy(local, p);
    parts.push(local, data);

    const central = Buffer.alloc(46 + nameBytes.length);
    let c = 0;
    c = write32(central, c, 0x02014b50);
    c = write16(central, c, 20);
    c = write16(central, c, 20);
    c = write16(central, c, 0x0800);
    c = write16(central, c, 0);
    c = write16(central, c, time);
    c = write16(central, c, date);
    c = write32(central, c, checksum);
    c = write32(central, c, data.length);
    c = write32(central, c, data.length);
    c = write16(central, c, nameBytes.length);
    c = write16(central, c, 0);
    c = write16(central, c, 0);
    c = write16(central, c, 0);
    c = write16(central, c, 0);
    c = write32(central, c, 0);
    c = write32(central, c, offset);
    nameBytes.copy(central, c);
    directory.push(central);

    offset += local.length + data.length;
  }

  const directorySize = directory.reduce((total, buffer) => total + buffer.length, 0);
  const end = Buffer.alloc(22);
  let e = 0;
  e = write32(end, e, 0x06054b50);
  e = write16(end, e, 0);
  e = write16(end, e, 0);
  e = write16(end, e, entries.length);
  e = write16(end, e, entries.length);
  e = write32(end, e, directorySize);
  e = write32(end, e, offset);
  write16(end, e, 0);

  return Buffer.concat([...parts, ...directory, end]);
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Query to HTML</title>
<style>
*{box-sizing:border-box}
:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#4f46e5;--accent-dark:#4338ca;--good:#15803d;--bad:#b91c1c;--bg:#f1f5f9}
body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:radial-gradient(circle at 12% -10%,#dbeafe 0,transparent 42%),radial-gradient(circle at 100% 0,#ede9fe 0,transparent 40%),linear-gradient(160deg,#f8fafc,#f1f5f9)}
.shell{width:min(100% - 32px,980px);margin:0 auto;padding:28px 0 60px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--ink);color:#fff;padding:16px 22px;border-radius:18px;box-shadow:0 18px 40px -24px rgba(15,23,42,.8)}
.brand{display:flex;align-items:center;gap:12px}
.logo{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#6366f1,#8b5cf6);font-weight:800;font-size:18px}
.brand strong{display:block;font-size:16px;letter-spacing:.2px}
.brand small{display:block;color:#94a3b8;font-size:12px;margin-top:2px}
nav{display:flex;gap:6px;background:rgba(255,255,255,.08);padding:4px;border-radius:12px}
.nav{border:0;background:transparent;color:#cbd5e1;padding:8px 16px;border-radius:9px;font:inherit;font-size:14px;cursor:pointer;transition:.18s}
.nav:hover{color:#fff;background:rgba(255,255,255,.08)}
.nav.active{background:#fff;color:var(--ink);font-weight:600}
.screen{display:none}
.screen.active{display:block;animation:fade .25s ease}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.hero{margin:34px 4px 22px}
.hero h1{font-size:clamp(26px,4vw,38px);line-height:1.15;margin:0 0 10px;letter-spacing:-.8px}
.hero p{margin:0;color:var(--muted);font-size:15px;max-width:620px;line-height:1.6}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 12px 34px -24px rgba(15,23,42,.35);margin-bottom:18px}
.card h2{margin:0 0 4px;font-size:18px}
.card .sub{margin:0 0 20px;color:var(--muted);font-size:13px;line-height:1.5}
.field{display:block;margin-bottom:18px}
.field>span{display:block;font-size:13px;font-weight:600;margin-bottom:8px}
.field small{display:block;color:var(--muted);font-size:12px;margin-top:6px;line-height:1.5}
input,textarea,select{width:100%;border:1px solid var(--line);border-radius:11px;padding:12px 14px;font:inherit;font-size:14px;color:var(--ink);background:#fff;outline:none;transition:.18s}
textarea{resize:vertical;min-height:86px;line-height:1.55}
input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(79,70,229,.12)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.primary{width:100%;border:0;border-radius:12px;background:linear-gradient(135deg,var(--accent),#6d28d9);color:#fff;padding:14px 20px;font:inherit;font-weight:700;font-size:15px;cursor:pointer;box-shadow:0 12px 24px -14px rgba(79,70,229,.9);transition:.18s}
.primary:hover:not(:disabled){filter:brightness(1.07);transform:translateY(-1px)}
.primary:disabled{opacity:.6;cursor:wait}
.secondary{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:11px;padding:11px 18px;font:inherit;font-weight:600;font-size:14px;cursor:pointer;transition:.18s}
.secondary:hover{border-color:var(--accent);color:var(--accent)}
.folder-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.folder-row .secondary{flex:none}
.folder-path{flex:1;min-width:180px;background:#f8fafc;border:1px dashed var(--line);border-radius:11px;padding:11px 12px;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.modal{position:fixed;inset:0;background:rgba(15,23,42,.6);display:grid;place-items:center;padding:20px;z-index:20}
.modal-card{background:#fff;border-radius:18px;padding:26px;width:min(100%,520px);box-shadow:0 30px 70px -20px rgba(0,0,0,.5)}
.modal-card h2{margin:0 0 6px;font-size:20px}
.collision-list{max-height:180px;overflow:auto;background:#f8fafc;border:1px solid var(--line);border-radius:11px;padding:10px 14px;margin:0 0 18px;font-size:13px;color:var(--muted)}
.collision-list li{margin:4px 0}
.hidden{display:none!important}
.progress-top{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:10px}
.progress-top strong{color:var(--accent)}
.track{height:9px;background:#eef2ff;border-radius:99px;overflow:hidden}
.fill{height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#6366f1,#a855f7);transition:width .35s ease}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.pill{background:#f1f5f9;border:1px solid var(--line);border-radius:99px;padding:6px 12px;font-size:12px;color:var(--muted)}
.pill b{color:var(--ink);font-weight:600}
.files{list-style:none;margin:0 0 20px;padding:0;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.files li{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line);font-size:14px}
.files li:last-child{border-bottom:0}
.files li:hover{background:#f8fafc}
.num{width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:9px;background:#eef2ff;color:var(--accent);font-size:12px;font-weight:700}
.file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.file-name a{color:var(--ink);text-decoration:none}
.file-name a:hover{color:var(--accent);text-decoration:underline}
.badge{flex:none;font-size:11px;font-weight:700;padding:4px 9px;border-radius:99px}
.badge.ok{background:#dcfce7;color:var(--good)}
.badge.bad{background:#fee2e2;color:var(--bad)}
.size{flex:none;color:var(--muted);font-size:12px;width:64px;text-align:right}
.actions{display:flex;gap:10px;flex-wrap:wrap}
.note{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:11px;padding:11px 14px;font-size:13px;margin-bottom:16px;line-height:1.5}
.group{border-top:1px solid var(--line);padding-top:18px;margin-top:6px}
.group:first-child{border-top:0;padding-top:0;margin-top:0}
.group h3{margin:0 0 16px;font-size:14px;color:var(--accent);text-transform:uppercase;letter-spacing:.7px}
.switch{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid #f1f5f9}
.switch:last-child{border-bottom:0}
.switch span{font-size:14px}
.switch small{display:block;color:var(--muted);font-size:12px;margin-top:3px}
.toggle{position:relative;width:44px;height:25px;flex:none}
.toggle input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.slider{position:absolute;inset:0;background:#cbd5e1;border-radius:99px;transition:.2s}
.slider:before{content:"";position:absolute;left:3px;top:3px;width:19px;height:19px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:.2s}
.toggle input:checked+.slider{background:var(--accent)}
.toggle input:checked+.slider:before{transform:translateX(19px)}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ink);color:#fff;padding:12px 18px;border-radius:11px;font-size:14px;box-shadow:0 16px 30px -12px rgba(0,0,0,.5);z-index:10;max-width:min(90vw,520px)}
.toast.bad{background:var(--bad)}
@media(max-width:640px){.grid,.grid-2{grid-template-columns:1fr}.topbar{flex-direction:column;align-items:flex-start}.shell{width:min(100% - 20px,980px);padding-top:14px}.card{padding:18px}.size{display:none}}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand"><span class="logo">Q</span><div><strong>Query to HTML</strong><small>Search once. Keep ten pages.</small></div></div>
    <nav><button id="nav-search" class="nav active" type="button">Search</button><button id="nav-settings" class="nav" type="button">Settings</button></nav>
  </header>

  <main>
    <section id="screen-search" class="screen active">
      <div class="hero"><h1>Turn a query into ten saved pages.</h1><p>Choose a folder, pick where the files should go, and decide whether you want HTML files, a ZIP, or both. The app does the searching and saving.</p></div>

      <form id="run-form" class="card">
        <label class="field"><span>Search query</span><textarea id="query" rows="3" placeholder="For example: nodejs stream guide" required></textarea></label>
        <div class="grid">
          <label class="field"><span>Results</span><input id="count" type="number" min="1" max="50" value="10"></label>
          <label class="field"><span>Search source</span><select id="source"><option value="auto">Google, then DuckDuckGo</option><option value="google">Google only</option><option value="duckduckgo">DuckDuckGo only</option></select></label>
          <label class="field"><span>Timeout (seconds)</span><input id="timeout" type="number" min="1" max="120" value="15"></label>
        </div>
        <div class="grid-2">
          <label class="field"><span>Placement</span><select id="placement"><option value="subfolder">New folder each run</option><option value="direct">Directly in chosen folder</option></select></label>
          <label class="field"><span>Output</span><select id="output"><option value="zip">ZIP only</option><option value="html">HTML files only</option><option value="both">HTML files and ZIP</option></select></label>
        </div>
        <div class="field" id="folder-field"><span>Save location</span>
          <div class="folder-row"><button id="pick" class="secondary" type="button">Choose folder</button><span id="folder-path" class="folder-path">No folder chosen</span></div>
          <input id="folder" class="hidden" type="text" placeholder="Type a folder path">
          <small id="folder-hint">A native folder dialog opens on this machine. If one is not available, type a path instead.</small>
        </div>
        <button id="run" class="primary" type="submit">Run search</button>
      </form>

      <section id="progress" class="card hidden">
        <div class="progress-top"><strong id="progress-text">Starting…</strong><span id="progress-count"></span></div>
        <div class="track"><div id="progress-fill" class="fill"></div></div>
      </section>

      <section id="results" class="card hidden">
        <h2>Your pages are saved</h2>
        <p class="sub" id="results-sub"></p>
        <div class="note hidden" id="results-note"></div>
        <div class="meta" id="results-meta"></div>
        <ul class="files" id="file-list"></ul>
        <div class="actions"><button id="zip" class="primary" type="button" style="width:auto">Download ZIP</button><button id="again" class="secondary" type="button">New search</button></div>
      </section>
    </section>

    <section id="screen-settings" class="screen">
      <div class="hero"><h1>Settings</h1><p>These choices stay in this browser. They are used on every run until you change them again.</p></div>
      <form id="settings-form" class="card">
        <div class="group"><h3>Folders</h3>
          <label class="field"><span>Base folder</span><input id="s-base" type="text"><small>New run folders are created inside this folder.</small></label>
          <label class="switch"><span>Ask location each run<small>Show the Save location box before every run.</small></span><span class="toggle"><input id="s-ask" type="checkbox"><span class="slider"></span></span></label>
          <label class="switch"><span>Auto-use last folder<small>Skip the question and reuse the folder from the last run.</small></span><span class="toggle"><input id="s-auto" type="checkbox"><span class="slider"></span></span></label>
        </div>
        <div class="group"><h3>Search</h3>
          <div class="grid-2">
            <label class="field"><span>Results per run</span><input id="s-count" type="number" min="1" max="50"></label>
            <label class="field"><span>Search source</span><select id="s-source"><option value="auto">Google, then DuckDuckGo</option><option value="google">Google only</option><option value="duckduckgo">DuckDuckGo only</option></select></label>
          </div>
          <label class="field"><span>Timeout in seconds</span><input id="s-timeout" type="number" min="1" max="120"></label>
        </div>
        <div class="group"><h3>Saving</h3>
          <label class="switch"><span>Save manifest.json<small>Write a small report with the query, source, and file status.</small></span><span class="toggle"><input id="s-manifest" type="checkbox"><span class="slider"></span></span></label>
          <label class="switch"><span>Add base tag<small>Keep relative links and images working when pages are opened from disk.</small></span><span class="toggle"><input id="s-base-tag" type="checkbox"><span class="slider"></span></span></label>
        </div>
        <div class="actions" style="margin-top:22px"><button class="primary" type="submit" style="width:auto">Save settings</button><button id="reset" class="secondary" type="button">Reset</button></div>
      </form>
    </section>
  </main>
</div>
<div id="collision" class="modal hidden">
  <div class="modal-card">
    <h2>Files with these names already exist</h2>
    <p class="sub">Choose once for all of them. Your answer applies to every file in this run.</p>
    <ul id="collision-list" class="collision-list"></ul>
    <div class="actions">
      <button id="collision-rename" class="primary" type="button" style="width:auto">Save with new name</button>
      <button id="collision-overwrite" class="secondary" type="button">Overwrite</button>
      <button id="collision-skip" class="secondary" type="button">Skip</button>
    </div>
  </div>
</div>
<div id="toast" class="toast hidden"></div>

<script>
(function(){
  'use strict';
  var KEY = 'q2h.settings';
  var defaults = {baseFolder:__Q2H_DEFAULT_BASE__, askEachRun:true, autoFolder:false, count:10, source:'auto', timeout:15, saveManifest:true, addBaseTag:true, lastFolder:'', placement:'subfolder', output:'zip'};
  var settings;
  try { settings = Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch (error) { settings = Object.assign({}, defaults); }

  var byId = function(id){ return document.getElementById(id); };
  var jobId = null;
  var timer = null;
  var lastRun = null;
  var toastTimer = null;
  var chosenFolder = settings.lastFolder || settings.baseFolder || '';
  var folderFallback = false;

  function notify(message, bad){
    var box = byId('toast');
    box.textContent = message;
    box.className = 'toast' + (bad ? ' bad' : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ box.className = 'toast hidden'; }, 5000);
  }

  function showScreen(name){
    byId('screen-search').className = 'screen' + (name === 'search' ? ' active' : '');
    byId('screen-settings').className = 'screen' + (name === 'settings' ? ' active' : '');
    byId('nav-search').className = 'nav' + (name === 'search' ? ' active' : '');
    byId('nav-settings').className = 'nav' + (name === 'settings' ? ' active' : '');
  }

  function saveSettings(){ localStorage.setItem(KEY, JSON.stringify(settings)); }

  function renderSettings(){
    byId('s-base').value = settings.baseFolder || '';
    byId('s-ask').checked = !!settings.askEachRun;
    byId('s-auto').checked = !!settings.autoFolder;
    byId('s-count').value = settings.count;
    byId('s-source').value = settings.source;
    byId('s-timeout').value = settings.timeout;
    byId('s-manifest').checked = !!settings.saveManifest;
    byId('s-base-tag').checked = !!settings.addBaseTag;
  }

  function syncFolderField(){
    byId('folder-field').classList.toggle('hidden', !!settings.autoFolder);
    byId('folder-path').textContent = chosenFolder || 'No folder chosen';
    byId('folder').classList.toggle('hidden', !folderFallback);
    byId('folder').value = chosenFolder;
    byId('count').value = settings.count;
    byId('source').value = settings.source;
    byId('timeout').value = settings.timeout;
    byId('placement').value = settings.placement;
    byId('output').value = settings.output;
    byId('zip').style.display = settings.output === 'html' ? 'none' : '';
  }

  function folderForRun(){
    if (settings.autoFolder) return settings.lastFolder || settings.baseFolder || '';
    return folderFallback ? byId('folder').value.trim() : chosenFolder;
  }

  function chooseFolder(){
    var button = byId('pick');
    button.disabled = true;
    button.textContent = 'Choosing…';
    fetch('/api/pick-folder', {method:'POST'})
      .then(function(response){ return response.json().then(function(data){ return {ok:response.ok, data:data}; }); })
      .then(function(out){
        button.disabled = false;
        button.textContent = 'Choose folder';
        if (!out.ok) {
          folderFallback = true;
          syncFolderField();
          notify(out.data.error || 'Could not open the folder dialog. Type a path instead.', true);
          return;
        }
        if (!out.data.path) { notify('Folder selection cancelled.'); return; }
        chosenFolder = out.data.path;
        folderFallback = false;
        syncFolderField();
        notify('Folder selected.');
      })
      .catch(function(error){
        button.disabled = false;
        button.textContent = 'Choose folder';
        notify(error.message, true);
      });
  }

  function decideCollision(choice){
    byId('collision').classList.add('hidden');
    fetch('/api/decision?id=' + encodeURIComponent(jobId), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({choice:choice})
    }).catch(function(error){ notify(error.message, true); });
  }

  function formatBytes(bytes){
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  function renderResults(result){
    lastRun = result;
    byId('results').classList.remove('hidden');
    byId('results-sub').textContent = 'Saved ' + result.files.length + ' files '
      + (result.placement === 'direct' ? 'directly in the chosen folder.' : 'in a new folder.');
    byId('zip').style.display = settings.output === 'html' ? 'none' : '';
    byId('results-meta').innerHTML = '';
    var meta = [['Source', result.source], ['Query', result.query], ['Folder', result.name]];
    meta.forEach(function(item){
      var pill = document.createElement('span');
      pill.className = 'pill';
      var label = document.createElement('span');
      label.textContent = item[0] + ': ';
      var value = document.createElement('b');
      value.textContent = item[1];
      pill.appendChild(label);
      pill.appendChild(value);
      byId('results-meta').appendChild(pill);
    });

    var note = byId('results-note');
    var messages = (result.notes || []).slice();
    if (!result.complete) messages.push('Fewer than the requested number of pages were found.');
    if (messages.length) {
      note.textContent = messages.join(' ');
      note.classList.remove('hidden');
    } else {
      note.classList.add('hidden');
    }

    var list = byId('file-list');
    list.innerHTML = '';
    result.files.forEach(function(file, index){
      var row = document.createElement('li');
      var number = document.createElement('span');
      number.className = 'num';
      number.textContent = String(index + 1).padStart(2, '0');
      var name = document.createElement('span');
      name.className = 'file-name';
      var link = document.createElement('a');
      link.textContent = file.name;
      link.href = '/view/' + encodeURIComponent(result.name) + '/' + encodeURIComponent(file.name);
      link.target = '_blank';
      link.rel = 'noopener';
      name.appendChild(link);
      var badge = document.createElement('span');
      badge.className = 'badge ' + (file.ok ? 'ok' : 'bad');
      badge.textContent = file.ok ? 'Saved' : 'Error';
      var size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatBytes(file.bytes);
      row.appendChild(number);
      row.appendChild(name);
      row.appendChild(badge);
      row.appendChild(size);
      list.appendChild(row);
    });
  }

  function startRun(){
    var query = byId('query').value.trim();
    var folder = folderForRun();
    if (!query) { notify('Enter a query first.', true); return; }
    if (!folder) { notify('Choose a save location first.', true); return; }

    var payload = {
      query: query,
      folder: folder,
      count: Number(byId('count').value) || 10,
      source: byId('source').value,
      timeout: Number(byId('timeout').value) || 15,
      saveManifest: !!settings.saveManifest,
      addBaseTag: !!settings.addBaseTag,
      placement: byId('placement').value,
      output: byId('output').value
    };
    settings.placement = payload.placement;
    settings.output = payload.output;
    saveSettings();

    byId('run').disabled = true;
    byId('results').classList.add('hidden');
    byId('progress').classList.remove('hidden');
    byId('progress-text').textContent = 'Starting…';
    byId('progress-fill').style.width = '4%';
    byId('progress-count').textContent = '';

    fetch('/api/run', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
      .then(function(response){ return response.json().then(function(data){ return {ok:response.ok, data:data}; }); })
      .then(function(out){
        if (!out.ok || !out.data.jobId) throw new Error(out.data.error || 'Could not start the run.');
        jobId = out.data.jobId;
        timer = setInterval(poll, 400);
        poll();
      })
      .catch(function(error){ fail(error.message); });
  }

  function poll(){
    if (!jobId) return;
    fetch('/api/status?id=' + encodeURIComponent(jobId))
      .then(function(response){ return response.json(); })
      .then(function(status){
        if (status.state === 'awaiting') {
          byId('progress-text').textContent = 'Waiting for your answer…';
          byId('collision-list').innerHTML = '';
          (status.conflicts || []).forEach(function(name){
            var item = document.createElement('li');
            item.textContent = name;
            byId('collision-list').appendChild(item);
          });
          byId('collision').classList.remove('hidden');
          return;
        }
        if (status.state === 'running') {
          byId('progress-text').textContent = status.message || 'Working…';
          var total = status.total || 1;
          var percent = Math.max(4, Math.min(100, Math.round(((status.done || 0) / (total + 1)) * 100)));
          byId('progress-fill').style.width = percent + '%';
          byId('progress-count').textContent = (status.done || 0) + ' / ' + total;
          return;
        }
        clearInterval(timer);
        timer = null;
        byId('collision').classList.add('hidden');
        byId('progress').classList.add('hidden');
        byId('run').disabled = false;
        if (status.state === 'error') { notify(status.error || 'The run failed.', true); return; }
        settings.lastFolder = status.result.folderPath || folderForRun();
        saveSettings();
        renderResults(status.result);
        notify('Done. ' + status.result.files.length + ' files saved.');
      })
      .catch(function(error){ fail(error.message); });
  }

  function fail(message){
    clearInterval(timer);
    timer = null;
    byId('run').disabled = false;
    byId('progress').classList.add('hidden');
    notify(message, true);
  }

  byId('pick').addEventListener('click', chooseFolder);
  byId('collision-rename').addEventListener('click', function(){ decideCollision('rename'); });
  byId('collision-overwrite').addEventListener('click', function(){ decideCollision('overwrite'); });
  byId('collision-skip').addEventListener('click', function(){ decideCollision('skip'); });
  byId('nav-search').addEventListener('click', function(){ showScreen('search'); });
  byId('nav-settings').addEventListener('click', function(){ renderSettings(); showScreen('settings'); });
  byId('run-form').addEventListener('submit', function(event){ event.preventDefault(); startRun(); });
  byId('again').addEventListener('click', function(){ byId('results').classList.add('hidden'); byId('query').focus(); });
  byId('zip').addEventListener('click', function(){
    if (!lastRun) return;
    window.location.href = '/api/zip?run=' + encodeURIComponent(lastRun.name);
  });
  byId('settings-form').addEventListener('submit', function(event){
    event.preventDefault();
    settings.baseFolder = byId('s-base').value.trim();
    settings.askEachRun = byId('s-ask').checked;
    settings.autoFolder = byId('s-auto').checked;
    settings.count = Number(byId('s-count').value) || 10;
    settings.source = byId('s-source').value;
    settings.timeout = Number(byId('s-timeout').value) || 15;
    settings.saveManifest = byId('s-manifest').checked;
    settings.addBaseTag = byId('s-base-tag').checked;
    saveSettings();
    syncFolderField();
    showScreen('search');
    notify('Settings saved.');
  });
  byId('reset').addEventListener('click', function(){
    settings = Object.assign({}, defaults);
    chosenFolder = settings.baseFolder;
    folderFallback = false;
    saveSettings();
    renderSettings();
    syncFolderField();
    notify('Settings reset.');
  });

  renderSettings();
  syncFolderField();
})();
</script>
</body>
</html>`;

const DEFAULT_BASE_DIR = process.env.Q2H_BASE || path.join(__dirname, 'downloads');
const MAX_REQUEST_BYTES = 1024 * 1024;
const jobs = new Map();
const runs = new Map();
let jobCounter = 0;

/**
 * Write a JSON response.
 *
 * @param {http.ServerResponse} response - the response to answer
 * @param {number} status - HTTP status code
 * @param {object} data - object to send
 */
function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

/**
 * Read and parse a JSON request body, with a size limit.
 *
 * @param {http.IncomingMessage} request - the incoming request
 * @returns {Promise<object>} the parsed body
 */
async function readJson(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw new Error('Request is too large');
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Keep a number inside a range, so browser input cannot send silly values.
 *
 * @param {number} value - value to clamp
 * @param {number} low - smallest allowed value
 * @param {number} high - largest allowed value
 * @returns {number} the clamped value
 */
function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/**
 * Describe the native folder dialog command for a given platform.
 *
 * Keeping the command choice separate from running it makes the logic
 * easy to check without opening a real dialog. All arguments are passed
 * as an array, so nothing from the browser is ever put into a shell.
 *
 * @param {string} platform - Node platform name, such as win32 or darwin
 * @returns {{command: string, args: string[]}|null} command, or null if unsupported
 */
function folderPickerCommand(platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-STA',
        '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Choose the download folder'; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
      ],
    };
  }

  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: [
        '-e', 'tell application "System Events" to activate',
        '-e', 'set chosenFolder to POSIX path of (choose folder)',
        '-e', 'return chosenFolder',
      ],
    };
  }

  return null;
}

/**
 * Open a native folder dialog and return the folder the user chose.
 *
 * The dialog runs on the machine hosting the app. That is the user's own
 * machine when the app is run locally. On a server with no screen there is
 * no dialog to open, so the caller falls back to a typed path. Cancelling
 * returns a null path, which is not an error.
 *
 * @returns {Promise<{ok: boolean, path: string|null, error: string, cancelled: boolean}>}
 */
async function pickFolder() {
  const command = folderPickerCommand();
  if (!command) {
    return {
      ok: false,
      path: null,
      error: 'No native folder dialog is available on this system. Type a folder path instead.',
      cancelled: false,
    };
  }

  try {
    const { stdout } = await execFileAsync(command.command, command.args, {
      timeout: PICK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const rawPath = lines.length ? lines[lines.length - 1] : '';
    if (!rawPath) return { ok: true, path: null, error: '', cancelled: true };

    const selected = path.normalize(rawPath).replace(/[\\/]+$/, '') || path.parse(rawPath).root;
    const info = await fs.stat(selected);
    if (!info.isDirectory()) {
      return { ok: false, path: null, error: 'That selection is not a folder.', cancelled: false };
    }
    return { ok: true, path: selected, error: '', cancelled: false };
  } catch (error) {
    if (error?.killed || error?.code === 'ETIMEDOUT') {
      return { ok: true, path: null, error: '', cancelled: true };
    }
    if (process.platform === 'darwin' && /cancel/i.test(String(error?.stderr || ''))) {
      return { ok: true, path: null, error: '', cancelled: true };
    }
    return { ok: false, path: null, error: String(error?.message || error), cancelled: false };
  }
}

/**
 * Answer a request to open the folder dialog.
 *
 * @param {http.ServerResponse} response - the response to answer
 * @returns {Promise<void>}
 */
async function handlePickFolder(response) {
  const picked = await pickFolder();
  if (!picked.ok) {
    sendJson(response, 400, { error: picked.error });
    return;
  }
  sendJson(response, 200, { path: picked.path, cancelled: picked.cancelled });
}

/**
 * List the target names that already exist in a folder.
 *
 * @param {string} folder - folder that will receive the files
 * @param {string[]} names - file names planned for this run
 * @returns {Promise<string[]>} names that are already taken
 */
async function findConflicts(folder, names) {
  const conflicts = [];
  for (const name of names) {
    try {
      await fs.access(resolveInside(folder, name));
      conflicts.push(name);
    } catch {
      // A missing file is exactly what we want, so there is nothing to do.
    }
  }
  return conflicts;
}

/**
 * Pause a run and wait for the user's single answer about conflicts.
 *
 * The job is marked awaiting so the polling page can show the question.
 * A promise holds the run open until the browser posts a decision. If no
 * answer arrives, saving under a new name is used because it destroys no
 * existing file.
 *
 * @param {string} jobId - id of the paused job
 * @param {object} job - mutable job state
 * @param {string[]} conflicts - names that already exist
 * @param {number} timeoutMs - how long to wait before choosing rename
 * @returns {Promise<'rename'|'overwrite'|'skip'>} the chosen action
 */
function askForDecision(jobId, job, conflicts, timeoutMs = DECISION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (choice) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      decisionWaiters.delete(jobId);
      job.state = 'running';
      job.conflicts = [];
      job.message = 'Writing files…';
      resolve(choice);
    };

    timer = setTimeout(() => finish('rename'), timeoutMs);
    decisionWaiters.set(jobId, finish);
    job.conflicts = conflicts;
    job.state = 'awaiting';
    job.message = 'Waiting for your answer…';
  });
}

/**
 * Answer the question a paused run is waiting on.
 *
 * @param {http.ServerResponse} response - the response to answer
 * @param {URL} url - request URL containing the job id
 * @param {object} body - request body containing the choice
 */
function handleDecision(response, url, body) {
  const jobId = url.searchParams.get('id') || '';
  const finish = decisionWaiters.get(jobId);
  if (!finish) {
    sendJson(response, 404, { error: 'No question is waiting for this job.' });
    return;
  }

  const choice = ['rename', 'overwrite', 'skip'].includes(body.choice) ? body.choice : '';
  if (!choice) {
    sendJson(response, 400, { error: 'Choose rename, overwrite, or skip.' });
    return;
  }

  finish(choice);
  sendJson(response, 200, { ok: true });
}

/**
 * Build a ZIP for a run and save a copy beside its files.
 *
 * Both the run engine and the download button need this, so it lives in
 * one function. Renamed manifests are accepted as well as manifest.json,
 * because direct placement may have given the manifest a new name.
 *
 * @param {string} folder - folder holding the run files
 * @param {string} name - run name used for the archive file
 * @returns {Promise<{buffer: Buffer, path: string, bytes: number}>}
 */
async function createRunZip(folder, name) {
  const names = (await fs.readdir(folder))
    .filter((file) => /\.html$/i.test(file) || /^manifest.*\.json$/i.test(file))
    .sort();
  const entries = [];
  for (const file of names) {
    entries.push({ name: file, data: await fs.readFile(resolveInside(folder, file)) });
  }

  const buffer = buildZip(entries, new Date());
  const archivePath = resolveInside(folder, `${name}.zip`);
  await fs.writeFile(archivePath, buffer);
  return { buffer, path: archivePath, bytes: buffer.length };
}

/**
 * Do one run in the background and keep its progress in the job map.
 *
 * The browser starts a job and then asks for its status. Keeping the work
 * here means the HTTP response is immediate, while the poll endpoint can
 * report each step. Any failure is stored on the job instead of crashing
 * the server.
 *
 * @param {string} jobId - id of this job
 * @param {object} job - mutable job state
 * @param {object} options - validated run options
 * @returns {Promise<void>}
 */
async function executeRun(jobId, job, options) {
  try {
    job.message = 'Searching for results…';
    const search = await searchWeb(options.query, options.count, options.source, options.timeout);
    if (search.urls.length === 0) {
      throw new Error(search.notes.join(' ') || 'No results found. Try another query or source.');
    }

    job.total = search.urls.length;
    const pages = [];
    for (let index = 0; index < search.urls.length; index += 1) {
      job.message = `Fetching page ${index + 1} of ${search.urls.length}…`;
      job.done = index;
      const page = await fetchPage(search.urls[index], options.timeout);
      page.url = search.urls[index];
      pages.push(page);
      job.done = index + 1;
    }

    const fileNames = planFileNames(pages, options.saveManifest);
    let conflictAction = 'overwrite';
    if (options.placement === 'direct') {
      const conflicts = await findConflicts(options.folder, fileNames);
      if (conflicts.length) {
        job.message = 'Waiting for your answer about existing files…';
        conflictAction = await askForDecision(jobId, job, conflicts);
      }
    }

    job.message = 'Writing files…';
    const run = await writeRunFiles(options.folder, options.query, pages, {
      now: new Date(),
      source: search.source,
      notes: search.notes,
      complete: search.complete,
      saveManifest: options.saveManifest,
      addBaseTag: options.addBaseTag,
      placement: options.placement,
      conflictAction,
      fileNames,
    });

    runs.set(run.name, {
      folder: run.folder,
      base: options.folder,
      createdAt: new Date().toISOString(),
    });

    let zipName = '';
    if (options.output !== 'html') {
      job.message = 'Building ZIP…';
      zipName = `${run.name}.zip`;
      await createRunZip(run.folder, run.name);
    }

    job.result = {
      name: run.name,
      folderPath: run.folder,
      query: options.query,
      source: search.source,
      complete: search.complete,
      notes: search.notes,
      files: run.files,
      placement: options.placement,
      output: options.output,
      zipName,
    };
    job.state = 'done';
    job.message = 'Done.';
  } catch (error) {
    job.state = 'error';
    job.error = String(error?.message || error);
  }
}

/**
 * Start a run and return its job id straight away.
 *
 * @param {http.ServerResponse} response - the response to answer
 * @param {object} body - request body from the browser
 * @returns {Promise<void>}
 */
async function handleRun(response, body) {
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const folder = typeof body.folder === 'string' ? body.folder.trim() : '';
  if (!query || !folder) {
    sendJson(response, 400, { error: 'A query and a save location are required.' });
    return;
  }

  const source = ['auto', 'google', 'duckduckgo'].includes(body.source) ? body.source : 'auto';
  const placement = ['subfolder', 'direct'].includes(body.placement) ? body.placement : 'subfolder';
  const output = ['zip', 'html', 'both'].includes(body.output) ? body.output : 'zip';
  const options = {
    query,
    folder: path.resolve(folder),
    count: clamp(Number(body.count) || 10, 1, 50),
    timeout: clamp(Number(body.timeout) || 15, 1, 120) * 1000,
    source,
    saveManifest: body.saveManifest !== false,
    addBaseTag: body.addBaseTag !== false,
    placement,
    output,
  };

  const jobId = `job-${jobCounter += 1}`;
  const job = {
    state: 'running',
    message: 'Starting…',
    done: 0,
    total: options.count,
    result: null,
    error: '',
  };
  jobs.set(jobId, job);
  sendJson(response, 200, { jobId });

  executeRun(jobId, job, options).catch((error) => {
    job.state = 'error';
    job.error = String(error?.message || error);
  });
}

/**
 * Report the current state of a job.
 *
 * @param {http.ServerResponse} response - the response to answer
 * @param {URL} url - request URL containing the job id
 */
function handleStatus(response, url) {
  const job = jobs.get(url.searchParams.get('id') || '');
  if (!job) {
    sendJson(response, 404, { error: 'Unknown job.' });
    return;
  }

  sendJson(response, 200, {
    state: job.state,
    message: job.message,
    done: job.done,
    total: job.total,
    error: job.error,
    result: job.result,
    conflicts: job.conflicts || [],
  });
}

/**
 * Build and send a ZIP of one completed run.
 *
 * The archive is also written into the run folder, so the user has a copy
 * on disk as well as a download. Only saved HTML files and the manifest
 * are included; a ZIP from an earlier download is skipped.
 *
 * @param {http.ServerResponse} response - the response to answer
 * @param {URL} url - request URL containing the run name
 * @returns {Promise<void>}
 */
async function handleZip(response, url) {
  const name = url.searchParams.get('run') || '';
  const run = runs.get(name);
  if (!run) {
    sendJson(response, 404, { error: 'Unknown run.' });
    return;
  }

  try {
    const archive = await createRunZip(run.folder, name);

    response.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${name}.zip"`,
      'Content-Length': archive.bytes,
    });
    response.end(archive.buffer);
  } catch (error) {
    sendJson(response, 500, { error: String(error?.message || error) });
  }
}

/**
 * Serve one saved file so it can be opened in a new browser tab.
 *
 * The run name is looked up in the runs map, so a visitor cannot guess a
 * path and read files from elsewhere on the machine.
 *
 * @param {http.ServerResponse} response - the response to answer
 * @param {string} pathname - path of the form /view/RUN/FILE
 * @returns {Promise<void>}
 */
async function handleView(response, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'view') {
    sendJson(response, 404, { error: 'Unknown file.' });
    return;
  }

  const run = runs.get(decodeURIComponent(parts[1]));
  if (!run) {
    sendJson(response, 404, { error: 'Unknown run.' });
    return;
  }

  const file = decodeURIComponent(parts[2]);
  if (!/\.html$/i.test(file) && file !== 'manifest.json') {
    sendJson(response, 400, { error: 'Only saved HTML files can be viewed.' });
    return;
  }

  try {
    const data = await fs.readFile(resolveInside(run.folder, file));
    const type = file === 'manifest.json'
      ? 'application/json; charset=utf-8'
      : 'text/html; charset=utf-8';
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    response.end(data);
  } catch (error) {
    sendJson(response, 404, { error: String(error?.message || error) });
  }
}

/**
 * Start the HTTP server and return it.
 *
 * The port comes from the environment so free hosts can choose one; on a
 * personal machine it defaults to 3000. Binding 0.0.0.0 rather than
 * localhost is what makes the app reachable from outside a container.
 *
 * @returns {http.Server} the running server
 */
function startServer() {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');

      if (request.method === 'GET' && url.pathname === '/') {
        const page = PAGE.replace('__Q2H_DEFAULT_BASE__', JSON.stringify(DEFAULT_BASE_DIR));
        const body = Buffer.from(page, 'utf8');
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': body.length,
        });
        response.end(body);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/pick-folder') {
        await handlePickFolder(response);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/decision') {
        handleDecision(response, url, await readJson(request));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/run') {
        await handleRun(response, await readJson(request));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/status') {
        handleStatus(response, url);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/zip') {
        await handleZip(response, url);
        return;
      }

      if (request.method === 'GET' && url.pathname.startsWith('/view/')) {
        await handleView(response, url.pathname);
        return;
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, 500, { error: String(error?.message || error) });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Query to HTML is running at http://localhost:${port}`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { slugify, resolveInside, runFolderName, decodeHtmlEntities, extractHrefs, normalizeResultUrl, uniqueUrls, parseGoogleResults, parseDuckDuckGoResults, looksBlocked, fetchSearchPage, collectResults, searchWeb, readLimitedBody, fetchPage, injectBaseTag, escapeHtml, errorStub, pageFileName, planFileNames, uniqueOnDisk, writeRunFiles, crc32, dosDateTime, buildZip, PAGE, sendJson, readJson, clamp, folderPickerCommand, pickFolder, handlePickFolder, findConflicts, askForDecision, handleDecision, createRunZip, executeRun, handleRun, handleStatus, handleZip, handleView, startServer };
