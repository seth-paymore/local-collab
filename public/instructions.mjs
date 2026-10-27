export function installInstructionsEditor({api,toast}) {
  const dialog=document.querySelector('#instructions-dialog');
  const form=document.querySelector('#instructions-form');
  const editor=document.querySelector('#instructions-text');
  const error=document.querySelector('#instructions-error');
  const save=document.querySelector('#instructions-save');
  let version=null,loaded=false,busy=false,savedText='';
  async function load() {
    const value=await api('/instructions');
    version=value.version;editor.value=value.text;savedText=value.text;loaded=true;
  }
  document.querySelector('#shared-instructions').addEventListener('click',async()=>{
    if(busy)return;
    error.textContent='';dialog.showModal();
    if(!loaded){editor.disabled=true;save.disabled=true;try{await load();}catch(e){error.textContent=e.message;}finally{editor.disabled=false;save.disabled=!loaded;}}
    editor.focus();
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!loaded)return;
    busy=true;save.disabled=true;error.textContent='';
    try {
      const value=await api('/instructions',{method:'PUT',body:{text:editor.value,version}});
      version=value.version;editor.value=value.text;savedText=value.text;
      toast('Shared instructions saved. Sync AGENTS.md to use them.');
    }catch(e){error.textContent=e.message+'. Your text is kept. Reload to review the current shared version.';}
    finally{busy=false;save.disabled=false;}
  });
  document.querySelector('#instructions-reload').addEventListener('click',async()=>{
    if(busy)return;
    if(loaded&&!window.confirm('Replace this editor text with the latest shared instructions?'))return;
    try{await load();save.disabled=false;error.textContent='';}catch(e){error.textContent=e.message;}
  });
  document.querySelector('#instructions-close').addEventListener('click',()=>{if(!busy)dialog.close();});
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});
  window.addEventListener('beforeunload',event=>{if(busy||(loaded&&editor.value!==savedText)){event.preventDefault();event.returnValue='';}});
}
