/**
 * Minimal RFC 4180 CSV parser.
 *
 * Google serves sheet exports as CSV, and a coach's free-text Notes field is the
 * one place commas, quotes and newlines reliably show up — so this handles the
 * full quoting rules rather than splitting on commas.
 */

/**
 * Parse CSV text into an array of rows, each an array of cell strings.
 * Ragged rows are preserved as-is; callers pad against the header.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCSV(text) {
  if (typeof text !== 'string' || text === '') return [];

  // Strip a UTF-8 BOM; Google includes one and it would otherwise become part
  // of the first header cell, breaking header matching on the very first column.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldWasQuoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '' && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      fieldWasQuoted = false;
    } else if (ch === '\n' || ch === '\r') {
      // Treat CRLF as a single terminator.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldWasQuoted = false;
    } else {
      field += ch;
    }
  }

  // A trailing newline should not manufacture an empty final row, but a file
  // ending mid-field should still yield that field.
  if (field !== '' || fieldWasQuoted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Normalize a header cell for comparison: trim, collapse inner whitespace,
 * drop a trailing "(auto)" marker, and lowercase.
 *
 * The sheet labels lookup columns "Player Name (auto)"; the site ignores those
 * columns but still has to recognize the header row that contains them.
 *
 * @param {string} cell
 * @returns {string}
 */
export function normalizeHeader(cell) {
  return String(cell == null ? '' : cell)
    .replace(/\s*\((?:auto|automatic)\)\s*$/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}
