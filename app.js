'use strict';

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

module.exports = { slugify };
