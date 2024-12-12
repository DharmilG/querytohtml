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

module.exports = { slugify, resolveInside };
