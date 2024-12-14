'use strict';

const path = require('node:path');

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

module.exports = { slugify, resolveInside, runFolderName, decodeHtmlEntities, extractHrefs, normalizeResultUrl, uniqueUrls, parseGoogleResults };
