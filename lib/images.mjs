import {createHash} from 'node:crypto';
import {MAX_IMAGE_BYTES} from '../public/images.mjs';

export {MAX_IMAGE_BYTES};
export const MAX_NOTE_IMAGES = 50;
export const MAX_NOTE_IMAGE_BYTES = 100 * 1024 * 1024;
export const IMAGE_ID = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;
export class ImageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const invalid = () => { throw new ImageError(415, 'Use a valid PNG, JPEG, GIF or WebP image'); };
function dimensions(width, height) {
  if (!width || !height || width > 8192 || height > 8192 || width * height > 20000000) throw new ImageError(413, 'Images must be at most 8192 pixels per side and 20 megapixels');
}
function animation(width,height,frames) {
  dimensions(width,height);
  if(!Number.isInteger(frames)||frames<1)invalid();
  if(frames>200 || width*height*frames>100000000)throw new ImageError(413,'Animated images must have at most 200 frames and 100 million total frame pixels');
}
function frameFits(width,height,x,y,w,h) {
  dimensions(w,h);
  if(!width||!height||x+w>width||y+h>height)invalid();
}

// Read bounded raster containers, never execute a decoder or accept active SVG/HTML.
// Browser decoding is still responsible for the compressed pixel stream.
export function inspectImage(value, expectedId) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new ImageError(413, 'Each image must be between 1 byte and 5 MiB');
  let type, extension, width, height;
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let offset = 8, data = false, ended = false, declaredFrames, frames=0;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
      if (offset + size + 12 > bytes.length) invalid();
      if (kind === 'IDAT') data = true;
      if(kind==='acTL'){if(size!==8||declaredFrames!==undefined)invalid();declaredFrames=bytes.readUInt32BE(offset+8);animation(width,height,declaredFrames);}
      if(kind==='fcTL') {
        if(size!==26||declaredFrames===undefined)invalid();
        frameFits(width,height,bytes.readUInt32BE(offset+20),bytes.readUInt32BE(offset+24),bytes.readUInt32BE(offset+12),bytes.readUInt32BE(offset+16));
        animation(width,height,++frames);
      }
      offset += size + 12;
      if (kind === 'IEND') { if (size !== 0 || offset !== bytes.length) invalid(); ended = true; break; }
    }
    if (!ended || !data || (declaredFrames!==undefined&&frames!==declaredFrames)) invalid();
    type = 'image/png'; extension = 'png';
  } else if (bytes.length >= 20 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let offset = 2, scan = false;
    while (offset < bytes.length - 2) {
      if (bytes[offset++] !== 255) invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218) { scan = true; break; }
      if (marker === 216 || marker === 217 || marker === 0) invalid();
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) invalid();
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) invalid();
      if ([192, 193, 194].includes(marker)) {
        if (size < 8) invalid();
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      }
      offset += size;
    }
    if (!scan || !width || !height) invalid();
    type = 'image/jpeg'; extension = 'jpg';
  } else if (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.at(-1) === 59) {
    width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8);
    let offset = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0;
    const blocks = () => {
      while (offset < bytes.length) { const size = bytes[offset++]; if (!size) return; offset += size; }
      invalid();
    };
    while (offset < bytes.length - 1) {
      const kind = bytes[offset++];
      if (kind === 33) { offset++; blocks(); }
      else if (kind === 44) {
        if (offset + 9 > bytes.length) invalid();
        const w = bytes.readUInt16LE(offset + 4), h = bytes.readUInt16LE(offset + 6);
        frameFits(width,height,bytes.readUInt16LE(offset),bytes.readUInt16LE(offset+2),w,h);
        const flags = bytes[offset + 8]; offset += 9;
        if (flags & 128) offset += 3 * (1 << ((flags & 7) + 1));
        offset++; blocks(); frames++;animation(width,height,frames);
      } else invalid();
    }
    if (!frames || offset !== bytes.length - 1) invalid();
    type = 'image/gif'; extension = 'gif';
  } else if (bytes.length >= 26 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    let offset = 12, pixels = false,frames=0;
    const pixelDimensions=(kind,start,size)=>{
      let w,h;
      if(kind==='VP8 '&&size>=10&&bytes.subarray(start+3,start+6).equals(Buffer.from([157,1,42]))) {
        w=bytes.readUInt16LE(start+6)&16383;h=bytes.readUInt16LE(start+8)&16383;
      }else if(kind==='VP8L'&&size>=5&&bytes[start]===47){
        const bits=bytes.readUInt32LE(start+1);w=(bits&16383)+1;h=((bits>>>14)&16383)+1;
      }else invalid();
      dimensions(w,h);return [w,h];
    };
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
      if (start + size > bytes.length) invalid();
      if (kind === 'VP8X' && size >= 10) { width = bytes.readUIntLE(start + 4, 3) + 1; height = bytes.readUIntLE(start + 7, 3) + 1; }
      if(kind==='VP8 '||kind==='VP8L') {
        const [w,h]=pixelDimensions(kind,start,size);width??=w;height??=h;
        if(w!==width||h!==height)invalid();pixels=true;
      }
      // Animated WebP stores compressed frames inside ANMF chunks.
      if(kind==='ANMF') {
        if(size<24)invalid();
        const w=bytes.readUIntLE(start+6,3)+1,h=bytes.readUIntLE(start+9,3)+1;
        frameFits(width,height,bytes.readUIntLE(start,3)*2,bytes.readUIntLE(start+3,3)*2,w,h);
        animation(width,height,++frames);
        let inner=start+16,decoded=false;
        while(inner+8<=start+size) {
          const tag=bytes.toString('ascii',inner,inner+4),length=bytes.readUInt32LE(inner+4);
          if(inner+8+length>start+size)invalid();
          if(tag==='VP8 '||tag==='VP8L') {
            const [pw,ph]=pixelDimensions(tag,inner+8,length);
            if(decoded||pw!==w||ph!==h)invalid();decoded=true;
          }
          inner+=8+length+(length%2);
        }
        if(!decoded||inner!==start+size)invalid();pixels=true;
      }
      offset = start + size + (size % 2);
    }
    if (!pixels || offset !== bytes.length || !width || !height) invalid();
    type = 'image/webp'; extension = 'webp';
  } else invalid();
  dimensions(width, height);
  const id = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
  if (expectedId !== undefined && (!IMAGE_ID.test(expectedId) || id !== expectedId)) throw new ImageError(400, 'Image content does not match its identifier');
  return {id, type, size: bytes.length, width, height};
}

export async function readImageBody(req) {
  if (req.headers['content-encoding']) throw new ImageError(415, 'Compressed uploads are not supported');
  if (Number(req.headers['content-length'] ?? 0) > MAX_IMAGE_BYTES) throw new ImageError(413, 'Each image must be at most 5 MiB');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new ImageError(413, 'Each image must be at most 5 MiB');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks), info = inspectImage(bytes);
  if (req.headers['content-type'] !== info.type && req.headers['content-type'] !== 'application/octet-stream') throw new ImageError(415, 'The image type does not match the upload Content-Type');
  return {bytes, info};
}
