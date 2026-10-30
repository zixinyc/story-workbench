import test, {after} from 'node:test';
import JSZip from 'jszip';
globalThis.JSZip=JSZip;
import assert from 'node:assert/strict';
import {paragraphBodyBounds,resolveParagraphDropTarget} from '../src/editor/paragraph-drop-target.ts';
import {createDemoProject,validateProject} from '../src/domain/model/project.mjs';
import {createParagraphGroup,moveParagraphs,setMusicRange,musicRangeParagraphIds,reconcileChapterDocument} from '../src/domain/model/chapters.mjs';
import {defaultSettings,compileDocument} from '../src/domain/model/document.mjs';
import {createProjectArchive,readProjectArchive} from '../src/persistence/archive.mjs';
import {getSchema} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import {EditorState} from '@tiptap/pm/state';
import {history,undo,redo} from '@tiptap/pm/history';
import {StoryAttributes,CueMark,toEditorContent,fromEditorContent,moveEditorParagraphs} from '../src/editor/story-editor.ts';

const NativeElement=globalThis.Element;
class ElementFixture {
  constructor(tag,dataset={},rect={top:0,bottom:0,height:0}){this.tagName=tag;this.dataset=dataset;this.rect=rect;this.childNodes=[];}
  get children(){return this.childNodes.filter(n=>n instanceof ElementFixture);}
  getBoundingClientRect(){return this.rect;}
  getAttribute(name){return this.dataset[name==='data-paragraphid'?'paragraphid':'paragraphId']??null;}
  matches(selector){
    if(selector==='.outline-paragraph-row')return this.outline===true;
    return (selector.includes('data-group-paragraph-id')&&'groupParagraphId' in this.dataset)||(selector.includes('data-paragraph-tools')&&'paragraphTools' in this.dataset);
  }
  closest(selector){
    for(let n=this;n;n=n.parentElement){
      if(selector==='[data-group-drop]'&&n.dataset.groupDrop)return n;
      if(selector!=='[data-group-drop]'&&(n.tagName==='P'||n.outline)&&n.dataset.paragraphId)return n;
    }
    return null;
  }
}
globalThis.Element=ElementFixture;
after(()=>{if(NativeElement===undefined)delete globalThis.Element;else globalThis.Element=NativeElement;});
function geometry(empty=false){
  const p=new ElementFixture('P',{paragraphId:'first',groupId:'g'},{top:0,bottom:145,height:145});
  const head=new ElementFixture('SPAN',{groupParagraphId:'first',groupDrop:'g'},{top:10,bottom:70,height:60});
  const tools=new ElementFixture('SPAN',{paragraphTools:'first'},{top:80,bottom:100,height:20});
  const button=new ElementFixture('BUTTON',{paragraphId:'first'},{top:80,bottom:100,height:20});button.parentElement=tools;
  const text={rect:{top:110,bottom:130,height:20}};
  p.childNodes=empty?[head,tools]:[head,tools,text];head.parentElement=p;tools.parentElement=p;
  p.ownerDocument={createRange(){let first,last;return {setStartBefore(n){first=p.childNodes.indexOf(n);},setEndAfter(n){last=p.childNodes.indexOf(n);},getBoundingClientRect(){const nodes=p.childNodes.slice(first,last+1);const top=Math.min(...nodes.map(n=>(n.rect).top)),bottom=Math.max(...nodes.map(n=>n.rect.bottom));return {top,bottom,height:bottom-top};}};}};
  return {p,head,tools,button};
}
test('组首段的标题/工具栏不改变正文上下半，手柄命中使用实际p，组头仍追加组末',()=>{
  const {p,head,button}=geometry();
  assert.deepEqual(paragraphBodyBounds(p),{top:110,bottom:130,height:20});
  assert.equal(resolveParagraphDropTarget(p,114).position,'before'); // 旧p中点72.5会错误落after。
  assert.equal(resolveParagraphDropTarget(p,126).position,'after');
  assert.deepEqual(resolveParagraphDropTarget(button,114),{type:'paragraph',paragraphId:'first',position:'before'});
  assert.deepEqual(resolveParagraphDropTarget(head,40),{type:'group',groupId:'g'});
  assert.deepEqual(resolveParagraphDropTarget(p,114,'audio'),{type:'group',groupId:'g'});
});
test('空段也有前后落点，B行复用中点，非段落/无组音频不误提交',()=>{
  const {p}=geometry(true),body=paragraphBodyBounds(p);
  assert.ok(body.height>0);
  assert.equal(resolveParagraphDropTarget(p,body.top+.1).position,'before');
  assert.equal(resolveParagraphDropTarget(p,body.bottom-.1).position,'after');
  p.outline=true;assert.equal(resolveParagraphDropTarget(p,70).position,'before');assert.equal(resolveParagraphDropTarget(p,80).position,'after');
  delete p.dataset.groupId;assert.equal(resolveParagraphDropTarget(p,70,'audio'),null);
  assert.equal(resolveParagraphDropTarget(new ElementFixture('DIV'),70),null);
});
function grouped(){
  const project=createDemoProject(),base=project.chapters[0];
  const ids=Array.from({length:6},(_,i)=>'p-'+i);
  const blocks=ids.map((id,i)=>({type:'paragraph',id,children:[{type:'cue',id:'cue-'+i,settings:defaultSettings({audioId:'sound',sceneLayers:[{id:'layer-'+i,assetId:'image',x:0,y:0,width:100,height:100,opacity:1,zIndex:1}]}),children:[{type:'text',text:'第'+i+'段正文'}]}]}));
  let chapter={...base,document:{...base.document,blocks},groups:[],musicRanges:[]};
  chapter=createParagraphGroup(chapter,ids,'同组');
  chapter=setMusicRange(chapter,'music',ids);
  const assets=[['music','audio','audio/wav'],['sound','audio','audio/wav'],['image','image','image/png']].map(([id,kind,mime])=>({id,kind,mime,name:id+(kind==='image'?'.png':'.wav'),size:1,blob:new Blob([new Uint8Array([1])],{type:mime})}));
  return {project:{...project,chapters:[chapter],activeChapterId:chapter.id,assets:assets.map(({blob,...a})=>a)},chapter,ids,assets};
}
test('同组首中末双向移动和连续多选保序，内容/句ID/图层/音效及组配乐不变',async()=>{
  const {project,chapter,ids,assets}=grouped(),groupId=chapter.groups[0].id;
  const original=new Map(chapter.document.blocks.map(b=>[b.id,b.children]));
  const verify=current=>{
    assert.equal(current.groups[0].id,groupId);
    assert.deepEqual(current.groups[0].paragraphIds,current.document.blocks.map(b=>b.id));
    assert.deepEqual(musicRangeParagraphIds(current,current.musicRanges[0]),current.document.blocks.map(b=>b.id));
    for(const block of current.document.blocks)assert.deepEqual(block.children,original.get(block.id));
    assert.equal(validateProject({...project,chapters:[current]}),true);
  };
  let next=moveParagraphs(chapter,[ids[5]],{type:'paragraph',paragraphId:ids[0],position:'before'});verify(next);assert.equal(next.document.blocks[0].id,ids[5]);
  next=moveParagraphs(next,[ids[5]],{type:'group',groupId});verify(next);assert.deepEqual(next.document.blocks.map(b=>b.id),ids);
  next=moveParagraphs(next,[ids[0]],{type:'paragraph',paragraphId:ids[5],position:'after'});verify(next);assert.equal(next.document.blocks.at(-1).id,ids[0]);
  next=moveParagraphs(next,[ids[0]],{type:'paragraph',paragraphId:ids[1],position:'before'});verify(next);assert.deepEqual(next.document.blocks.map(b=>b.id),ids);
  next=moveParagraphs(next,[ids[3],ids[2]],{type:'paragraph',paragraphId:ids[0],position:'before'});verify(next);assert.deepEqual(next.document.blocks.map(b=>b.id),[ids[2],ids[3],ids[0],ids[1],ids[4],ids[5]]);
  next=moveParagraphs(next,[ids[2],ids[3]],{type:'group',groupId});verify(next);assert.deepEqual(next.document.blocks.map(b=>b.id),[ids[0],ids[1],ids[4],ids[5],ids[2],ids[3]]);
  assert.equal(moveParagraphs(next,[ids[2]],{type:'paragraph',paragraphId:ids[2],position:'after'}),next);
  const reopened=await readProjectArchive(await (await createProjectArchive({...project,chapters:[next]},assets)).arrayBuffer());verify(reopened.project.chapters[0]);
});
test('排序走单一PM结构事务，一次撤销重做恢复全顺序及组配乐',()=>{
  const {chapter,ids}=grouped(),groupId=chapter.groups[0].id;
  const next=moveParagraphs(chapter,[ids[4],ids[3]],{type:'paragraph',paragraphId:ids[0],position:'before'});
  const schema=getSchema([StarterKit,UniqueID.configure({types:['paragraph'],attributeName:'paragraphId'}),CueMark,StoryAttributes]);
  let state=EditorState.create({schema,doc:schema.nodeFromJSON(toEditorContent(chapter.document,chapter.groups,chapter.musicRanges)),plugins:[history()]});
  const editor={get state(){return state;},schema,view:{dispatch(tr){state=state.apply(tr);}}};
  const verify=current=>{
    const actual=reconcileChapterDocument(chapter,fromEditorContent(state.doc.toJSON()));
    assert.deepEqual(actual.document.blocks.map(b=>b.id),current.document.blocks.map(b=>b.id));
    assert.deepEqual(actual.groups.find(g=>g.id===groupId).paragraphIds,current.groups[0].paragraphIds);
    assert.deepEqual(musicRangeParagraphIds(actual,actual.musicRanges[0]),musicRangeParagraphIds(current,current.musicRanges[0]));
    assert.deepEqual(compileDocument(actual.document).map(c=>c.id),compileDocument(current.document).map(c=>c.id));
    for(const block of actual.document.blocks)assert.deepEqual(block.children,current.document.blocks.find(b=>b.id===block.id).children);
  };
  assert.equal(moveEditorParagraphs(editor,next.document.blocks),true);verify(next);
  assert.equal(undo(state,tr=>{state=state.apply(tr);}),true);verify(chapter);
  assert.equal(redo(state,tr=>{state=state.apply(tr);}),true);verify(next);
});
