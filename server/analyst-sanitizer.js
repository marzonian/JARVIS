'use strict';

function asText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n');
}

function stripLeadingVerdictToken(input) {
  let txt = asText(input).trim();
  let changed = true;
  while (changed && txt) {
    const next = txt
      .replace(/^\s*\[\s*(?:DON['’]T\s*TRADE|DONT\s*TRADE|DO\s*NOT\s*TRADE|WAIT|TRADE)\s*\]\s*[.\-:]*\s*/i, '')
      .replace(/^\s*(?:DON['’]T\s*TRADE|DONT\s*TRADE|DO\s*NOT\s*TRADE|WAIT|TRADE)\s*[.\-:]*\s*/i, '')
      .trimStart();
    changed = next !== txt;
    txt = next;
  }
  return txt.trim();
}

function sanitizeAnalystReply(text) {
  let txt = stripLeadingVerdictToken(text);

  txt = txt
    .replace(/\bWAIT\s*:\s*/gi, 'Also, ')
    .replace(/\b(?:DON['’]T\s*TRADE|DONT\s*TRADE|DO\s*NOT\s*TRADE)\s*:\s*/gi, 'Also, ')
    .replace(/\bTRADE\s*:\s*/gi, 'Also, ')
    .replace(/\bSTANCE\s*:\s*/gi, '')
    .replace(/\b(?:DON['’]T\s*TRADE|DONT\s*TRADE|DO\s*NOT\s*TRADE)\b/gi, 'stand down')
    .replace(/(^|[\n.?!]\s*)WAIT\b[.\-]?\s*/gi, '$1')
    .replace(/(^|[\n.?!]\s*)TRADE\b[.\-]?\s*/gi, '$1')
    .replace(/\[(.*?)\]/g, '($1)')
    .replace(/\s+\)/g, ')')
    .replace(/\(\s+/g, '(')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Hard guard: no square brackets in final analyst output.
  txt = txt.replace(/\[/g, '(').replace(/\]/g, ')').trim();

  const startsWithLetter = /^[A-Za-z]/.test(txt);
  const abruptStart = /^(also|and|but|because|outside|we(?:'|’)re|currently|then|meanwhile)\b/i.test(txt);
  if (!txt || !startsWithLetter || abruptStart) {
    const preface = 'Right now the better move is to stand down.';
    txt = txt ? `${preface} ${txt}` : preface;
  }

  return txt
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  sanitizeAnalystReply,
};
