import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, normalizeHeader } from '../assets/js/csv.js';

test('splits plain rows and columns', () => {
  assert.deepEqual(parseCSV('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('keeps commas inside quoted fields', () => {
  assert.deepEqual(parseCSV('a,"two, too",c'), [['a', 'two, too', 'c']]);
});

test('keeps newlines inside quoted fields', () => {
  // A coach's Notes field is where multi-line text actually shows up.
  assert.deepEqual(parseCSV('a,"line\nbreak",c'), [['a', 'line\nbreak', 'c']]);
});

test('unescapes doubled quotes', () => {
  assert.deepEqual(parseCSV('a,"he said ""hi""",c'), [['a', 'he said "hi"', 'c']]);
});

test('treats CRLF as a single row terminator', () => {
  assert.deepEqual(parseCSV('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('a trailing newline does not add an empty row', () => {
  assert.equal(parseCSV('a,b\n1,2\n').length, 2);
});

test('preserves ragged rows rather than padding or dropping them', () => {
  assert.deepEqual(parseCSV('a,b,c\n1,2'), [['a', 'b', 'c'], ['1', '2']]);
});

test('preserves empty trailing fields', () => {
  assert.deepEqual(parseCSV('a,,\n'), [['a', '', '']]);
});

test('strips the UTF-8 BOM Google prepends', () => {
  // Left in place it becomes part of the first header cell and header
  // matching fails on the very first column.
  const rows = parseCSV('﻿Player ID,Full Name');
  assert.equal(rows[0][0], 'Player ID');
});

test('empty input yields no rows', () => {
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseCSV(null), []);
});

test('normalizeHeader strips the (auto) marker, case and extra whitespace', () => {
  assert.equal(normalizeHeader('  Player Name (auto) '), 'player name');
  assert.equal(normalizeHeader('Home/Away'), 'home/away');
  assert.equal(normalizeHeader('Full   Name'), 'full name');
});
