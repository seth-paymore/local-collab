import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installImageEvents} from '../public/image-events.mjs';
function setup(){
  const root=new EventTarget(),classes=new Set(),queued=[],messages=[];
  const composer={classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)},contains:node=>node?.inside===true};
  root.querySelector=()=>composer;
  installImageEvents(root,files=>queued.push([...files]),text=>messages.push(text));
  const dispatch=(type,properties)=>{
    const event=new Event(type,{cancelable:true});
    for(const [key,value] of Object.entries(properties))Object.defineProperty(event,key,{value});
    root.dispatchEvent(event);return event;
  };
  return{queued,messages,classes,dispatch};
}
test('file drops prevent browser navigation and clear the drop indicator',()=>{
  const ui=setup(),files=[{name:'screenshot.png'}];
  const over=ui.dispatch('dragover',{dataTransfer:{types:['Files']}});
  assert.ok(over.defaultPrevented);assert.ok(ui.classes.has('is-dragover'));
  const drop=ui.dispatch('drop',{dataTransfer:{files,types:['Files']},target:{closest:()=>false}});
  assert.ok(drop.defaultPrevented);assert.deepEqual(ui.queued,[files]);assert.equal(ui.classes.size,0);
});
test('screenshot paste is handled in the composer without intercepting text or other fields',()=>{
  const ui=setup(),files=[{name:'clipboard.png'}];
  const paste=ui.dispatch('paste',{clipboardData:{files},target:{closest:()=>true}});
  assert.ok(paste.defaultPrevented);assert.deepEqual(ui.queued,[files]);
  const other=ui.dispatch('paste',{clipboardData:{files},target:{closest:()=>false}});assert.equal(other.defaultPrevented,false);
  const text=ui.dispatch('paste',{clipboardData:{files:[]},target:{closest:()=>true}});assert.equal(text.defaultPrevented,false);assert.equal(ui.queued.length,1);
});
test('dropping an image URL cannot navigate away or trigger an automatic external download',()=>{
  const ui=setup();
  const properties={dataTransfer:{files:[],types:['text/uri-list','text/html']},target:{closest:()=>false}};
  assert.ok(ui.dispatch('dragover',properties).defaultPrevented);
  const event=ui.dispatch('drop',properties);
  assert.ok(event.defaultPrevented);assert.equal(ui.queued.length,0);assert.equal(ui.messages.length,1);
  assert.equal(ui.dispatch('dragover',{...properties,target:{closest:()=>true}}).defaultPrevented,false);
});
