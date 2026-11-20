// A small multipart/form-data reader for one file part, working on a whole body Buffer.
// Binary safe: it searches bytes with Buffer.indexOf and never decodes the file content.

/** The boundary from a Content-Type header value, or null. */
export function boundaryOf(contentType) {
  const m = /;\s*boundary\s*=\s*(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i.exec(contentType || '');
  return m ? (m[1] ?? m[2]) : null;
}

const CRLF2 = Buffer.from('\r\n\r\n');

function parseDisposition(headerText) {
  let disposition = '';
  for (const line of headerText.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'content-disposition') disposition = line.slice(i + 1);
  }
  const param = (name) => {
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, 'i').exec(disposition);
    return m ? (m[1] ?? m[2]).replace(/\\(.)/g, '$1') : null;
  };
  return { name: param('name'), filename: param('filename') };
}

/**
 * Find the part named `field` (default "file"). Returns { filename, data } where data is a
 * view into `body` (no copy), or null when there is no such part. Throws Error on a malformed body.
 */
export function findFilePart(body, boundary, field = 'file') {
  const open = Buffer.from('--' + boundary);
  const delim = Buffer.from('\r\n--' + boundary);

  let pos = body.indexOf(open);
  // The opening delimiter must start the body or follow a line break (a preamble is allowed).
  while (pos > 0 && !(body[pos - 1] === 0x0a)) pos = body.indexOf(open, pos + 1);
  if (pos < 0) throw new Error('multipart body has no boundary');
  pos += open.length;

  for (;;) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) return null; // closing delimiter
    // Skip optional trailing whitespace, then the line break after the delimiter.
    while (body[pos] === 0x20 || body[pos] === 0x09) pos++;
    if (body[pos] !== 0x0d || body[pos + 1] !== 0x0a) throw new Error('malformed multipart body');
    pos += 2;

    let headersEnd, headerText;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) { // a part with no headers
      headersEnd = pos; headerText = '';
    } else {
      headersEnd = body.indexOf(CRLF2, pos);
      if (headersEnd < 0) throw new Error('malformed multipart body');
      headerText = body.toString('utf8', pos, headersEnd);
    }
    const dataStart = headersEnd + (headerText ? 4 : 2);
    // A headerless, empty part has its delimiter's CRLF right where the blank line is.
    const next = body.indexOf(delim, headerText ? dataStart : dataStart - 2);
    if (next < 0) throw new Error('multipart body is not terminated');
    const info = parseDisposition(headerText);
    if (info.name === field && info.filename !== null) return { filename: info.filename, data: body.subarray(dataStart, Math.max(dataStart, next)) };
    pos = next + delim.length;
  }
}
