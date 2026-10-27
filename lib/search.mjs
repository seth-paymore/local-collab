import {searchTerms} from '../public/search-query.mjs';

const normalize = text => String(text ?? '').toLowerCase().replace(/\s+/gu, ' ').trim();

// Rank before limiting. Modification time breaks ties, never outranks relevance.
export function searchRecords(records, query) {
  const terms = searchTerms(query);
  if (!terms.length || terms.join(' ').length < 2) return [];
  const phrase = terms.join(' ');
  const matches = [];
  for (const {note, raw, modified} of records) {
    const title = normalize(note.title);
    const body = normalize(raw);
    const haystack = `${normalize(note.file)} ${normalize(note.ticket)} ${title} ${body}`;
    const ticketMatch = term => Boolean(note.ticket) &&
      [note.ticket, `#${note.ticket}`, `ac-${note.ticket}`, `ac-${note.ticket}.md`].includes(term);
    if (!terms.every(term => haystack.includes(term) || ticketMatch(term))) continue;
    const exactTicket = terms.length === 1 && Boolean(note.ticket) &&
      [note.ticket, `#${note.ticket}`, `ac-${note.ticket}`, `ac-${note.ticket}.md`].includes(terms[0]);
    // #123 is a ticket reference, including when combined with other words.
    if (terms.some(term => /^#\d+$/.test(term) && term.slice(1) !== note.ticket && !body.includes(term))) continue;
    const titleTerms = terms.filter(term => title.includes(term)).length;
    const tier = exactTicket ? 6 : title === phrase ? 5 : title.includes(phrase) ? 4 :
      titleTerms === terms.length ? 3 : body.includes(phrase) ? 2 : 1;
    matches.push({file:note.file, ticket:note.ticket, title:note.title, status:note.status,
      score:tier * 100 + Math.round(20 * titleTerms / terms.length),
      hits:excerpts(raw, terms), modified});
  }
  return matches.sort((a,b) => b.score-a.score || b.modified-a.modified || a.file.localeCompare(b.file))
    .slice(0,60).map(({modified, ...result}) => result);
}

function excerpts(raw, terms) {
  const source=raw.replace(/\r\n/g,'\n');
  const bodyStart=source.match(/^---\n[\s\S]*?\n---\n?/)?.[0].length ?? 0;
  const candidates = [];
  // Keep source line numbers, include adjacent context, and center windows on
  // matches far into long entries. Quoted phrases can span whitespace/newlines.
  const starts=new Set();
  for (const term of terms) {
    const pattern=new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/gu,'\\s+'),'giu');
    let count=0;
    for (const match of source.slice(bodyStart).matchAll(pattern)) {
      if (++count>30) break;
      const position=bodyStart+match.index;
      const start=Math.max(bodyStart,position-70);
      if (starts.has(start)) continue;
      starts.add(start);
      const end=Math.min(source.length,Math.max(start+240,position+match[0].length));
      let text=source.slice(start,end).replace(/\s+/gu,' ').trim();
      if (start>bodyStart) text='…'+text;
      if (end<source.length) text+='…';
      const found=terms.filter(term=>normalize(text).includes(term));
      const line=source.slice(0,start).split('\n').length;
      candidates.push({line,text,found,start});
    }
  }
  const hits=[], covered=new Set();
  while (candidates.length && hits.length<3) {
    candidates.sort((a,b) => {
      const weight = hit => hit.found.filter(term=>!covered.has(term)).length*10 + hit.found.length;
      return weight(b)-weight(a) || a.line-b.line || a.start-b.start;
    });
    const best=candidates.shift();
    if (!best.found.length) continue;
    hits.push({line:best.line,text:best.text});
    best.found.forEach(term=>covered.add(term));
    // Avoid showing overlapping windows of the same context.
    for (let i=candidates.length-1;i>=0;i--) {
      if (Math.abs(candidates[i].start-best.start)<170) candidates.splice(i,1);
    }
  }
  return hits;
}
