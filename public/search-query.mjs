// Literal, case-insensitive terms shared by search and browser highlighting.
// Quotes keep a phrase together; unquoted words can appear anywhere in a note.
export function searchTerms(query) {
  return [...new Set(Array.from(String(query ?? '').trim().toLowerCase().matchAll(/"([^"]+)"|(\S+)/gu),
    match => (match[1] ?? match[2]).replace(/\s+/gu, ' ').trim()).filter(Boolean))];
}

export function highlightSearch(text, query) {
  const escape = value => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const terms = searchTerms(query).sort((a,b) => b.length-a.length);
  if (!terms.length) return escape(String(text));
  const pattern = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+')).join('|'), 'giu');
  let html = '', from = 0;
  for (const match of String(text).matchAll(pattern)) {
    html += escape(String(text).slice(from, match.index)) + `<mark>${escape(match[0])}</mark>`;
    from = match.index + match[0].length;
  }
  return html + escape(String(text).slice(from));
}
