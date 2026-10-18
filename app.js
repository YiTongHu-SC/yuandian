import { SCHEMA_VERSION, STORAGE_KEY, LIMITS, createWorkspace, createAnalysis, createExampleAnalysis, createRecord, getAnalysis, normalizeImport, mergeImport, loadWorkspace, saveWorkspace, getReadiness, exportMarkdown } from './model.js';
import { calculate, detachRecord, changedAnalyses, safeFileName } from './logic.js';

const $ = s => document.querySelector(s);
const clone = value => structuredClone(value);
const STEPS = [
  ['目标', '想清目标', '先想清楚，你究竟要改变什么。', '把想要的结果，与现在想到的办法分开。'],
  ['概念', '定义概念', '让关键词，有可以观察的含义。', '“稳定”“好”“差异化”指的分别是什么？换个人能否按同样标准判断？'],
  ['依据', '梳理依据', '分清已经知道的，与暂时相信的。', '保留来源与条件，也允许坦白写下“还不知道”。'],
  ['前提', '拆到根本', '找到结果成立，必须满足的条件。', '先拆成少数必要条件，再找出最值得验证的一个。'],
  ['方向', '探索方向', '从条件出发，重新组合可能的路径。', '比较各条路径怎样起作用、需要什么，以及要放弃什么。'],
  ['行动', '验证与行动', '用一个小行动，换来新的证据。', '先写判据，再执行；观察结果后，再决定是否继续。'],
];
const TYPES = { fact:'事实', assumption:'假设', inference:'推断', unknown:'未知' };
const KINDS = { observed:'观察值', estimate:'估计值', target:'目标值' };
const sectionNames = { inbox:'想法', concepts:'概念', claims:'依据', breakdown:'问题', options:'方向', data:'数据', calculations:'算式', experiments:'验证', tasks:'行动' };
let storage;
try { storage = window.localStorage; } catch { storage = null; }
const loaded = loadWorkspace(storage);
let workspace = loaded.workspace || createWorkspace();
let lastSavedRaw = loaded.raw ?? null;
let dirty = false, savingTimer, saveError = '', conflictRaw = null, corruptRaw = loaded.status === 'invalid' ? loaded.raw : null;
let step = 0, isOverview = false, drawerOpen = false, inboxDraft = '', snackTimer;
let uiViews = {};
try { uiViews = JSON.parse(storage?.getItem(`${STORAGE_KEY}:ui`) || '{}'); } catch { /* Optional UI state. */ }
function current() { return getAnalysis(workspace); }
function topicLabel(item) { const peers=workspace.analyses.filter(a=>a.title===item.title);return `${item.title||'未命名问题'}${peers.length>1?` · ${peers.indexOf(item)+1}/${peers.length}`:''}`; }
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (['value','checked','disabled','selected','open'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  children.flat(Infinity).forEach(child => { if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : document.createTextNode(String(child))); });
  return el;
}
const btn = (text, click, cls = '', attrs = {}) => h('button', { type:'button', class:cls, onClick:click, ...attrs }, text);
const hint = text => h('p', {class:'hint'}, text);
const pill = (text, cls = '') => h('span', {class:`pill ${cls}`}, text);
const row = (...children) => h('div', {class:'row'}, children);
const grid = (...children) => h('div', {class:'grid2'}, children);
const details = (title, ...children) => h('details', {class:'details'}, h('summary', {}, title), children);
const filled = x => typeof x === 'string' && !!x.trim();
function field(obj, key, label, {placeholder = '', type = 'textarea', options, help, after, max, cls = ''} = {}) {
  const id = `f-${crypto.randomUUID()}`;
  let control;
  const edit = () => { obj[key] = control.type === 'checkbox' ? control.checked : control.value; touch(); after?.(control); if(options)refreshCalculations(); };
  if (options) control = h('select', {id, onChange:edit}, Object.entries(options).map(([v,t]) => h('option',{value:v,selected:obj[key] === v},t)));
  else if (type === 'textarea') control = h('textarea', {id, rows:3, class:cls, maxlength:max || LIMITS.text, placeholder, value:obj[key], onInput:edit});
  else control = h('input', {id,type, class:cls, maxlength:max || (['title','term','label'].includes(key) ? LIMITS.title : LIMITS.short), placeholder, value:obj[key] || '', onInput:edit});
  return h('label', {class:'field', for:id}, h('span',{},label), control, help ? h('small',{},help) : null);
}
function refs(obj, key, choices, label) {
  const items = choices.map(item => h('label',{class:'check'}, h('input',{type:'checkbox',checked:obj[key].includes(item.id),onChange:e=>{
    if(e.target.checked && obj[key].length>=LIMITS.references){e.target.checked=false;return notify(`最多关联 ${LIMITS.references} 条记录。`);}
    if(e.target.checked && key==='basisIds'){
      const seen=new Set(),pending=[item.id];
      while(pending.length){const id=pending.pop();if(id===obj.id){e.target.checked=false;return notify('这会形成循环论证，请选择独立的依据。');}if(seen.has(id))continue;seen.add(id);pending.push(...(current().claims.find(x=>x.id===id)?.basisIds||[]));}
    }
    obj[key] = e.target.checked ? [...obj[key], item.id] : obj[key].filter(id=>id!==item.id); touch();
  }}), h('span',{},item.text || item.title || item.question || '未命名记录')));
  return h('div',{class:'field'},h('span',{},label), items.length ? h('div',{class:'checks'},items) : hint('还没有可关联的记录，可以稍后再补。'));
}
function selectRef(obj,key,choices,label,labelKey = 'title') {
  return field(obj,key,label,{type:'select',options:{'':'暂不关联', ...Object.fromEntries(choices.map(x=>[x.id,x[labelKey] || '未命名记录']))}});
}
function notify(text, action, actionText='撤销') {
  clearTimeout(snackTimer); $('.snackbar')?.remove();
  const bar = h('div',{class:'snackbar',role:'status'},text,action?btn(actionText,()=>{action();bar.remove();}):null,btn('×',()=>bar.remove(),'icon',{'aria-label':'关闭提示'}));
  document.body.append(bar); snackTimer = setTimeout(()=>bar.remove(),10000);
}
function stamp() { if(current()) current().updatedAt = new Date().toISOString(); }
function touch() { stamp(); dirty = true; saveError=''; updateSave(); clearTimeout(savingTimer); savingTimer=setTimeout(flush,400); }
function updateSave() {
  const el = $('#save-state');
  if (!el) return;
  const error = saveError || (corruptRaw !== null ? '原有数据异常，尚未保存' : conflictRaw !== null ? '有其他页面的更新' : '');
  el.className=`save-state ${error?'error':''}`;
  el.textContent= error ? error.slice(0,55) : (dirty ? '正在保存…' : '● 已保存在此浏览器');
  el.title = error || '本机自动保存；请定期导出 JSON 备份';
}
function flush() {
  clearTimeout(savingTimer);
  const perform=()=>{
    if (!dirty || corruptRaw !== null || conflictRaw !== null) { updateSave(); return false; }
    let raw;
    try { raw=storage.getItem(STORAGE_KEY); } catch { saveError='保存不可用，请导出备份'; updateSave(); return false; }
    if (raw !== lastSavedRaw) { conflictRaw=raw === null ? '' : raw; renderBanner(); updateSave(); return false; }
    const result=saveWorkspace(storage,workspace,lastSavedRaw);
    if(result.ok) { lastSavedRaw=storage.getItem(STORAGE_KEY); dirty=false; saveError=''; }
    else if(result.status==='conflict'){conflictRaw=result.raw??'';renderBanner();}
    else saveError=`尚未保存：${result.error || '浏览器存储不可用'}`;
    updateSave(); return result.ok;
  };
  // Same-origin workbench tabs cooperate on one lock; the model also checks the
  // expected stored value immediately before writing for older-browser fallback.
  if(navigator.locks?.request)return navigator.locks.request(STORAGE_KEY,perform).catch(()=>{saveError='保存暂不可用，请导出备份';updateSave();return false;});
  return perform();
}
function rememberView() {
  uiViews[workspace.activeId]={step,overview:isOverview};
  try { storage?.setItem(`${STORAGE_KEY}:ui`,JSON.stringify(uiViews)); } catch { /* Main data save reports storage failures. */ }
}
function restoreView() { const v=uiViews[workspace.activeId]; step=Number.isInteger(v?.step)&&v.step>=0&&v.step<6?v.step:0; isOverview=!!v?.overview; }
function nav(n,overview=false) { step=n; isOverview=overview; rememberView(); render(); window.scrollTo({top:0,behavior:'instant'}); }
function add(section,values={}) {
  const a=current(), limit=section==='claims'?LIMITS.claims:LIMITS.records;
  if(a[section].length>=limit) return notify(`当前${sectionNames[section]}已达到 ${limit} 条上限，请拆分问题。`);
  const item=Object.assign(createRecord(section),values); a[section].push(item); touch(); return item;
}
function removeRecord(section,id) {
  const a=current(), before=clone(a); detachRecord(a,section,id); const after=JSON.stringify(a); touch(); renderMain(); if(drawerOpen)renderDrawer();
  notify(`已删除${sectionNames[section]}，其他内容和关联已保留或解除。`,()=>{
    const live=getAnalysis(workspace,before.id);
    if(live && JSON.stringify({...live,updatedAt:before.updatedAt})===JSON.stringify({...JSON.parse(after),updatedAt:before.updatedAt})){
      workspace.analyses[workspace.analyses.findIndex(x=>x.id===before.id)]=before;workspace.activeId=before.id;
    } else {
      const result=mergeImport(workspace,before); if(!result.ok) return notify(result.errors.join('；'));workspace=result.workspace;
    }
    touch();render();
  });
}
function record(section,item,index,...body) {
  return h('article',{class:`record ${item.focus?'focused':''}`},h('div',{class:'record-head'},h('span',{class:'record-title'},`${sectionNames[section]} ${String(index+1).padStart(2,'0')}`),btn('删除',()=>removeRecord(section,item.id),'ghost small danger',{'aria-label':`删除${sectionNames[section]} ${index+1}`})),body);
}
function empty(title,text,button,onClick) { return h('div',{class:'empty'},h('strong',{},title),h('p',{},text),btn(button,onClick,'primary small')); }
function addLine(label,section,values) { return btn(`＋ ${label}`,()=>{add(section,values);renderMain();},'add-line'); }
function head(n) { return h('header',{class:'page-head'},h('div',{class:'eyebrow'},`STEP ${String(n+1).padStart(2,'0')} / 06 · ${STEPS[n][0]}`),h('h1',{},STEPS[n][2]),h('p',{},STEPS[n][3])); }
function shell() {
  const a=current();
  return h('div',{class:'app-shell'},
    h('aside',{class:'sidebar'},h('div',{class:'brand'},h('div',{class:'brand-mark','aria-hidden':'true'},'·'),h('div',{},h('div',{class:'brand-name'},'原点'),h('div',{class:'brand-sub'},'思考工作台 / THINK CLEARLY'))),
      h('div',{},h('div',{class:'nav-kicker'},'从一个问题，到下一步行动'),h('nav',{class:'nav','aria-label':'分析步骤'},STEPS.map((s,i)=>btn([h('span',{class:'step-num'},`0${i+1}`),s[1]],()=>nav(i),!isOverview&&step===i?'active':'',{'aria-current':!isOverview&&step===i?'step':null})),btn([h('span',{class:'step-num'},'↗'),'思考全貌'],()=>nav(step,true),isOverview?'active':''))),
      h('div',{class:'sidebar-bottom'},h('p',{},'第一性原理是一种追问方式。把复杂的判断，落到清楚的概念、可核查的依据和可验证的前提。'),btn('使用指南',showHelp,'ghost small'))),
    h('div',{class:'content-shell'},h('header',{class:'topbar'},h('div',{class:'topic-control'},h('select',{'aria-label':'切换分析问题',onChange:e=>{flush();workspace.activeId=e.target.value;dirty=true;restoreView();flush();render();}},workspace.analyses.map(x=>h('option',{value:x.id,selected:x.id===a?.id},topicLabel(x)))),btn('＋ 新问题',newTopic,'ghost small')),
      h('div',{class:'top-actions'},h('span',{class:'save-state',id:'save-state',role:'status'}),btn('随手记',()=>{drawerOpen=true;renderDrawer();},'small'),btn('导入',showImport,'ghost small'),btn('导出',showExport,'ghost small'))),h('div',{id:'banner'}),h('main',{class:'main',id:'main'})));
}
function render() { const app=$('#app'); app.replaceChildren(shell()); renderBanner(); renderMain(); updateSave(); if(drawerOpen)renderDrawer(); }
function renderMain() {
  const main=$('#main'); if(!main)return;
  const a=current(); if(!a)return;
  main.replaceChildren(isOverview?overview(a):[goalPage,conceptPage,claimsPage,breakdownPage,optionsPage,actionPage][step](a));
  if(!isOverview) main.append(h('div',{class:'stage-footer'},btn(step?'← 上一步':'查看全貌',()=>step?nav(step-1):nav(0,true),'ghost'),h('span',{class:'hint'},'不必填满，每一步都可以随时回来。'),btn(step<5?'下一步 →':'查看思考全貌 ↗',()=>step<5?nav(step+1):nav(step,true),'primary')));
}
function goalPage(a) {
  return h('div',{},head(0),h('section',{class:'panel'},field(a,'title','这次要想清楚的问题',{type:'text',placeholder:'例如：未来半年，我要如何验证一条可持续的副收入路径？',max:LIMITS.title,cls:'goal-decision',after:()=>{const select=$('.topic-control select');select.options[select.selectedIndex].textContent=a.title||'未命名问题';}}),field(a.goal,'outcome','真正想得到什么结果？',{placeholder:'先写结果。暂时不需要决定要做哪一种产品或内容。',cls:'large'}),field(a.goal,'why','这个结果，为什么对你重要？',{placeholder:'它要满足什么需要？如果得到它，生活或工作会怎样改变？'}),details('把目标写得更具体 · 成功条件、期限与边界',field(a.goal,'success','怎样才算达到？',{placeholder:'用你愿意接受的可观察条件描述；还没有数值也可以先留空。'}),field(a.goal,'deadline','希望何时判断一次？',{type:'date'}),grid(field(a.goal,'constraints','必须遵守的约束',{placeholder:'时间、金钱、精力、责任、不可妥协的条件…'}),field(a.goal,'nonGoals','这次暂时不解决什么？',{placeholder:'主动缩小问题，避免把所有事情一起解决。'})))),
    h('div',{class:'intro-cards'},h('div',{class:'intro-card'},h('strong',{},'脑子里很乱，也可以开始'), '先在“随手记”写下来。之后再把一句话归入概念、假设或方向。',btn('打开随手记 ↗',()=>{drawerOpen=true;renderDrawer();},'ghost small')),h('div',{class:'intro-card'},h('strong',{},'先问一个小问题'),'只要有一个目标、一个关键前提和一个验证动作，就可以开始第一轮。',btn('看一个结构示例',addExample,'ghost small'))));
}
function conceptPage(a) {
  return h('div',{},head(1),h('div',{class:'stage-note'},'试着追问：这个词到底指什么？怎样区分“达到了”和“没达到”？它是最终结果，还是一种手段？'),a.concepts.length?a.concepts.map((c,i)=>record('concepts',c,i,field(c,'term','需要澄清的词',{type:'text',placeholder:'例如：稳定副收入、差异化、有效学习'}),field(c,'definition','在这次问题里，它具体指什么？',{placeholder:'写出你的定义，避免用另一个模糊词解释它。'}),field(c,'measure','如何观察或判断？',{placeholder:'什么现象、记录或计算能帮助判断？哪些情况不算？'}))):empty('从最模糊的一个词开始','无需解释每一个词，先澄清真正影响判断的概念。','＋ 定义一个概念',()=>{add('concepts');renderMain();}),a.concepts.length?addLine('添加概念','concepts'):null);
}
function claimCard(a,c,i) {
  const badge=pill(TYPES[c.type],c.type), cue=h('div',{class:'fact-hint'},'事实需要可追溯的观察或来源；选择标签不会让它自动成立。');
  const type=field(c,'type','这句话目前属于',{options:TYPES,after:()=>{badge.textContent=TYPES[c.type];badge.className=`pill ${c.type}`;cue.hidden=c.type!=='fact';}});
  cue.hidden=c.type!=='fact';
  return record('claims',c,i,row(badge),field(c,'text','一句可讨论、可核查的话',{placeholder:'把一张卡写成一个主张，尽量避免同时包含几个结论。'}),type,cue,
    details('补充依据 · 来源、适用条件与关联',grid(field(c,'source','来源 / 观察记录',{type:'text',placeholder:'访谈记录、自己的实验、文章标题…'}),field(c,'date','记录日期',{type:'date'})),field(c,'note','适用范围、限制或疑点',{placeholder:'这个观察在什么条件下成立？有没有其他解释或相反证据？'}),refs(c,'basisIds',a.claims.filter(x=>x.id!==c.id),'这句话依据了哪些记录？'),h('div',{class:'field'},h('span',{},'外部证据链接'),h('div',{class:'linklist'},c.links.map(url=>h('div',{class:'linkrow'},h('a',{href:url,target:'_blank',rel:'noopener noreferrer'},url),btn('移除',()=>{c.links=c.links.filter(x=>x!==url);touch();renderMain();},'ghost small')))),btn('＋ 添加链接',()=>addLink(c),'small'))),
    row(btn(c.type==='unknown'?'把未知变成验证 →':'为这句话设计验证 →',()=>startExperiment({claimId:c.id,hypothesis:c.type==='unknown'?'':c.text,title:c.type==='unknown'?c.text:''}),'ghost small')));
}
function claimsPage(a) {
  return h('div',{},head(2),h('div',{class:'stage-note'},'事实：有来源的观察　·　假设：暂时相信、尚待检验　·　推断：从依据得出的解释　·　未知：还没有答案'),a.claims.length?a.claims.map((c,i)=>claimCard(a,c,i)):empty('你现在知道什么？','可以写一次观察，也可以写一句直觉，然后明确标出它的性质。','＋ 添加一条依据',()=>{add('claims');renderMain();}),a.claims.length?addLine('添加依据 / 假设 / 未知','claims'):null,
    h('div',{class:'section-title'},h('h2',{},'把数据放回判断里'),pill(`${a.data.length} 条数据`)),hint('数值为空表示未知。估计值和目标值会保留标记，不会被当成观察结果。'),a.data.map((d,i)=>record('data',d,i,field(d,'label','数据是什么？',{type:'text',placeholder:'例如：每周可投入时间'}),h('div',{class:'grid3'},field(d,'value','数值',{type:'text',placeholder:'未知可留空',after:refreshCalculations}),field(d,'unit','单位',{type:'text',placeholder:'小时 / 元 / 次',after:refreshCalculations}),field(d,'kind','性质',{options:KINDS,after:refreshCalculations})),details('来源与适用范围',grid(field(d,'source','来源',{type:'text'}),field(d,'date','日期',{type:'date'})),field(d,'note','口径 / 范围 / 限制'),selectRef(d,'claimId',a.claims,'关联依据','text')))),addLine('添加数据','data',{kind:'estimate'}),
    h('div',{class:'section-title'},h('h2',{},'简单演算'),pill('四则运算')),hint('用已有数据检查数量关系。此处不自动换算单位，计算结果也不证明因果。'),a.calculations.map((c,i)=>record('calculations',c,i,field(c,'title','这条算式帮助判断什么？',{type:'text'}),grid(selectRef(c,'leftId',a.data,'左侧数据','label'),selectRef(c,'rightId',a.data,'右侧数据','label')),grid(field(c,'operator','运算',{options:{'+':'＋ 相加','-':'− 相减','*':'× 相乘','/':'÷ 相除'},after:refreshCalculations}),field(c,'resultUnit','结果单位',{type:'text',placeholder:'请自行确认量纲',after:refreshCalculations})),h('div',{id:`calc-${c.id}`},calculationResult(a,c)))),addLine('添加算式','calculations'));
}
function calculationResult(a,c) {
  const r=calculate(a,c);return h('div',{class:`result ${r.ok?'':'error'}`},r.ok?h('strong',{},`${Number(r.value.toPrecision(8))} ${r.unit||''}`):h('b',{},'暂不能计算'),h('small',{},r.message));
}
function refreshCalculations(){for(const c of current().calculations){const box=document.getElementById(`calc-${c.id}`);if(box)box.replaceChildren(calculationResult(current(),c));}}
function breakdownPage(a) {
  const children=parent=>a.breakdown.filter(x=>(x.parentId||null)===parent).map(q=>{
    const i=a.breakdown.indexOf(q);
    return h('div',{},record('breakdown',q,i,field(q,'question','什么条件必须成立？',{placeholder:'例如：必须有人有一个具体问题，并愿意为解决它付费。'}),h('label',{class:'check'},h('input',{type:'radio',name:'focus-question',checked:q.focus,onChange:()=>{a.breakdown.forEach(x=>x.focus=x.id===q.id);touch();renderMain();}}),h('span',{},'将它设为本轮最需要验证的前提')),
      details('继续追问 · 为什么必要，什么会推翻它',field(q,'rationale','它为什么是必要条件？还能往下拆吗？',{placeholder:'说明它与目标的关系。拆到可以观察或验证时，就可以停下。'}),field(q,'disconfirm','什么证据会让我改变判断？',{placeholder:'避免只寻找支持自己的例子。'}),refs(q,'claimIds',a.claims,'当前有哪些相关依据？')),
      row(btn('＋ 拆出子条件',()=>{add('breakdown',{parentId:q.id});renderMain();},'small'),btn('设计验证 →',()=>startExperiment({questionId:q.id,hypothesis:q.question}),'ghost small'),q.focus?btn('取消焦点',()=>{q.focus=false;touch();renderMain();},'ghost small'):null)),h('div',{class:'tree-indent'},children(q.id)));
  });
  return h('div',{},head(3),h('div',{class:'stage-note'},'从“我想要的结果”往下问：它依赖什么？这些条件又依赖什么？优先检验一旦不成立、就会改变方向的前提。'),a.breakdown.length?children(null):empty('先列出 1–3 个必要条件','可以用“要得到这个结果，至少需要……”开头。不必无限追问为什么。','＋ 添加必要条件',()=>{add('breakdown');renderMain();}),a.breakdown.length?addLine('添加另一条必要条件','breakdown'):null);
}
function optionsPage(a) {
  return h('div',{},head(4),h('div',{class:'stage-note'},'先尝试写出两条不同路径，也可以包括“暂不行动”。由你选择本轮先验证哪一条；选择不代表它已被证明。'),a.options.length?a.options.map((o,i)=>record('options',o,i,field(o,'title','一种可能方向',{type:'text',placeholder:'只描述方向，暂时不用写完整商业计划。'}),field(o,'mechanism','它通过什么机制，推动目标实现？',{placeholder:'连接目标与必要条件：谁做什么，会发生什么，为什么？'}),grid(field(o,'needs','它成立需要什么？',{placeholder:'能力、资源、需求、数据、外部条件…'}),field(o,'tradeoffs','代价、缺点与反对理由',{placeholder:'时间成本、机会成本、风险；最强的反对意见是什么？'})),field(o,'status','本轮如何对待它？',{options:{candidate:'候选：继续比较',selected:'优先：先做一轮验证',parked:'暂存：以后再看'},after:()=>{if(o.status==='selected')a.options.forEach(x=>{if(x.id!==o.id&&x.status==='selected')x.status='candidate';});touch();renderMain();}}),details('关联已有依据',refs(o,'claimIds',a.claims,'支持它或反对它的记录')),btn('为这个方向设计验证 →',()=>startExperiment({optionId:o.id}),'ghost small'))):empty('先写一种可能，再寻找另一种','从必要条件出发想办法。先不急着把第一个想到的方向当成唯一答案。','＋ 添加方向',()=>{add('options');renderMain();}),a.options.length?addLine('添加另一种方向','options'):null);
}
function startExperiment(values={}) { if(values.title?.length>LIMITS.title)values={...values,title:values.title.slice(0,LIMITS.title),evidenceNeeded:values.title};if(!add('experiments',values))return;nav(5);notify('已建立验证卡，请补充方法与事先判断标准。'); }
function experimentCard(a,e,i) {
  return record('experiments',e,i,grid(field(e,'title','这次验证叫什么？',{type:'text'}),field(e,'status','进展',{options:{planned:'计划中',doing:'进行中',done:'已完成'}})),field(e,'hypothesis','你要验证的前提或假设',{placeholder:'写得足够具体，让结果有可能支持它，也有可能推翻它。'}),field(e,'method','最小可执行的验证方法',{placeholder:'做什么、接触谁、怎样记录？让成本与不确定性相称。'}),grid(field(e,'metric','观察什么 / 需要什么数据？',{placeholder:'记录与目标有关的行为或结果。'}),field(e,'threshold','看到什么，就继续 / 调整 / 停止？',{placeholder:'尽量事先写判据；没达到时允许改变判断。'})),grid(field(e,'budget','本轮投入上限',{type:'text',placeholder:'时间 / 金钱 / 精力'}),field(e,'deadline','本轮截止日期',{type:'date'})),
    details('关联链路与所需证据',selectRef(e,'optionId',a.options,'验证哪个方向？'),selectRef(e,'questionId',a.breakdown,'对应哪个必要条件？','question'),selectRef(e,'claimId',a.claims,'检验哪条依据或未知？','text'),field(e,'evidenceNeeded','还需要收集哪些证据？')),
    details('执行后回来填写 · 观察与决定',field(e,'result','实际观察到了什么？',{placeholder:'先记原始结果、样本与条件，再解释。不要把“没观察到”自动等于“不存在”。'}),field(e,'decision','这次结果让你怎样更新判断？',{placeholder:'继续、调整、停止，还是证据仍不足？为什么？'}),btn('将观察整理到依据区 →',()=>{if(!filled(e.result))return notify('先填写实际观察，再整理为依据。');add('claims',{text:e.result,type:'inference',source:`验证记录：${e.title||'未命名验证'}`,note:e.decision});nav(2);notify('已作为推断草稿加入，请核对原始记录与性质。');},'small')),
    btn('＋ 为它添加具体行动',()=>{add('tasks',{experimentId:e.id});touch();renderMain();$('#tasks-heading')?.scrollIntoView({behavior:'smooth',block:'start'});},'ghost small'));
}
function actionPage(a) {
  const readiness=getReadiness(a);
  return h('div',{},head(5),h('div',{class:'stage-note'},'一次验证，聚焦一个最重要的未知。计划的作用，是告诉你下一步怎么获得证据，以及何时回来更新判断。'),a.experiments.length?a.experiments.map((e,i)=>experimentCard(a,e,i)):empty('先设计一轮小验证','可以从关键前提或某个方向建立关联，也可以直接开始。','＋ 新建验证',()=>startExperiment()),a.experiments.length?addLine('添加下一轮验证','experiments'):null,
    h('div',{class:'section-title',id:'tasks-heading'},h('h2',{},'把下一步排进日程'),pill(`${a.tasks.filter(t=>t.done).length} / ${a.tasks.length} 已完成`)),h('section',{class:'panel'},a.tasks.length?a.tasks.map((t,i)=>h('div',{class:`task ${t.done?'done':''}`},h('input',{type:'checkbox',checked:t.done,'aria-label':`完成行动 ${i+1}`,onChange:ev=>{t.done=ev.target.checked;touch();renderMain();}}),h('div',{class:'task-fields'},field(t,'text',`行动 ${i+1}`,{type:'text',cls:'task-text',placeholder:'以一个具体动词开头：联系、记录、制作、比较…'}),h('div',{class:'task-meta'},field(t,'deadline','日期',{type:'date'}),selectRef(t,'experimentId',a.experiments,'所属验证'))),h('div',{class:'toolbar'},btn('↑',()=>{[a.tasks[i-1],a.tasks[i]]=[a.tasks[i],a.tasks[i-1]];touch();renderMain();},'ghost small',{'aria-label':`上移行动 ${i+1}`,disabled:i===0}),btn('删除',()=>removeRecord('tasks',t.id),'ghost small danger',{'aria-label':`删除行动 ${i+1}`})))):hint('先写出下一个真正能执行的动作。'),addLine('添加行动','tasks')),
    h('div',{class:'section-title'},h('h2',{},'给本轮思考一个暂定决定')),h('section',{class:'panel'},field(a.review,'decision','目前决定怎么做？',{placeholder:'可以是先验证、暂缓、缩小范围，也可以是尚不能决定。'}),field(a.review,'reason','为什么？还有哪些不确定？'),field(a.review,'nextReview','下次回来复查',{type:'date'}),hint('这里记录你的判断。工具只帮助组织材料，不自动推荐方向。')),details('检查有没有遗漏关键环节',hint('这是结构提示，完整不代表结论正确，留空也不妨碍行动。'),readiness.checks.map(c=>h('p',{class:'hint'},`${c.complete?'✓':'○'} ${c.label}`))));
}
function overview(a) {
  const focus=a.breakdown.find(x=>x.focus), selected=a.options.find(x=>x.status==='selected');
  const brief=(label,text,n)=>h('div',{class:'map-node'},h('span',{},label),h('p',{},text||'尚未填写'),btn('继续整理 →',()=>nav(n),'ghost small'));
  const content=(label,text)=>h('p',{class:'overview-text'},h('span',{class:'overview-label'},label),filled(text)?text:h('span',{class:'muted'},'未填写'));
  const section=(title,items,renderer,n)=>h('section',{class:'overview-section'},h('div',{class:'row between'},h('h3',{},title),btn('编辑 →',()=>nav(n),'ghost small')),items.length?items.map(renderer):hint('暂未记录'));
  return h('div',{},h('header',{class:'page-head'},h('div',{class:'eyebrow'},'YOUR THINKING / 思考全貌'),h('div',{class:'head-row'},h('h1',{},a.title||'未命名问题'),btn('导出笔记 ↗',()=>downloadMarkdown(a),'small')),h('p',{},'这是你当前材料的整理视图。留白代表待补充，关联代表思考路径，结论仍由你判断。')),
    h('div',{class:'map-chain'},brief('想得到的结果',a.goal.outcome,0),brief('本轮关键前提',focus?.question,3),brief('优先验证的方向',selected?.title,4),brief('下一步具体行动',a.tasks.find(t=>!t.done)?.text,5)),
    h('section',{class:'panel'},h('div',{class:'row between'},h('h2',{},'本轮暂定决定'),btn('编辑 →',()=>nav(5),'ghost small')),content('决定',a.review.decision),content('理由与不确定性',a.review.reason),content('复查日期',a.review.nextReview)),
    section('01 目标与边界',[a.goal],g=>h('div',{},content('结果',g.outcome),content('为什么',g.why),content('成功条件',g.success),content('判断期限',g.deadline),content('约束',g.constraints),content('暂不解决',g.nonGoals)),0),
    section('02 概念',a.concepts,c=>h('div',{class:'overview-item'},h('b',{},c.term||'未命名概念'),content('定义',c.definition),content('如何判断',c.measure)),1),
    section('03 依据与未知',a.claims,c=>h('div',{class:'overview-item'},row(pill(TYPES[c.type],c.type),h('span',{class:'overview-text'},c.text||'未填写主张')),content('来源',c.source),filled(c.date)?content('日期',c.date):null,filled(c.note)?content('范围与疑点',c.note):null,c.links.map(url=>h('p',{},h('a',{href:url,target:'_blank',rel:'noopener noreferrer'},url)))),2),
    section('数据与演算',a.data,d=>h('div',{class:'overview-item'},row(pill(KINDS[d.kind],d.kind),h('b',{},d.label||'未命名数据'),h('span',{},filled(d.value)?`${d.value} ${d.unit}`:'数值未知')),content('来源',d.source)),2),a.calculations.map(c=>h('div',{class:'overview-item'},h('b',{},c.title||'未命名算式'),calculationResult(a,c))),
    section('04 必要前提',a.breakdown,q=>h('div',{class:'overview-item'},row(q.focus?pill('本轮焦点','fact'):null,h('b',{class:'overview-text'},q.question||'未填写前提')),q.parentId?content('上级条件',a.breakdown.find(x=>x.id===q.parentId)?.question||'未命名'):null,content('为什么必要',q.rationale),content('什么会推翻它',q.disconfirm)),3),
    section('05 可选方向',a.options,o=>h('div',{class:'overview-item'},row(pill({candidate:'候选',selected:'本轮优先',parked:'暂存'}[o.status]),h('b',{},o.title||'未命名方向')),content('机制',o.mechanism),content('所需条件',o.needs),content('取舍',o.tradeoffs)),4),
    section('06 验证',a.experiments,e=>h('div',{class:'overview-item'},row(pill({planned:'计划中',doing:'进行中',done:'已完成'}[e.status]),h('b',{},e.title||'未命名验证')),content('检验什么',e.hypothesis),e.optionId?content('关联方向',a.options.find(x=>x.id===e.optionId)?.title||'未命名'):null,e.questionId?content('关联前提',a.breakdown.find(x=>x.id===e.questionId)?.question||'未命名'):null,e.claimId?content('关联依据',a.claims.find(x=>x.id===e.claimId)?.text||'未命名'):null,content('方法',e.method),content('观察',e.metric),content('事先判据',e.threshold),content('投入 / 截止',`${e.budget||'未定投入'} / ${e.deadline||'未定日期'}`),content('结果',e.result),content('决定',e.decision)),5),
    section('行动清单',a.tasks,t=>h('div',{class:'overview-item'},content(t.done?'✓ 已完成':'○ 待办',t.text),t.deadline?content('日期',t.deadline):null),5),
    h('div',{class:'stage-footer'},btn('继续思考',()=>nav(step),'primary'),btn('管理当前问题',manageTopic,'ghost small')));
}
function modal(title,...children) {
  const d=h('dialog',{'aria-label':title},btn('×',()=>d.close(),'ghost icon dialog-close',{'aria-label':'关闭弹窗'}),h('h2',{},title),children);
  d.addEventListener('close',()=>d.remove());d.addEventListener('click',ev=>{if(ev.target===d){const r=d.getBoundingClientRect();if(ev.clientX<r.left||ev.clientX>r.right||ev.clientY<r.top||ev.clientY>r.bottom)d.close();}});
  document.body.append(d);d.showModal();return d;
}
function newTopic() {
  const input=h('input',{type:'text',maxlength:LIMITS.title,placeholder:'这次要想清楚什么？','aria-label':'新问题名称'});
  const create=()=>{if(workspace.analyses.length>=LIMITS.analyses)return notify(`最多保存 ${LIMITS.analyses} 个问题，请先备份再整理。`);const a=createAnalysis(input.value.trim()||'未命名问题');workspace.analyses.push(a);workspace.activeId=a.id;step=0;isOverview=false;touch();rememberView();d.close();render();};
  const d=modal('开启一个新问题',h('p',{},'每个问题有独立的目标、材料与计划。之前的分析会保留。'),input,h('div',{class:'toolbar'},btn('取消',()=>d.close(),'ghost'),btn('创建问题',create,'primary')));
  input.addEventListener('keydown',e=>{if(e.key==='Enter')create();});input.focus();
}
function addExample() {
  if(workspace.analyses.length>=LIMITS.analyses)return notify('已达到问题数量上限。');
  const a=createExampleAnalysis();
  a.title='演示 · 如何验证一个副收入方向';
  a.goal.outcome='找到一条能够持续执行的副收入路径（演示草稿，需自行定义）';
  a.concepts.push({...createRecord('concepts'),term:'稳定副收入',definition:'待填写：对我来说，收入持续多久、波动多大才算稳定？',measure:'待填写：观察周期、收入范围、时间投入和支出。'});
  a.breakdown[0].question='是否存在我能触达、且愿意为某个具体结果付费的人？';a.breakdown[0].focus=true;
  a.options[0].title='从游戏、服务、工具或内容中，提出一种待验证路径';
  a.experiments[0].title='验证一个付费问题';a.experiments[0].hypothesis='待我自行填写：谁在什么场景下需要什么结果？';
  workspace.analyses.push(a);workspace.activeId=a.id;step=0;isOverview=false;touch();rememberView();render();notify('演示作为独立问题加入；其中没有真实市场数据或收入目标。');
}
function manageTopic() {
  const a=current();
  const d=modal('管理当前问题',h('p',{},a.title),h('div',{class:'export-options'},btn('复制为一个新问题',()=>{const r=mergeImport(workspace,a);if(!r.ok)return notify(r.errors.join('；'));workspace=r.workspace;current().title=`${a.title}（副本）`.slice(0,LIMITS.title);touch();d.close();render();},'small'),btn('删除当前问题（可以撤销）',()=>{
    const before=clone(a);workspace.analyses=workspace.analyses.filter(x=>x.id!==a.id);if(!workspace.analyses.length)workspace.analyses.push(createAnalysis('我的第一个问题'));workspace.activeId=workspace.analyses[0].id;touch();restoreView();d.close();render();notify('当前问题已删除。',()=>{const r=mergeImport(workspace,before);if(r.ok){workspace=r.workspace;touch();render();}});
  },'small danger')));
}
function addLink(c) {
  const analysisId=current().id,claimId=c.id;
  const input=h('input',{type:'url',maxlength:2048,placeholder:'https://…','aria-label':'证据网址'}),error=h('p',{class:'error-text',role:'alert'});
  const d=modal('添加证据链接',h('p',{},'仅支持 http / https。请同时记录来源和适用条件。'),input,error,h('div',{class:'toolbar'},btn('添加链接',()=>{
    try { const live=getAnalysis(workspace,analysisId)?.claims.find(x=>x.id===claimId);if(!live){error.textContent='该依据已在其他页面删除，请关闭后重新整理。';return;}const raw=input.value.trim(),url=new URL(raw);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.href.length>2048||/[\u0000-\u0020\u007f]/.test(raw))throw new Error();if(live.links.length>=LIMITS.links)throw new Error();if(!live.links.includes(url.href))live.links.push(url.href);touch();d.close();renderMain(); }
    catch {error.textContent='请输入不含凭据的有效 http / https 网址（规范化后最多 2048 字符）。';}
  },'primary')));input.focus();
}
function renderDrawer() {
  $('.drawer')?.remove();$('.drawer-backdrop')?.remove();if(!drawerOpen)return;
  const close=()=>{drawerOpen=false;$('.drawer')?.remove();$('.drawer-backdrop')?.remove();};
  const a=current(),draft={text:inboxDraft},capture=field(draft,'text','先把脑中的想法放在这里',{placeholder:'不用归类，不用写完整。一次记一条，之后再慢慢整理。'});
  // Capture drafts are not part of the analysis until explicitly added.
  const textarea=capture.querySelector('textarea');textarea.replaceWith(textarea.cloneNode(true));const input=capture.querySelector('textarea');
  input.addEventListener('input',()=>{draft.text=input.value;inboxDraft=input.value;});
  const panel=h('aside',{class:'drawer','aria-label':'随手记'},h('div',{class:'row between'},h('h2',{},'随手记'),btn('×',close,'ghost icon',{'aria-label':'关闭随手记'})),h('p',{class:'drawer-intro'},'先卸下脑中的信息，再决定放在哪里。点击“记下来”保存；整理会生成一条记录，原始想法会保留。'),capture,btn('记下来',()=>{if(!draft.text.trim())return input.focus();const item=add('inbox',{text:draft.text});if(item){inboxDraft='';renderDrawer();notify('已保存到随手记。');}},'primary'),a.inbox.map((item,i)=>h('article',{class:'inbox-card'},h('div',{class:'row between'},pill(`原始想法 ${i+1}`),btn('删除',()=>removeRecord('inbox',item.id),'ghost small danger',{'aria-label':`删除想法 ${i+1}`})),h('p',{},item.text),h('small',{},'整理成 →'),h('div',{class:'row'},...[
    ['概念','concepts',{term:item.text.slice(0,LIMITS.title),definition:item.text.length>LIMITS.title?item.text:''},1],['假设','claims',{text:item.text,type:'assumption'},2],['未知','claims',{text:item.text,type:'unknown'},2],['前提','breakdown',{question:item.text},3],['方向','options',{title:item.text.slice(0,LIMITS.title),mechanism:item.text.length>LIMITS.title?item.text:''},4]
  ].map(([name,section,values,n])=>btn(name,()=>{if(add(section,values)){close();nav(n);notify('已生成整理草稿，原始想法仍保留。');}},'small'))))));
  document.body.append(h('div',{class:'drawer-backdrop',onClick:close}),panel);input.focus();
}
function download(text,name,type='application/json') {
  const blob=new Blob([text],{type:`${type};charset=utf-8`}),url=URL.createObjectURL(blob);const a=h('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const today=()=>new Date().toLocaleDateString('sv-SE');
function backupJSON(all=true) { const value=all?workspace:{schemaVersion:SCHEMA_VERSION,activeId:workspace.activeId,analyses:[current()]};download(JSON.stringify(value),`${safeFileName(all?'原点-完整备份':current().title)}-${today()}.json`); }
function downloadMarkdown(a) {download(exportMarkdown(a),`${safeFileName(a.title)}-${today()}.md`,'text/markdown');}
function showExport() {
  modal('导出与备份',h('p',{},'JSON 可以导入恢复。Markdown 是可阅读的完整笔记，不能用于恢复编辑。'),h('div',{class:'export-options'},btn([h('b',{},'完整工作区 · JSON'),h('small',{},`包含 ${workspace.analyses.length} 个问题及所有记录，建议定期备份。`)],()=>backupJSON(true)),btn([h('b',{},'当前问题 · JSON'),h('small',{},current().title)],()=>backupJSON(false)),btn([h('b',{},'当前问题 · Markdown'),h('small',{},'便于阅读、复盘或提供给 AI 继续讨论。')],()=>downloadMarkdown(current()))),hint('备份文件由你保管。浏览器清理站点数据后，需用 JSON 恢复。'));
}
function showImport() {
  let candidate=null,readId=0;
  const text=h('textarea',{'aria-label':'粘贴 JSON 备份',placeholder:'也可以在这里粘贴原点导出的 JSON…',maxlength:LIMITS.importChars});
  const error=h('p',{class:'error-text',role:'alert'}),preview=h('div'),confirm=btn('追加导入',()=>{
    if(!candidate)return;
    const result=mergeImport(workspace,candidate);
    if(!result.ok){error.textContent=result.errors.join('\n');return;}
    workspace=result.workspace;dirty=true;restoreView();flush();d.close();render();notify(`已追加 ${result.importedIds.length} 个问题，原有问题保留。`);
  },'primary',{disabled:true});
  const inspect=()=>{
    const r=normalizeImport(text.value);candidate=r.ok?r.workspace:null;confirm.disabled=!r.ok;error.textContent=r.ok?'':r.errors.join('\n');
    preview.replaceChildren(r.ok?h('div',{class:'import-preview'},h('b',{},`将追加 ${r.workspace.analyses.length} 个问题`),r.workspace.analyses.map(a=>h('div',{},`· ${a.title||'未命名问题'}`)),h('p',{},'同名或同 ID 的问题将作为副本加入，内部关联一并保留，不覆盖当前内容。')):h('span'));
  };
  const file=h('input',{type:'file',accept:'.json,application/json','aria-label':'选择 JSON 备份文件',onChange:async ev=>{
    const ticket=++readId;candidate=null;confirm.disabled=true;preview.replaceChildren();error.textContent='';text.value='';
    const f=ev.target.files[0];if(!f)return;if(f.size>LIMITS.importChars*3){error.textContent='文件过大，请选择原点导出的 JSON 备份（上限 200 万字符）。';return;}
    try{const raw=await f.text();if(ticket!==readId)return;text.value=raw;inspect();}catch{if(ticket===readId)error.textContent='无法读取这个文件，请重新选择。';}
  }});
  text.addEventListener('input',()=>{readId++;candidate=null;confirm.disabled=true;preview.replaceChildren();error.textContent='';});
  const d=modal('导入分析备份',h('p',{},'文件只在本机读取。导入采用追加方式，你可以先检查再确认。'),file,h('div',{style:'height:14px'}),text,error,preview,h('div',{class:'toolbar'},btn('检查内容',inspect),confirm));
}
function showHelp() {
  modal('从混乱，到可验证的下一步',h('p',{},'这是一张可编辑的思考地图。你决定问题、判断和路径，工具帮助你保留过程。'),h('ol',{class:'help-steps'},[
    '先写真正想得到的结果，暂时放下习惯性的解决办法。','给影响判断的关键词下定义，写出可以观察的标准。','把事实、假设、推断和未知分开；记录来源与适用条件。','拆出结果成立的必要条件，选一个最值得验证的前提。','提出不同路径，比较机制、条件、代价与反对理由。','设计小验证，事先写判据，安排动作，观察后更新判断。'
  ].map(t=>h('li',{},t))),h('div',{class:'stage-note'},'不用完成所有格子。目标 + 一个关键前提 + 一个最小行动，就足够启动第一轮。'),h('p',{},'自动保存只属于当前浏览器和网址。固定使用本机 4176 端口；换浏览器、隐私模式或清理站点数据，可能看不到原来的记录。请定期导出完整 JSON。'),h('div',{class:'row'},btn('加入结构示例',()=>{document.querySelector('dialog')?.close();addExample();},'small'),btn('管理当前问题',()=>{document.querySelector('dialog')?.close();manageTopic();},'ghost small')));
}
function renderBanner() {
  const banner=$('#banner');if(!banner)return;banner.replaceChildren();
  if(corruptRaw!==null){banner.append(h('div',{class:'banner'},h('p',{},'检测到原有存储无法读取，原始数据未覆盖。当前可继续编辑并导出；恢复自动保存前，请先备份异常数据。'),btn('备份原始数据',()=>download(corruptRaw,'原点-待恢复原始数据.txt','text/plain'),'small'),btn('恢复保存…',resetCorrupt,'small')));}
  else if(conflictRaw!==null){banner.append(h('div',{class:'banner'},h('p',{},'另一个页面更新了数据。本页修改已保留在内存，自动保存暂停。合并时会将本页修改作为副本追加。'),btn('保留本页副本并合并',resolveConflict,'small'),btn('导出本页备份',()=>backupJSON(true),'small')));}
}
function resetCorrupt() {
  const d=modal('恢复自动保存',h('p',{},'先下载原始数据，再继续。此操作会用当前工作区替换无法读取的站点存储，不影响下载的备份。'),h('div',{class:'toolbar'},btn('下载原始数据',()=>download(corruptRaw,'原点-待恢复原始数据.txt','text/plain')),btn('已备份，保存当前工作区',()=>{
    try { storage.removeItem(STORAGE_KEY);lastSavedRaw=null;corruptRaw=null;dirty=true;flush();d.close();render(); }
    catch {notify('浏览器存储仍不可用，请先导出当前工作区。');}
  },'primary')));
}
function resolveConflict() {
  let remoteRaw;try{remoteRaw=storage.getItem(STORAGE_KEY);}catch{return notify('无法读取浏览器存储，请导出本页备份。');}
  const remote=remoteRaw===null?{schemaVersion:SCHEMA_VERSION,activeId:null,analyses:[]}:normalizeImport(remoteRaw).workspace;
  if(!remote){return notify('其他页面的存储无法读取，请先导出当前备份。');}
  let base={analyses:[]};try{if(lastSavedRaw)base=JSON.parse(lastSavedRaw);}catch{/* All local analyses retained. */}
  const changes=changedAnalyses(base,workspace),activeIndex=changes.findIndex(a=>a.id===workspace.activeId);
  const incoming={schemaVersion:SCHEMA_VERSION,activeId:changes[0]?.id||null,analyses:changes};
  const result=changes.length?mergeImport(remote,incoming):{ok:true,workspace:remote,importedIds:[]};
  if(!result.ok)return notify(result.errors.join('；'));
  workspace=result.workspace;
  if(activeIndex>=0)workspace.activeId=result.importedIds[activeIndex];
  if(!workspace.analyses.length){const a=createAnalysis('我的第一个问题');workspace.analyses.push(a);workspace.activeId=a.id;}
  lastSavedRaw=remoteRaw;conflictRaw=null;dirty=true;flush();restoreView();render();notify('已保留两边内容，本页改动作为副本加入。');
}
window.addEventListener('storage',ev=>{
  if(ev.key!==STORAGE_KEY)return;
  if(ev.newValue===lastSavedRaw)return;
  if(dirty||corruptRaw!==null||conflictRaw!==null||document.querySelector('dialog[open]')||drawerOpen){conflictRaw=ev.newValue===null?'':ev.newValue;renderBanner();updateSave();return;}
  const result=loadWorkspace(storage);
  if(!result.ok){conflictRaw=ev.newValue===null?'':ev.newValue;renderBanner();updateSave();return;}
  const active=workspace.activeId;workspace=result.workspace;lastSavedRaw=result.raw??null;
  if(getAnalysis(workspace,active))workspace.activeId=active;
  if(!workspace.analyses.length){workspace=createWorkspace();dirty=true;}
  restoreView();render();notify('已载入另一个页面的更新。');
});
document.addEventListener('keydown',ev=>{if(ev.key==='Escape'&&drawerOpen){drawerOpen=false;$('.drawer')?.remove();$('.drawer-backdrop')?.remove();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)flush();});
window.addEventListener('beforeunload',ev=>{flush();if(dirty){ev.preventDefault();ev.returnValue='';}});
if(!workspace.analyses.length){workspace=createWorkspace();dirty=true;}
restoreView();render();
if(loaded.status==='empty'){dirty=true;flush();}
else if(loaded.status==='unavailable'){saveError='保存不可用，请导出备份';updateSave();}
