import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import UniqueID from '@tiptap/extension-unique-id';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { history, undo, redo } from '@tiptap/pm/history';
import { StoryAttributes, CueMark, fromEditorContent, toEditorContent, moveEditorParagraphs, projectParagraphDecorations } from '../src/editor/story-editor';
import { createParagraphPresentationReader } from '../src/editor/paragraph-presentation.mjs';
import { createBlankProject } from '../src/domain/model/project.mjs';
import { createParagraphGroup, reconcileChapterDocument, setMusicRange, moveParagraphs } from '../src/domain/model/chapters.mjs';

const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const pause = () => new Promise((resolve) => setTimeout(resolve, 35));
(async () => {
  let chapter = createBlankProject().chapters[0];
  chapter.document.blocks = Array.from({length:100}, (_, index) => ({type:'paragraph',id:'p-'+index,children:[{type:'text',text:'正文第 '+index+' 段'}]}));
  for(let index=0;index<3;index++)chapter=createParagraphGroup(chapter,chapter.document.blocks.slice(index*20,index*20+20).map((p:any)=>p.id),['日常','裂缝','反转'][index]);
  chapter=setMusicRange(chapter,'music',chapter.groups[0].paragraphIds);
  let assets=[{id:'music',name:'验收配乐.wav'}];
  let selected:string[]=[];
  const read=createParagraphPresentationReader(()=>({chapter,assets,paragraphIds:selected,groupIds:[],dropHint:null}));
  const configured=StoryAttributes.configure({getParagraphPresentation:read});
  const schema=getSchema([StarterKit,UniqueID.configure({types:['paragraph'],attributeName:'paragraphId'}),CueMark,configured]);
  const createPlugins=()=>[...(configured.config.addProseMirrorPlugins as any).call({options:configured.options}),history()];
  const host=document.getElementById('editor')!;
  let view:EditorView;
  let pmDropCalls=0;
  const trace:string[]=[];
  const mount=(state:EditorState)=>{
    view=new EditorView(host,{
      state,
      handleDOMEvents:{drop(_view,event){pmDropCalls++;trace.push("prosemirror-drop");event.dataTransfer?.clearData();return true;}},
      dispatchTransaction(transaction){
        const next=view.state.applyTransaction(transaction).state;
        view.updateState(next);
        if(transaction.docChanged){
          chapter=reconcileChapterDocument(chapter,fromEditorContent(next.doc.toJSON()));
          projectParagraphDecorations(view.dom,read);
        }
      },
    });
  };
  mount(EditorState.create({schema,doc:schema.nodeFromJSON(toEditorContent(chapter.document,chapter.groups,chapter.musicRanges)),plugins:createPlugins()}));
  let checks=0;
  const verify=()=>{
    const expected=read('p-0');
    const header=view.dom.querySelector<HTMLElement>('[data-group-paragraph-id="p-0"]')!;
    check(header?.querySelector('[data-group-title]')?.textContent===expected.label,'组头没有当前真实组名');
    check(header?.querySelector('[data-group-summary]')?.textContent===expected.summary,'配乐摘要没有当前真实信息');
    for(const id of ['p-0','p-2','p-20','p-40']){
      check(view.dom.querySelector('[data-paragraph-group-label="'+id+'"]')?.textContent===read(id).label,'段旁组号丢失 '+id);
    }
    check(!view.dom.textContent?.includes('正在读取组信息'),'出现占位摘要');
    checks++;
  };
  verify();
  host.addEventListener('story-paragraph-select',(event)=>{
    const id=(event as CustomEvent).detail.paragraphId;
    selected=selected.includes(id)?selected.filter((item)=>item!==id):[...selected,id];
    projectParagraphDecorations(view.dom,read);
  });
  for(let index=0;index<12;index++){
    host.scrollTop=index%2?host.scrollHeight:0;
    const select=view.dom.querySelector<HTMLButtonElement>('[data-paragraph-select="p-2"]')!;
    select.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
    select.click();
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,index%3+1)));
    await pause();
    verify();
    check(view.dom.querySelector('[data-paragraph-select="p-2"]')?.getAttribute('aria-pressed')===String(selected.includes('p-2')),'勾选状态丢失');
  }
  const oldHeader=view.dom.querySelector('[data-group-paragraph-id="p-0"]');
  view.destroy();
  chapter={...chapter,groups:chapter.groups.map((group:any,index:number)=>index===0?{...group,name:'即时改名'}:group)};
  assets=[{id:'music',name:'即时新配乐.wav'}];
  mount(EditorState.create({schema,doc:schema.nodeFromJSON(toEditorContent(chapter.document,chapter.groups,chapter.musicRanges)),plugins:createPlugins()}));
  check(view.dom.querySelector('[data-group-paragraph-id="p-0"]')!==oldHeader,'未真正重建Widget DOM');
  verify(); // 新建真实DOM后刻意不调用React投影更新
  check(view.dom.querySelector('[data-paragraph-select="p-2"]')?.getAttribute('aria-pressed')===String(selected.includes('p-2')),'新建DOM未读取当前选择');
  view.dispatch(view.state.tr.insertText('新增',2));await pause();verify();
  undo(view.state,(transaction)=>view.dispatch(transaction));await pause();verify();
  redo(view.state,(transaction)=>view.dispatch(transaction));await pause();verify();

  const paragraphPositions=new Map<string,number>();
  view.state.doc.forEach((node,pos)=>paragraphPositions.set(node.attrs.paragraphId,pos+1));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,paragraphPositions.get('p-3')!+2)));
  const previousSelection=view.state.selection.$anchor.parent.attrs.paragraphId;
  chapter=createParagraphGroup(chapter,['p-2','p-3'],'新分组');
  moveEditorParagraphs({get state(){return view.state;},schema,view} as any,chapter.document.blocks);
  check(view.state.selection.$anchor.parent.attrs.paragraphId===previousSelection,'建组后选区跳到末段');
  await pause();verify();
  check(view.dom.querySelector('[data-paragraph-group-label="p-2"]')?.textContent?.includes('新分组'),'结构更新标签未同步');

  let dropMoves=0;
  const mime='application/x-story-workbench-paragraphs';
  const captureDrop=(event:DragEvent)=>{
    trace.push('capture-drop');
    const payload=JSON.parse(event.dataTransfer!.getData(mime));
    event.preventDefault();event.stopPropagation();
    const target=(event.target as Element).closest<HTMLElement>('[data-group-drop]')!;
    chapter=moveParagraphs(chapter,payload.paragraphIds,{type:'group',groupId:target.dataset.groupDrop});
    moveEditorParagraphs({get state(){return view.state;},schema,view} as any,chapter.document.blocks);
    dropMoves++;
  };
  host.addEventListener('drop',captureDrop,true);
  const transfer=new DataTransfer();
  transfer.setData(mime,JSON.stringify({paragraphIds:['p-60']}));
  const groupTarget=view.dom.querySelector<HTMLElement>('[data-group-paragraph-id="p-0"]')!;
  groupTarget.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  await pause();
  check(dropMoves===1&&pmDropCalls===0,'drop未由捕获阶段处理一次');
  check(chapter.groups.find((g:any)=>g.id===groupTarget.dataset.groupDrop)?.paragraphIds.includes('p-60'),'捕获drop未实际移动进组');
  check(view.state.doc.content.content.find((p:any)=>p.attrs.paragraphId==='p-60')?.attrs.groupId===groupTarget.dataset.groupDrop,'真实EditorView未更新组ID');
  verify();
  view.destroy();
  (window as any).domRegression.done({passed:true,checks,realEditorView:true,domRecreated:true,selectionAndCheckboxRounds:12,inputUndoRedo:true,regroup:true,selectionPreserved:true,dropMoves,pmDropCalls,trace,syntheticDomDrop:true});
})().catch((error)=>(window as any).domRegression.done({passed:false,error:error.stack??String(error)}));
