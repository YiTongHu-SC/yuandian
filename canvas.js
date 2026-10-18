import {CANVAS_KEY, VERSION, LIMITS, COLORS, createWorkspace, createBoard, createNode, connect, deleteNode, parseImport, importAppend, load, save, exportJSON} from './canvas-model.js';

const $ = s => document.querySelector(s);
const copy = x => structuredClone(x);
const clamp = (x,min,max) => Math.max(min,Math.min(max,x));
const xy = x => clamp(x,-LIMITS.coordinate,LIMITS.coordinate);
function h(tag,attrs={},...children){
  const el=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(v===null||v===undefined||v===false)continue;
    if(k.startsWith('on'))el.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==='class')el.className=v;
    else if(['value','disabled','selected'].includes(k))el[k]=v;
    else el.setAttribute(k,v===true?'':v);
  }
  children.flat(Infinity).forEach(c=>{if(c!==null&&c!==undefined&&c!==false)el.append(c instanceof Node?c:document.createTextNode(String(c)));});return el;
}
const button=(text,click,cls='',attrs={})=>h('button',{type:'button',class:cls,onClick:click,...attrs},text);
let storage;try{storage=localStorage;}catch{storage=null;}
const loaded=load(storage);
let workspace=loaded.workspace||createWorkspace(), savedRaw=loaded.raw??null, dirty=false, saveTimer, saveError='';
let corrupt=loaded.status==='invalid', conflict=false, selection=null, editing=null, dragging=null, connecting=false, connectFrom=null;
let stage,world,svg,nodesLayer, nodeEls=new Map(),histories=new Map(),toastTimer;
const board=()=>workspace.boards.find(b=>b.id===workspace.activeId);
const activeNode=()=>board()?.nodes.find(n=>n.id===selection?.id && selection.kind==='node');
const snapshot=()=>JSON.stringify({nodes:board().nodes,edges:board().edges});
const history=()=>{if(!histories.has(workspace.activeId))histories.set(workspace.activeId,{undo:[],redo:[]});return histories.get(workspace.activeId);};
function note(text,action,label='撤销'){
  clearTimeout(toastTimer);$('.toast')?.remove();const el=h('div',{class:'toast',role:'status'},text,action?button(label,()=>{action();el.remove();},'small',{style:'margin-left:12px'}):null);document.body.append(el);toastTimer=setTimeout(()=>el.remove(),7000);
}
function status(){const el=$('#save-state');if(!el)return;const err=corrupt?'原存储异常，未覆盖':conflict?'另一页有更新，保存已暂停':saveError;el.textContent=err||(dirty?'正在保存…':'● 已自动保存在本机');el.title=err||'记录属于当前浏览器，请定期导出 JSON';el.className=`save-state${err?' error':''}`;}
function markDirty(){if(board())board().updatedAt=new Date().toISOString();dirty=true;saveError='';status();clearTimeout(saveTimer);saveTimer=setTimeout(flush,350);}
function flush(){
  clearTimeout(saveTimer);
  const perform=()=>{
    if(!dirty||corrupt||conflict)return false;
    let raw;try{raw=storage.getItem(CANVAS_KEY);}catch{saveError='保存不可用，请导出备份';status();return false;}
    if(raw!==savedRaw){conflict=true;showRecovery();status();return false;}
    const r=save(storage,workspace,savedRaw);
    if(r.ok){savedRaw=storage.getItem(CANVAS_KEY);dirty=false;saveError='';}
    else if(r.status==='conflict'){conflict=true;showRecovery();}
    else saveError=r.error||'尚未保存，请导出备份';status();return r.ok;
  };
  return navigator.locks?.request?navigator.locks.request(CANVAS_KEY,perform).catch(()=>{saveError='保存不可用，请导出备份';status();return false;}):perform();
}
function pushHistory(before){if(before===snapshot())return;const hs=history();hs.undo.push(before);if(hs.undo.length>50)hs.undo.shift();hs.redo=[];updateTools();}
function undo(redo=false){
  finishEdit();const hs=history(),src=redo?hs.redo:hs.undo,dst=redo?hs.undo:hs.redo;if(!src.length)return;
  dst.push(snapshot());Object.assign(board(),JSON.parse(src.pop()));selection=null;cancelConnect();markDirty();renderBoard();
}
function optionLabel(b){const same=workspace.boards.filter(x=>x.title===b.title);return `${b.title||'未命名画布'}${same.length>1?` · ${same.indexOf(b)+1}/${same.length}`:''}`;}
function updateBoardSelect(){const el=$('#boards');el.replaceChildren(...workspace.boards.map(b=>h('option',{value:b.id,selected:b.id===workspace.activeId},optionLabel(b))));}
function build(){
  const top=h('header',{class:'topbar'},h('div',{class:'brand'},h('div',{class:'brand-mark','aria-hidden':'true'},'·'),h('div',{},h('div',{class:'brand-name'},'原点'),h('div',{class:'brand-sub'},'自由思考 / OPEN CANVAS'))),h('span',{class:'version-tag'},'初版'),h('div',{class:'top-divider'}),h('select',{id:'boards',class:'board-select','aria-label':'切换画布',onChange:e=>{
    finishEdit();workspace.activeId=e.target.value;selection=null;cancelConnect();markDirty();renderBoard();
  }}),button('＋ 新画布',newBoard,'ghost small'),h('div',{class:'top-grow'}),h('div',{class:'top-actions'},h('span',{id:'save-state',class:'save-state',role:'status'}),button('文件',showFiles,'ghost small'),button('怎么用',toggleHelp,'ghost small')));
  stage=h('div',{class:'stage',id:'stage',tabindex:'0','aria-label':'自由思考画布，双击空白处新增想法'});
  world=h('div',{class:'world'});svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('edges');svg.setAttribute('aria-label','想法之间的连接');nodesLayer=h('div',{class:'nodes'});world.append(svg,nodesLayer);stage.append(world);
  const toolbar=h('div',{class:'toolbar floating'},button('＋ 想法',()=>addIdea(),'primary',{'aria-label':'新增想法'}),button('＋ 分支',()=>addBranch(),'',{id:'branch','aria-label':'添加分支'}),button('连线',toggleConnect,'',{id:'connect','aria-label':'连接想法'}),h('div',{class:'sep'}),button('↶',()=>undo(),'',{id:'undo',title:'撤销 Ctrl / ⌘ Z','aria-label':'撤销'}),button('↷',()=>undo(true),'',{id:'redo',title:'重做 Ctrl / ⌘ Shift Z','aria-label':'重做'}));
  const title=h('input',{id:'board-title',class:'title-input',type:'text',maxlength:LIMITS.title,'aria-label':'画布名称',onInput:e=>{board().title=e.target.value;markDirty();},onBlur:updateBoardSelect});
  const wrap=h('main',{class:'stage-wrap'},stage,toolbar,h('div',{id:'selection-tools',class:'selection-tools floating hidden',onPointerdown:e=>e.preventDefault()}),h('div',{class:'canvas-heading'},h('div',{class:'eyebrow'},'THINK IN YOUR OWN WAY'),title,h('p',{},'先写下来，再慢慢找到它们之间的关系。')),h('div',{id:'connect-message'}),h('div',{id:'recovery'}),h('div',{id:'empty'}),h('div',{class:'canvas-footer'},'双击编辑想法',h('span',{},'·'),'拖动自由摆放',h('span',{class:'desktop-hint'},'·'),h('span',{class:'desktop-hint',style:'padding:0;color:inherit'},'Tab 延伸分支 · 拖空白移动画布')),h('div',{id:'counter',class:'canvas-counter'}),h('div',{class:'zoom floating'},button('−',()=>zoomAt(.8),'',{'aria-label':'缩小画布'}),h('span',{class:'percent',id:'zoom'}),button('＋',()=>zoomAt(1.25),'',{'aria-label':'放大画布'}),h('div',{class:'sep'}),button('适配全部',fitAll,'fit',{'aria-label':'显示全部想法'})));
  $('#app').replaceChildren(h('div',{class:'workspace'},top,wrap));updateBoardSelect();bindCanvas();renderBoard();status();showRecovery();
}
function renderBoard(){
  editing=null;nodeEls=new Map();nodesLayer.replaceChildren();const b=board();if(!b)return;
  $('#board-title').value=b.title;
  for(const n of b.nodes){
    const text=h('div',{class:'idea-text'},n.text);
    const el=h('article',{class:`idea ${n.color}`,tabindex:'0','data-node-id':n.id,'aria-label':`想法：${n.text.slice(0,80)||'空白想法'}`,onDblclick:e=>{e.stopPropagation();beginEdit(n.id);},onKeydown:e=>{
      if(e.target.tagName==='TEXTAREA')return;
      if(e.key==='Enter'){e.preventDefault();beginEdit(n.id);}else if(e.key==='Tab'&&!e.shiftKey){e.preventDefault();selection={kind:'node',id:n.id};addBranch();}
    }},text,button('＋',e=>{e.stopPropagation();selection={kind:'node',id:n.id};addBranch();},'idea-add',{'aria-label':`从此想法延伸分支：${n.text.slice(0,30)||'空白想法'}`,title:'延伸一个分支（Tab）'}));
    el.style.left=`${n.x}px`;el.style.top=`${n.y}px`;nodeEls.set(n.id,el);nodesLayer.append(el);
  }
  applyView();updateTools();renderEdges();requestAnimationFrame(renderEdges);
  $('#empty').replaceChildren(b.nodes.length?document.createTextNode(''):h('div',{class:'empty-guide'},h('p',{},'画布空着，也可以重新开始。'),button('＋ 写下第一个想法',()=>addIdea(),'primary')));
}
function applyView(){const v=board().view;world.style.transform=`translate(${v.x}px, ${v.y}px) scale(${v.scale})`;$('#zoom').textContent=`${Math.round(v.scale*100)}%`;stage.style.backgroundPosition=`${v.x}px ${v.y}px`;stage.style.backgroundSize=`${24*v.scale}px ${24*v.scale}px`;}
function renderEdges(){
  const NS='http://www.w3.org/2000/svg',make=(tag,attrs={})=>{const el=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>el.setAttribute(k,v));return el;};
  svg.replaceChildren();const defs=make('defs'),marker=make('marker',{id:'arrow',markerWidth:7,markerHeight:7,refX:6,refY:3.5,orient:'auto'});marker.append(make('path',{d:'M0,0 L7,3.5 L0,7',fill:'#96ad93'}));defs.append(marker);svg.append(defs);
  for(const edge of board().edges){
    const a=board().nodes.find(n=>n.id===edge.from),b=board().nodes.find(n=>n.id===edge.to);if(!a||!b)continue;
    const ah=nodeEls.get(a.id)?.offsetHeight||98,bh=nodeEls.get(b.id)?.offsetHeight||98;
    let ax,ay,bx,by,c1,c2;
    if(Math.abs(b.x-a.x)>100){const sign=b.x>a.x?1:-1;ax=a.x+(sign>0?225:0);ay=a.y+ah/2;bx=b.x+(sign>0?0:225);by=b.y+bh/2;const d=Math.max(55,Math.abs(bx-ax)*.45);c1=[ax+sign*d,ay];c2=[bx-sign*d,by];}
    else{const sign=b.y>a.y?1:-1;ax=a.x+112.5;ay=a.y+(sign>0?ah:0);bx=b.x+112.5;by=b.y+(sign>0?0:bh);const d=Math.max(55,Math.abs(by-ay)*.45);c1=[ax,ay+sign*d];c2=[bx,by-sign*d];}
    const d=`M ${ax} ${ay} C ${c1} ${c2} ${bx} ${by}`,group=make('g',{'class':`edge${selection?.kind==='edge'&&selection.id===edge.id?' selected':''}`});
    const hit=make('path',{d,'class':'edge-hit','data-edge-id':edge.id,'aria-label':'选择连线'});group.append(hit,make('path',{d,'class':'edge-path','marker-end':'url(#arrow)'}));
    if(edge.label){const label=make('text',{x:(ax+bx)/2,y:(ay+by)/2-9,'class':'edge-label','text-anchor':'middle'});label.textContent=edge.label;group.append(label);}svg.append(group);
  }
}
function updateTools(){
  const n=activeNode(),selected=!!selection;
  for(const [id,enabled] of [['branch',!!n],['undo',history().undo.length>0],['redo',history().redo.length>0]])$('#'+id).disabled=!enabled;
  $('#connect').classList.toggle('active',connecting);stage.classList.toggle('connecting',connecting);
  nodeEls.forEach((el,id)=>{el.classList.toggle('selected',selection?.kind==='node'&&selection.id===id);el.classList.toggle('connection-source',connecting&&connectFrom===id);el.querySelector('.idea-note')?.remove();if(selection?.id===id&&!editing)el.append(h('span',{class:'idea-note'},'双击编辑 · Tab 继续展开'));});
  const tools=$('#selection-tools');tools.classList.toggle('hidden',!selected);tools.replaceChildren();
  if(n){for(const color of COLORS)tools.append(button('',()=>{finishEdit();const before=snapshot();n.color=color;pushHistory(before);markDirty();renderBoard();},`swatch ${color}${n.color===color?' chosen':''}`,{'aria-label':`颜色：${{cream:'米白',green:'浅绿',blue:'浅蓝',rose:'浅粉'}[color]}`,title:'只是一种颜色，你来决定含义'}));tools.append(h('div',{class:'sep'}),button('编辑',()=>beginEdit(n.id),'small'));}
  tools.append(button(selection?.kind==='edge'?'删除连线':'删除',removeSelected,'small danger',{'aria-label':selection?.kind==='edge'?'删除连线':'删除想法'}));
  $('#counter').textContent=`${board().nodes.length} 个想法 · ${board().edges.length} 条连接`;
  const message=$('#connect-message');message.replaceChildren(connecting?h('div',{class:'connect-message'},connectFrom?'点击另一个想法，建立连接':'先点击起点想法，再点击终点',button('取消 Esc',cancelConnect)):document.createTextNode(''));
}
function cancelConnect(){connecting=false;connectFrom=null;if($('#connect'))updateTools();}
function toggleConnect(){finishEdit();if(connecting)return cancelConnect();connecting=true;connectFrom=activeNode()?.id||null;updateTools();}
function linkTo(id){
  if(!connectFrom){connectFrom=id;selection={kind:'node',id};updateTools();return;}
  if(connectFrom===id)return note('请选择另一个想法作为连接目标。');
  const before=snapshot(),edge=connect(board(),connectFrom,id);if(!edge)return note('这两个想法已经连接，或连线数量达到上限。');
  pushHistory(before);selection={kind:'node',id};connecting=false;connectFrom=null;markDirty();updateTools();renderEdges();
}
function worldPoint(clientX,clientY){const r=stage.getBoundingClientRect(),v=board().view;return {x:(clientX-r.left-v.x)/v.scale,y:(clientY-r.top-v.y)/v.scale};}
function centerPoint(){const r=stage.getBoundingClientRect();return worldPoint(r.left+r.width/2,r.top+r.height/2);}
function freePosition(x,y){let pos={x,y};for(let i=0;i<board().nodes.length+1;i++){if(!board().nodes.some(n=>Math.abs(n.x-pos.x)<230&&Math.abs(n.y-pos.y)<115))return pos;pos.y+=145;}return pos;}
function addIdea(position){
  finishEdit();if(board().nodes.length>=LIMITS.nodes)return note('这张画布的想法已达上限，可以新建一张继续。');
  const p=position||centerPoint(),pos=freePosition(p.x-112,p.y-49),before=snapshot(),n=createNode('',xy(pos.x),xy(pos.y));board().nodes.push(n);pushHistory(before);selection={kind:'node',id:n.id};cancelConnect();markDirty();renderBoard();reveal(n);beginEdit(n.id);
}
function addBranch(){
  finishEdit();const parent=activeNode();if(!parent)return note('先选中一个想法，再展开分支。');if(board().nodes.length>=LIMITS.nodes||board().edges.length>=LIMITS.edges)return note('当前画布已达容量上限。');
  const before=snapshot(),pos=freePosition(parent.x+320,parent.y),n=createNode('',xy(pos.x),xy(pos.y),parent.color);board().nodes.push(n);connect(board(),parent.id,n.id);pushHistory(before);selection={kind:'node',id:n.id};cancelConnect();markDirty();renderBoard();reveal(n);beginEdit(n.id);
}
function reveal(n){const v=board().view,w=stage.clientWidth,ht=stage.clientHeight,nx=n.x*v.scale+v.x,ny=n.y*v.scale+v.y;if(nx<35||nx+225*v.scale>w-35)v.x=xy(w/2-(n.x+112)*v.scale);if(ny<175||ny+100*v.scale>ht-75)v.y=xy(Math.max(190,ht/2)-(n.y+50)*v.scale);applyView();markDirty();}
function beginEdit(id){
  if(editing?.id===id)return;finishEdit();cancelConnect();const n=board().nodes.find(x=>x.id===id),el=nodeEls.get(id);if(!n||!el)return;
  selection={kind:'node',id};editing={id,boardId:board().id,before:snapshot()};updateTools();el.classList.add('editing');
  const input=h('textarea',{class:'idea-editor',maxlength:LIMITS.text,'aria-label':'编辑想法',placeholder:'写下你的想法…',value:n.text,onInput:()=>{n.text=input.value;resize();markDirty();},onKeydown:e=>{
    if(e.isComposing||e.keyCode===229)return;
    if(e.key==='Tab'&&!e.shiftKey){e.preventDefault();e.stopPropagation();finishEdit();addBranch();}
    else if(e.key==='Escape'||(e.key==='Enter'&&(e.ctrlKey||e.metaKey))){e.preventDefault();e.stopPropagation();finishEdit();stage.focus();}
  },onBlur:()=>{queueMicrotask(()=>{if(editing?.id===id)finishEdit();});}});
  const resize=()=>{input.style.height='auto';input.style.height=`${Math.min(650,Math.max(96,input.scrollHeight))}px`;renderEdges();};
  el.querySelector('.idea-text').replaceWith(input);resize();input.focus();input.select();
}
function finishEdit(){
  if(!editing)return;const old=editing;editing=null;const b=workspace.boards.find(x=>x.id===old.boardId),n=b?.nodes.find(x=>x.id===old.id),el=nodeEls.get(old.id);
  if(n&&el){el.querySelector('textarea')?.replaceWith(h('div',{class:'idea-text'},n.text));el.classList.remove('editing');el.setAttribute('aria-label',`想法：${n.text.slice(0,80)||'空白想法'}`);if(b.id===workspace.activeId)pushHistory(old.before);}
  updateTools();renderEdges();
}
function removeSelected(){finishEdit();if(!selection)return;const before=snapshot();if(selection.kind==='node')deleteNode(board(),selection.id);else board().edges=board().edges.filter(e=>e.id!==selection.id);pushHistory(before);selection=null;cancelConnect();markDirty();renderBoard();note('已删除，可以撤销。');}
function zoomAt(factor,client){finishEdit();const r=stage.getBoundingClientRect(),cx=client?.x??r.left+r.width/2,cy=client?.y??r.top+r.height/2,p=worldPoint(cx,cy),v=board().view;v.scale=clamp(v.scale*factor,.2,2.5);v.x=xy(cx-r.left-p.x*v.scale);v.y=xy(cy-r.top-p.y*v.scale);applyView();markDirty();}
function fitAll(){
  finishEdit();const ns=board().nodes;if(!ns.length){Object.assign(board().view,{x:stage.clientWidth/2,y:stage.clientHeight/2,scale:1});applyView();markDirty();return;}
  const minX=Math.min(...ns.map(n=>n.x)),minY=Math.min(...ns.map(n=>n.y)),maxX=Math.max(...ns.map(n=>n.x+225)),maxY=Math.max(...ns.map(n=>n.y+(nodeEls.get(n.id)?.offsetHeight||98)));
  const v=board().view,w=stage.clientWidth,ht=stage.clientHeight;v.scale=clamp(Math.min(1,(w-90)/(maxX-minX+50),(ht-250)/(maxY-minY+50)),.2,2.5);v.x=xy(w/2-(minX+maxX)/2*v.scale);v.y=xy(Math.max(210,(ht+105)/2)-(minY+maxY)/2*v.scale);applyView();markDirty();
}
function bindCanvas(){
  stage.addEventListener('pointerdown',e=>{
    if(e.button!==0&&e.button!==1)return;if(e.target.closest('button,textarea'))return;
    finishEdit();$('.help-pop')?.remove();const idea=e.target.closest('.idea'),edge=e.target.closest('[data-edge-id]');
    if(connecting&&idea){e.preventDefault();linkTo(idea.dataset.nodeId);return;}
    if(edge){selection={kind:'edge',id:edge.dataset.edgeId};updateTools();renderEdges();return;}
    if(idea){selection={kind:'node',id:idea.dataset.nodeId};updateTools();const n=activeNode();dragging={kind:'node',id:n.id,x:e.clientX,y:e.clientY,nx:n.x,ny:n.y,before:snapshot(),changed:false};}
    else{selection=null;updateTools();dragging={kind:'pan',x:e.clientX,y:e.clientY,nx:board().view.x,ny:board().view.y,changed:false};}
    dragging.capture=idea||stage;dragging.capture.setPointerCapture(e.pointerId);stage.focus();
  });
  stage.addEventListener('pointermove',e=>{
    if(!dragging)return;const dx=e.clientX-dragging.x,dy=e.clientY-dragging.y;if(!dragging.changed&&Math.hypot(dx,dy)<5)return;dragging.changed=true;stage.classList.add(dragging.kind==='pan'?'panning':'dragging');
    if(dragging.kind==='node'){const n=board().nodes.find(x=>x.id===dragging.id);if(!n)return;n.x=xy(dragging.nx+dx/board().view.scale);n.y=xy(dragging.ny+dy/board().view.scale);const el=nodeEls.get(n.id);el.style.left=`${n.x}px`;el.style.top=`${n.y}px`;renderEdges();}
    else{board().view.x=xy(dragging.nx+dx);board().view.y=xy(dragging.ny+dy);applyView();}
  });
  const end=e=>{if(!dragging)return;const capture=dragging.capture;if(dragging.changed){if(dragging.kind==='node')pushHistory(dragging.before);markDirty();}dragging=null;stage.classList.remove('panning','dragging');if(capture?.hasPointerCapture(e.pointerId))capture.releasePointerCapture(e.pointerId);};
  stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end);
  stage.addEventListener('dblclick',e=>{if(!e.target.closest('.idea,[data-edge-id]')&&!connecting){e.preventDefault();addIdea(worldPoint(e.clientX,e.clientY));}});
  stage.addEventListener('wheel',e=>{if(e.target.closest('textarea,.idea-text'))return;e.preventDefault();if(e.ctrlKey||e.metaKey)zoomAt(Math.exp(-e.deltaY*.002),{x:e.clientX,y:e.clientY});else{board().view.x=xy(board().view.x-e.deltaX);board().view.y=xy(board().view.y-e.deltaY);applyView();markDirty();}},{passive:false});
}
function newBoard(){finishEdit();if(workspace.boards.length>=LIMITS.boards)return note('画布数量已达上限。');const b=createBoard('未命名画布');workspace.boards.push(b);workspace.activeId=b.id;selection=null;cancelConnect();updateBoardSelect();renderBoard();fitAll();markDirty();}
function modal(title,...children){const d=h('dialog',{'aria-label':title},button('×',()=>d.close(),'dialog-x',{'aria-label':'关闭窗口'}),h('h2',{},title),children);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();return d;}
function download(text,name,type='application/json'){const url=URL.createObjectURL(new Blob([text],{type:`${type};charset=utf-8`})),a=h('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);}
function backup(all=true){finishEdit();try{download(exportJSON(all?workspace:board()),`${(all?'原点-所有画布':board().title||'原点画布').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100)}.json`);}catch(e){note(`导出失败：${e.message}`);}}
function showFiles(){
  finishEdit();let candidate=null,readTicket=0;
  const error=h('div',{class:'error-text',role:'alert'}),preview=h('div'),confirm=button('作为新画布导入',()=>{
    const r=importAppend(workspace,candidate);if(!r.ok){error.textContent=r.errors.join('；');return;}workspace=r.workspace;selection=null;cancelConnect();markDirty();updateBoardSelect();renderBoard();fitAll();d.close();note('已追加导入，已有画布保留。');
  },'primary',{disabled:true});
  const file=h('input',{type:'file',accept:'.json,application/json','aria-label':'选择画布 JSON 备份',onChange:async e=>{
    const ticket=++readTicket;candidate=null;confirm.disabled=true;preview.replaceChildren();error.textContent='';const f=e.target.files[0];if(!f)return;if(f.size>LIMITS.chars*3){error.textContent='备份文件超过大小上限。';return;}
    try{const text=await f.text();if(ticket!==readTicket)return;const r=parseImport(text);if(!r.ok){error.textContent=r.errors.join('；');return;}candidate=r.value;confirm.disabled=false;preview.replaceChildren(h('div',{class:'import-preview'},'将追加导入：',candidate.boards.map(b=>h('div',{},`${b.title||'未命名画布'} · ${b.nodes.length} 个想法`))));}catch{if(ticket===readTicket)error.textContent='文件读取失败。';}
  }});
  const d=modal('画布文件',h('p',{},'内容自动保存在当前浏览器。JSON 用于备份和迁移，导入会追加新画布。'),button(['导出当前画布',h('small',{},'包含想法、位置、颜色和所有连接。')],()=>backup(false),'export-item'),button(['备份全部画布',h('small',{},`共 ${workspace.boards.length} 张画布。`)],()=>backup(true),'export-item'),h('div',{style:'margin-top:24px'},file),error,preview,h('div',{class:'actions'},button('删除当前画布…',()=>{d.close();removeBoard();},'ghost small danger'),confirm));
}
function removeBoard(){
  finishEdit();const target=copy(board());const d=modal('删除这张画布？',h('p',{},`“${target.title||'未命名画布'}”会从当前列表移除。也可以先取消并从“文件”导出备份。`),h('div',{class:'actions'},button('取消',()=>d.close()),button('删除，可撤销',()=>{
    workspace.boards=workspace.boards.filter(b=>b.id!==target.id);if(!workspace.boards.length)workspace.boards.push(createBoard());workspace.activeId=workspace.boards[0].id;selection=null;d.close();markDirty();updateBoardSelect();renderBoard();note('画布已移除。',()=>{if(workspace.boards.length>=LIMITS.boards)return note('画布数量已达上限，请先备份。');workspace.boards.push(target);workspace.activeId=target.id;markDirty();updateBoardSelect();renderBoard();});
  },'danger')));
}
function toggleHelp(){
  if($('.help-pop')){$('.help-pop').remove();return;}
  const help=h('aside',{class:'help-pop floating','aria-label':'画布使用提示'},button('×',()=>help.remove(),'help-close',{'aria-label':'关闭提示'}),h('h2',{},'像摆放想法一样思考'),h('p',{},'① 双击一张卡片，直接写下想法。按 Enter 换行，点击空白结束编辑。'),h('p',{},'② 选中卡片点“＋分支”，或按 ',h('kbd',{},'Tab'),'，继续展开。拖动卡片改变组合。'),h('p',{},'③ 点“连线”选择另一个想法；连线可以跨分支。点击线条后可以删除。'),h('p',{},'拖动空白处平移；Ctrl / ⌘ + 滚轮缩放。“适配全部”找回整张画布。'),h('p',{},h('kbd',{},'Ctrl / ⌘ Z'),' 撤销　',h('kbd',{},'Delete'),' 删除选中内容'),h('p',{class:'subtle'},'颜色和位置都由你赋予含义。这里没有必填顺序。记录保存在本机，请定期从“文件”备份。',h('br'),h('a',{href:'guided.html'},'打开旧版六步工具 ↗')));$('.stage-wrap').append(help);
}
function showRecovery(){
  const el=$('#recovery');if(!el)return;el.replaceChildren();if(!corrupt&&!conflict)return;
  el.append(h('div',{class:'recovery'},h('p',{},corrupt?'原有画布存储无法读取，未覆盖。请先导出当前画布及原始数据。':'另一个页面更新了画布，本页编辑仍在内存。可保留本页为副本后合并。'),button('备份本页',()=>backup(true)),corrupt?button('下载原始数据',()=>download(loaded.raw||'','原点-待恢复原始数据.txt','text/plain')):button('保留本页副本',()=>{
    const remote=load(storage);if(remote.status!=='loaded'&&remote.status!=='empty')return note('无法读取另一页数据，请先导出本页备份。');const r=importAppend(remote.workspace,workspace);if(!r.ok)return note(r.errors.join('；'));workspace=r.workspace;savedRaw=remote.raw??null;conflict=false;selection=null;editing=null;markDirty();updateBoardSelect();renderBoard();showRecovery();flush();note('已保留两边内容，本页画布作为副本加入。');
  })));
}
document.addEventListener('keydown',e=>{
  if(e.isComposing||e.keyCode===229||document.querySelector('dialog[open]'))return;
  const typing=e.target.closest('textarea,input,select,[contenteditable=true]');
  if(e.key==='Escape'){finishEdit();cancelConnect();$('.help-pop')?.remove();return;}
  if(typing)return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);}
  else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();undo(true);}
  else if(e.key==='Delete'||e.key==='Backspace'){if(selection){e.preventDefault();removeSelected();}}
  else if(e.key==='Tab'&&!e.shiftKey&&e.target===stage&&activeNode()){e.preventDefault();addBranch();}
  else if(e.key==='Enter'&&e.target===stage&&activeNode()){e.preventDefault();beginEdit(activeNode().id);}
});
window.addEventListener('storage',e=>{
  if(e.key!==CANVAS_KEY||e.newValue===savedRaw)return;
  if(dirty||editing||dragging||document.querySelector('dialog[open]')||corrupt||conflict){conflict=true;showRecovery();status();return;}
  const r=load(storage);if(!['loaded','empty'].includes(r.status)){conflict=true;showRecovery();status();return;}const active=workspace.activeId;workspace=r.workspace;savedRaw=r.raw??null;if(!workspace.boards.length)workspace=createWorkspace();if(workspace.boards.some(b=>b.id===active))workspace.activeId=active;selection=null;histories.clear();cancelConnect();updateBoardSelect();renderBoard();note('已载入另一个页面的更新。');
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)flush();});
window.addEventListener('beforeunload',e=>{flush();if(dirty){e.preventDefault();e.returnValue='';}});
if(!workspace.boards.length)workspace=createWorkspace();
if(loaded.status==='empty')board().title='我的第一张画布';
build();
if(loaded.status==='empty'||loaded.status==='invalid'||loaded.status==='unavailable')fitAll();
if(loaded.status==='unavailable'){saveError='保存不可用，请从文件导出';status();}
