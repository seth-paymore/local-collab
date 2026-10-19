// Browser event routing kept separate so navigation protection can be regression tested.
export function installImageEvents(root,onImages,onUnsupported) {
  const composer=()=>root.querySelector('#composer');
  root.addEventListener('paste',event=>{
    if(!event.target.closest?.('#composer')||!event.clipboardData?.files.length)return;
    event.preventDefault();onImages(event.clipboardData.files);
  });
  root.addEventListener('dragover',event=>{
    const types=Array.from(event.dataTransfer?.types??[]);
    if(types.includes('Files')){event.preventDefault();composer()?.classList.add('is-dragover');return;}
    if(types.some(type=>['text/uri-list','text/html'].includes(type))&&!event.target.closest?.('textarea,input'))event.preventDefault();
  });
  root.addEventListener('dragleave',event=>{
    if(!event.relatedTarget||!composer()?.contains(event.relatedTarget))composer()?.classList.remove('is-dragover');
  });
  root.addEventListener('drop',event=>{
    composer()?.classList.remove('is-dragover');
    if(event.dataTransfer?.files.length){event.preventDefault();onImages(event.dataTransfer.files);return;}
    if(Array.from(event.dataTransfer?.types??[]).some(type=>['text/uri-list','text/html'].includes(type))&&!event.target.closest?.('textarea,input')){
      event.preventDefault();onUnsupported('Drop an image file, or paste a screenshot into the note');
    }
  });
}
