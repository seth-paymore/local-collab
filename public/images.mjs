export const MAX_IMAGE_BYTES=5*1024*1024;
export const IMAGE_MARKDOWN=/!\[([^\]\n]*)\]\((\/api\/notes\/[a-z0-9][a-z0-9-]{0,80}\.md\/attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp))\)/g;
const PATH=/^\/api\/notes\/[a-z0-9][a-z0-9-]{0,80}\.md\/attachments\/[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function imageMarkdown(name,path) {
  if(!PATH.test(path))throw new Error('Invalid image reference');
  const alt=String(name||'Image').replace(/[\[\]\\`\r\n\u0000-\u001f]/g,'_').slice(0,160);
  return `![${alt}](${path})`;
}
export function imageHtml(alt,path) {
  if(!PATH.test(path))throw new Error('Invalid image reference');
  return `<a class="note-image-link" href="${path}" target="_blank" rel="noopener noreferrer"><img class="note-image" src="${path}" alt="${escape(String(alt).replace(/\u0000/g,''))}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>`;
}
export function imageType(bytes) {
  const starts=values=>values.every((value,index)=>bytes[index]===value);
  const ascii=(start,end)=>String.fromCharCode(...bytes.slice(start,end));
  if(starts([137,80,78,71,13,10,26,10]))return 'image/png';
  if(starts([255,216,255]))return 'image/jpeg';
  if(/^GIF8[79]a$/.test(ascii(0,6)))return 'image/gif';
  if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')return 'image/webp';
  return null;
}
