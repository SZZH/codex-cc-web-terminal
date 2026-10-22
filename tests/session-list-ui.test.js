import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compileScript, parse } from "vue/compiler-sfc";
import { createRenderer, h, markRaw, nextTick, reactive } from "vue";
import { createSessionListViewState } from "../web/src/lib/app-state.js";
import { createPreviewController } from "../web/src/lib/preview.js";
import { createSessionCatalogPages } from "../src/sessions/history/sessionCatalogPages.js";

import {
  buildGroupedSessions,
  buildActivitySessions,
  createSessionSearch,
  cacheKey,
  decorateSession,
  mergeSessionTitlesIntoCache,
  parseHistoryRouteSessionId,
  sessionGroupKey
} from "../web/src/lib/session-list.js";

test("parseHistoryRouteSessionId parses provider and resumeSessionId", () => {
  assert.deepEqual(parseHistoryRouteSessionId("history:codex:thread-123"), {
    provider: "codex",
    resumeSessionId: "thread-123"
  });
  assert.equal(parseHistoryRouteSessionId("session-123"), null);
});

test("activity view deduplicates thread identities and sorts real activity times across projects", () => {
  const groups = buildGroupedSessions([], [
    { id: "pinned", groupKind: "pinned", name: "置顶", sessions: [{ id: "pinned-a", provider: "codex", resumeSessionId: "a", projectId: "p1", updatedAt: "2026-10-10T10:00:00Z" }] },
    { id: "project:p1", projectId: "p1", groupKind: "project", name: "项目一", sessions: [
      { id: "a", provider: "codex", resumeSessionId: "a", updatedAt: "2026-10-10T10:00:00Z", activityState: "running" },
      { id: "b", provider: "codex", resumeSessionId: "b", updatedAt: "2026-10-11T10:00:00Z", lastActivityAt: "2026-10-15T10:00:00Z" }
    ] },
    { id: "project:p2", groupKind: "project", name: "项目二", sessions: [{ id: "c", updatedAt: "2026-10-14T10:00:00Z" }] }
  ]);
  const activity = buildActivitySessions(groups);
  assert.deepEqual(activity.map((session) => session.resumeSessionId || session.id), ["b", "c", "a"]);
  assert.equal(activity[2].projectName, "项目一");
  assert.equal(activity[2].activityState, "running");
  assert.deepEqual(groups[1].sessions.map((session) => session.id), ["a", "b"]);
});

test("decorateSession derives list display fields", () => {
  const decorated = decorateSession({
    id: "session-1",
    name: "Demo",
    inputPreview: "hello",
    cwd: "/tmp/demo"
  });

  assert.equal(decorated.displayTitle, "Demo");
  assert.equal(decorated.displayPreview, "hello");
  assert.equal(decorated.groupName, "demo");
});

test("buildGroupedSessions prefers backend project groups when present", () => {
  const grouped = buildGroupedSessions(
    [],
    [
      {
        name: "demo",
        cwd: "/tmp/demo",
        sessions: [{ id: "session-1", name: "Demo", inputPreview: "", cwd: "/tmp/demo" }]
      }
    ]
  );

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].sessions[0].displayTitle, "Demo");
});

test("buildGroupedSessions falls back to local grouping when project groups are absent", () => {
  const grouped = buildGroupedSessions([
    { id: "a", name: "A", inputPreview: "", cwd: "/tmp/demo-a", updatedAt: "2026-04-27T10:00:00.000Z" },
    { id: "b", name: "B", inputPreview: "", cwd: "/tmp/demo-a", updatedAt: "2026-04-28T10:00:00.000Z" }
  ]);

  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].sessions.map((session) => session.id), ["b", "a"]);
});

test("project IDs distinguish same-named groups and preserve backend order", () => {
  const groups = buildGroupedSessions([], [
    { id: "project:b", name: "same", cwd: "/tmp/same", sessions: [] },
    { id: "project:a", name: "same", cwd: "/tmp/same", sessions: [] }
  ]);
  assert.deepEqual(groups.map(sessionGroupKey), ["project:b", "project:a"]);
});

test("existing groups do not hide projectless sessions or duplicate live thread identities", () => {
  const groups = buildGroupedSessions([
    { id: "live-a", provider: "codex", resumeSessionId: "a", cwd: "/tmp/a" },
    { id: "history:codex:b", provider: "codex", resumeSessionId: "b", cwd: "/tmp/b", name: "ungrouped" }
  ], [{ id: "project:a", name: "a", sessions: [{ id: "history:codex:a", provider: "codex", resumeSessionId: "a" }] }]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].sessions.length, 1);
  assert.equal(groups[1].groupKind, "recent");
  assert.equal(groups[1].sessions[0].displayTitle, "ungrouped");
});

test("mergeSessionTitlesIntoCache only stores non-empty titles", () => {
  const sessionCache = {};
  mergeSessionTitlesIntoCache(
    [
      { id: "session-1", kind: "live", name: "Demo" },
      { id: "session-2", kind: "live", name: "" }
    ],
    sessionCache
  );

  assert.equal(sessionCache[cacheKey({ id: "session-1", kind: "live" })].title, "Demo");
  assert.equal(cacheKey({ provider: "codex", kind: "thread", resumeSessionId: "thread-1" }), "thread:codex:thread-1");
  assert.equal(sessionCache[cacheKey({ id: "session-2", kind: "live" })], undefined);
});

function compileComponent(file) {
  const { descriptor } = parse(fs.readFileSync(file, 'utf8'), { filename: file.pathname });
  const source = compileScript(descriptor, { id: file.pathname, inlineTemplate: true }).content.replace(/from\s+["']([^"']+)["']/g, (_, name) => {
    const target = name === 'vue' ? import.meta.resolve('vue') : name.endsWith('.vue') ? compileComponent(new URL(name, file)) : new URL(name, file).href;
    return `from ${JSON.stringify(target)}`;
  });
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const List = (await import(compileComponent(new URL('../web/src/components/SessionListView.vue', import.meta.url)))).default;
function mountList(t, groups, props = {}) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousDocumentClass = globalThis.Document, previousShadowRoot = globalThis.ShadowRoot;
  globalThis.Document = class TestDocument {};
  globalThis.ShadowRoot = class TestShadowRoot {};
  const page = { x: 0, y: 0, height: 12000, width: 1200, viewport: 800, writes: [], windowWrites: [], frames: new Map(), nextFrame: 0,
    rowTops: new Map(), listeners: new Map() };
  globalThis.document = Object.assign(new Document(), { activeElement: null,
    documentElement: { clientHeight: page.viewport, clientWidth: page.width },
    scrollingElement: { get scrollHeight() { return page.height; }, get scrollWidth() { return page.width; } }
  });
  const preference = new Map();
  globalThis.window = { localStorage: { getItem: (k) => preference.get(k), setItem: (k,v) => preference.set(k,v) },
    scrollX: 0, scrollY: 0, innerHeight: page.viewport,
    scrollTo({left,top}) { page.windowWrites.push({left,top}); },
    requestAnimationFrame(callback) { const id=++page.nextFrame;page.frames.set(id,callback);return id; },
    cancelAnimationFrame(id) { page.frames.delete(id); },
    addEventListener(name,callback) { page.listeners.set(name,callback); },
    removeEventListener(name,callback) { if(page.listeners.get(name)===callback)page.listeners.delete(name); }
  };
  const renderer = createRenderer({
    createElement: (type) => markRaw({type, props:{}, children:[], listeners:{}, value:"", clientTop: 2,
      get scrollLeft() { return page.x; }, set scrollLeft(value) { page.x=value; },
      get scrollTop() { return page.y; }, set scrollTop(value) { page.y=value; },
      get scrollWidth() { return page.width; }, get scrollHeight() { return page.height; },
      get clientWidth() { return page.width; }, get clientHeight() { return page.viewport; },
      scrollTo({left,top}) { page.x=left;page.y=top;page.writes.push({left,top}); },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      dispatchEvent(event) { this.listeners[event.type]?.({ target: this, type: event.type }); },
      getRootNode() { return document; },
      focus() { document.activeElement = this; },
      getAttribute(name) { return this.props[name] ?? null; },
      closest(selector) { const attr=selector.slice(1,-1);for(let node=this;node;node=node.parent)if(node.props?.[attr]!=null)return node;return null; },
      querySelectorAll(selector) { const attr=selector.slice(1,-1),visit=node=>(node.children||[]).flatMap(child=>[...(child.props?.[attr]!=null?[child]:[]),...visit(child)]);return visit(this); },
      getBoundingClientRect() { const isScreen=String(this.props.class||'').split(' ').includes('session-screen');const top=isScreen?30:32+(page.rowTops.get(this.props['data-session-id'])||0)-page.y;return {top,bottom:top+(isScreen?page.viewport:60)}; }
    }), createText: (text) => ({text}), createComment: (text) => ({text}),
    setText: (node,text) => {node.text=text;}, setElementText: (node,text) => {node.text=text;node.children=[];},
    parentNode: (node) => node.parent, nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node)+1] || null,
    insert(node,parent,anchor) { if(node.parent) node.parent.children=node.parent.children.filter(x=>x!==node);node.parent=parent;const index=anchor?parent.children.indexOf(anchor):-1;if(index<0)parent.children.push(node);else parent.children.splice(index,0,node); },
    remove: (node) => {node.parent.children=node.parent.children.filter(x=>x!==node);}, patchProp: (node,key,prev,next) => {node.props[key]=next;}
  });
  const root={children:[]}, opened=[], retries=[], searches=[];
  let currentGroups = groups;
  const update=(next=currentGroups)=>{
    currentGroups = next;
    renderer.render(h(List,{...props,groups:next,formatRelativeTime:(value)=>value||'',onOpen:(session)=>opened.push(session.id),
      onRetry:()=>retries.push(true), 'onUpdate:searchQuery':(value)=>{props.searchQuery=value;searches.push(value);}}),root);
  };
  update();t.after(()=>{
    renderer.render(null,root);globalThis.window=previousWindow;
    for(const [key,value]of Object.entries({document:previousDocument,Document:previousDocumentClass,ShadowRoot:previousShadowRoot})){
      if(value===undefined)delete globalThis[key];else globalThis[key]=value;
    }
  });
  const find=(predicate,node=root)=>[...(predicate(node)?[node]:[]),...(node.children||[]).flatMap(child=>find(predicate,child))];
  const byClass=(cls)=>find(node=>String(node.props?.class||'').split(' ').includes(cls));
  return {root,update,find,byClass,opened,retries,searches,preference,page,
    flushFrames(){const callbacks=[...page.frames.values()];page.frames.clear();for(const callback of callbacks)callback();},
    setProps(patch){Object.assign(props,patch);update();},
    remount(patch={}){renderer.render(null,root);Object.assign(props,patch);update();},
    renderComponent(component){renderer.render(null,root);renderer.render(h(component),root);}};
}
const fixtures=(count)=>Array.from({length:count},(_,index)=>({id:`s-${index}`,provider:'codex',resumeSessionId:`s-${index}`,displayTitle:`会话 ${index}`,updatedAt:new Date(Date.UTC(2026,9,16,0,index)).toISOString()}));
const nodeText=node=>node.type==='comment'||node.text==='v-if'||node.props?.['aria-hidden']==='true'?'':[node.text||'',...(node.children||[]).map(nodeText)].join('');

function retainedListState() {
  return reactive(createSessionListViewState());
}

test('the real list root is the marked, keyboard-focusable scrolling region',async(t)=>{
  const ui=mountList(t,[{id:'a',name:'Project',sessions:fixtures(45)}]);
  const screen=ui.byClass('session-screen')[0];
  assert.equal(screen.props.tabindex,'0');
  assert.equal(screen.props['aria-label'],'会话列表');
  assert.ok(Object.hasOwn(screen.props,'data-app-scroll'));
  screen.focus();assert.equal(document.activeElement,screen);
  ui.page.y=1900;ui.remount();await nextTick();ui.flushFrames();
  assert.equal(ui.page.y,1900);
  assert.equal(ui.page.windowWrites.length,0,'list restoration never scrolls the document');
});

test('returning during the search debounce submits the retained query on the new paged view',async(t)=>{
  const contexts=[];
  const pagination=reactive({view:'groups',query:'',revision:'r1',page:{runningTotal:0,activitiesTotal:1},
    loading:false,loadingGroups:new Set(),groupErrors:new Map()});
  const ui=mountList(t,[],{loaded:true,pagination,onCatalogView:context=>contexts.push(context)});
  enterSearch(ui,'needle');await nextTick();
  ui.remount({searchQuery:'needle'});await nextTick();
  assert.deepEqual(contexts,[{view:'groups',query:'needle',runningOnly:false}]);
  pagination.query='needle';
  ui.update([{id:'a',name:'Project',sessions:fixtures(1),catalogPage:{total:1,running:0,nextCursor:null}}]);
  await nextTick();
  assert.equal(ui.byClass('session-row').length,1);
  assert.equal(ui.byClass('state-loading').length,0);
  await new Promise(resolve=>setTimeout(resolve,270));
  assert.equal(contexts.length,1,'the cancelled previous instance cannot issue a late duplicate search');
});

test('paged groups fetch only near the viewport while expanded and disconnect observers on exit',async(t)=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'IntersectionObserver'),observers=[];
  Object.defineProperty(globalThis,'IntersectionObserver',{configurable:true,value:class {
    constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}
    observe(element){this.element=element;}
    disconnect(){this.disconnected=true;}
  }});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'IntersectionObserver',previous);else delete globalThis.IntersectionObserver;});
  const loads=[];
  const pagination=reactive({view:'groups',query:'',revision:'r1',page:{runningTotal:0,activitiesTotal:10},
    loading:false,loadingGroups:new Set(),groupErrors:new Map()});
  const ui=mountList(t,[{id:'a',name:'Project',collapsed:true,sessions:[],catalogPage:{total:10,running:0,nextCursor:'page'}}],
    {loaded:true,pagination,onLoadGroup:context=>loads.push(context)});
  await nextTick();assert.equal(loads.length,0);
  const observer=observers[0];observer.callback([{target:observer.element,isIntersecting:true}]);
  assert.equal(loads.length,0,'visible but folded groups do not request records');
  ui.byClass('session-group-toggle-area')[0].props.onClick();await nextTick();
  assert.deepEqual(loads,[{key:'a'}]);
  ui.renderComponent({render:()=>null});await nextTick();
  assert.equal(observer.disconnected,true);
  observer.callback([{target:observer.element,isIntersecting:true}]);
  assert.equal(loads.length,1);
});

test('reaching a group page end loads once after user scroll intent, with explicit retry after failure',async(t)=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'IntersectionObserver'),observers=[];
  Object.defineProperty(globalThis,'IntersectionObserver',{configurable:true,value:class {
    constructor(callback){this.callback=callback;observers.push(this);}
    observe(element){this.element=element;}
    disconnect(){this.disconnected=true;}
  }});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'IntersectionObserver',previous);else delete globalThis.IntersectionObserver;});
  const loads=[];
  const pagination=reactive({view:'groups',query:'',revision:'r1',page:{runningTotal:0,activitiesTotal:30},
    loading:false,loadingGroups:new Set(),groupErrors:new Map()});
  const ui=mountList(t,[{id:'a',name:'Project',sessions:fixtures(5),catalogPage:{total:30,running:0,nextCursor:'page1'}}],
    {loaded:true,pagination,onLoadGroup:context=>loads.push(context)});
  await nextTick();
  const observer=observers.find(item=>String(item.element?.props.class).includes('session-show-more'));
  const enter=()=>observer.callback([{target:observer.element,isIntersecting:true}]);
  enter();assert.equal(loads.length,0,'initial viewport intersection does not drain history');
  pagination.loading=true;await nextTick();
  ui.byClass('session-screen')[0].props.onWheelPassive({type:'wheel',deltaY:20});
  assert.equal(loads.length,0,'refresh in progress defers an existing user reach');
  pagination.loading=false;await nextTick();
  assert.deepEqual(loads,[{key:'a',more:true}]);
  enter();assert.equal(loads.length,1,'repeated intersections do not replay the same cursor');
  pagination.loadingGroups.add('a');
  ui.update([{id:'a',name:'Project',sessions:fixtures(25),catalogPage:{total:30,running:0,nextCursor:'page2'}}]);
  await nextTick();enter();
  pagination.groupErrors.set('a','offline');
  pagination.loadingGroups.delete('a');await nextTick();
  pagination.groupErrors.clear();
  ui.update([{id:'a',name:'Project',sessions:fixtures(25),catalogPage:{total:30,running:0,nextCursor:'refreshed-page2'}}]);
  await nextTick();assert.equal(loads.length,1,'clearing an error during background refresh cannot resume a failed reach');
  ui.byClass('session-show-more')[0].props.onClick();assert.equal(loads.length,2);
});

test('returning with the same view state retains groups, older entries and explicit collapse across polling', async(t)=>{
  const group={id:'a',name:'Project',sessions:fixtures(45)},viewState=retainedListState();
  const ui=mountList(t,[group],{viewState});
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  ui.byClass('session-row')[5].props.onClick();assert.deepEqual(ui.opened,['s-5']);
  ui.remount();await nextTick();
  assert.equal(ui.byClass('session-row').length,45);
  ui.byClass('session-group-toggle-area')[0].props.onClick();await nextTick();
  ui.update([{...group,sessions:fixtures(46)}]);await nextTick();
  ui.remount();await nextTick();
  assert.equal(ui.byClass('session-row').length,0);
  ui.byClass('session-group-toggle-area')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,46);
  const staleToggle=ui.byClass('session-show-more')[0].props.onClick;
  const nextIdentity=retainedListState();
  ui.remount({viewState:nextIdentity});await nextTick();
  assert.equal(ui.byClass('session-row').length,5);
  staleToggle();await nextTick();
  assert.equal(ui.byClass('session-row').length,5,'an old instance cannot expand the next identity');
  assert.equal(nextIdentity.expandedLists.size,0);
  assert.equal(nextIdentity.localExpansion.size,0);
});

test('returning retains independent activity and search pages while changed queries reset only search paging',async(t)=>{
  const ui=mountList(t,[{id:'a',name:'Project',sessions:fixtures(75)}],{viewState:retainedListState()});
  ui.find(node=>node.type==='button'&&node.text==='最近活动')[0].props.onClick();await nextTick();
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  ui.byClass('session-row')[20].props.onClick();assert.deepEqual(ui.opened,['s-54']);
  ui.remount();await nextTick();
  assert.equal(ui.byClass('session-row').length,40);
  enterSearch(ui,'会话');await nextTick();
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  ui.remount();await nextTick();
  assert.equal(ui.byClass('session-row').length,40);
  enterSearch(ui,'Project');await nextTick();
  assert.equal(ui.byClass('session-row').length,20);
  ui.byClass('session-search-clear')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,40);
  ui.remount({viewState:retainedListState(),searchQuery:''});await nextTick();
  assert.equal(ui.byClass('session-row').length,20,'a new identity starts a fresh page');
});

test('returning preserves search group and session batches, search collapse and a changed offscreen query',async(t)=>{
  const groups=Array.from({length:45},(_,index)=>({id:'p-'+index,name:'Project branch-'+index,collapsed:true,
    sessions:fixtures(35).map(session=>({...session,id:index+'-'+session.id,resumeSessionId:index+'-'+session.id}))}));
  const viewState=retainedListState(),ui=mountList(t,groups,{viewState});
  enterSearch(ui,'Project');await nextTick();
  ui.byClass('session-more-projects')[0].props.onClick();await nextTick();
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  ui.byClass('session-group-toggle-area')[1].props.onClick();await nextTick();
  ui.remount();await nextTick();
  assert.equal(ui.byClass('session-group').length,40);
  assert.equal(ui.byClass('session-row').length,25+38*5);
  ui.update(groups.map(group=>({...group,sessions:[...group.sessions]})));await nextTick();
  assert.equal(ui.byClass('session-row').length,25+38*5);
  ui.remount({searchQuery:'branch-4'});await nextTick();
  assert.equal(ui.byClass('session-group').length,6);
  assert.equal(ui.byClass('session-row').length,30,'changing the query while unmounted resets its batches and collapse');
  ui.byClass('session-search-clear')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,0,'normal collapsed groups remain independent');
});

async function flushApp() { for(let index=0;index<60;index+=1) await Promise.resolve();await nextTick(); }

test('App retains list state on navigation and replaces it on identity expiry and login',async(t)=>{
  const group={id:'a',name:'Project',sessions:fixtures(45)},ui=mountList(t,[]),listeners=new Map(),views=[];
  const catalog=createSessionCatalogPages({loadSnapshot:async()=>({sessions:group.sessions,projectGroups:[group]})});
  const viewportProperties=new Map();
  document.documentElement.style={getPropertyValue:name=>viewportProperties.get(name)||'',getPropertyPriority:()=>'',
    setProperty:(name,value)=>viewportProperties.set(name,value),removeProperty:name=>viewportProperties.delete(name)};
  const route=reactive({name:'sessions',params:{},query:{},fullPath:'/sessions'});
  const navigate=async(target)=>{
    if(typeof target==='string')target={name:target.replace(/^\//,'')};
    Object.assign(route,{params:{},query:{},...target});
  };
  Object.assign(window,{location:{protocol:'http:',host:'localhost'},
    addEventListener:(name,callback)=>listeners.set(name,callback),removeEventListener:(name)=>listeners.delete(name),
    setInterval:()=>1,clearInterval(){},setTimeout,clearTimeout});
  window.visualViewport={height:719.625,offsetTop:0,
    addEventListener:(name,callback)=>listeners.set('visual-'+name,callback),removeEventListener:name=>listeners.delete('visual-'+name)};
  window.localStorage.removeItem=(key)=>ui.preference.delete(key);
  const previewFrames=new Map(),previewScheduled=[],previewScrolls=[],previewFocus=[];let previewFrameId=0,positionInvalidations=0;
  const preview=createPreviewController({request:async()=>({id:'file',kind:'file',url:'http://localhost:8444/preview/file'}),
    window:{scrollX:0,scrollY:7,scrollTo:(...args)=>previewScrolls.push(args),
      requestAnimationFrame(callback){previewFrames.set(++previewFrameId,callback);previewScheduled.push(callback);return previewFrameId;},
      cancelAnimationFrame(id){previewFrames.delete(id);}},
    document:{activeElement:{isConnected:true,focus:options=>previewFocus.push(options)},querySelectorAll:()=>[]}});
  globalThis.__listContinuityTest={route,router:{push:navigate,replace:navigate},views,List,preview,
    invalidatePosition(){positionInvalidations++;preview.invalidatePosition();},
    requestAuthSession:async()=>({authenticated:true}),request:async(url)=>url.startsWith('/api/session-catalog?')
      ? catalog.read(new URL(url,'http://localhost').searchParams) : {} };
  t.after(()=>{delete globalThis.__listContinuityTest;});
  const asModule=(source)=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const realApi=await import('../web/src/lib/api.js');
  const api=asModule(Object.keys(realApi).map(name=>name==='AUTH_EXPIRED_EVENT'
    ? "export const AUTH_EXPIRED_EVENT='codex-auth-expired';"
    : `export const ${name}=(...args)=>globalThis.__listContinuityTest.${name}?.(...args);`).join('\n'));
  const overrides={
    './lib/api.js':api,
    'vue-router':asModule('export const useRoute=()=>globalThis.__listContinuityTest.route;export const useRouter=()=>globalThis.__listContinuityTest.router;'),
    './lib/async-view.js':asModule(`import {h} from ${JSON.stringify(import.meta.resolve('vue'))};
      export function defineAppView(loader){const name=loader.toString().match(/components\\/(\\w+)/)[1];
        const view=name==='SessionListView'?globalThis.__listContinuityTest.List:{setup(_props,{emit}){
          globalThis.__listContinuityTest.views.push({name,emit});return()=>h(name);}};
        view.preload=()=>Promise.resolve(true);return view;}`),
    './lib/preview.js':asModule('export const previewState=globalThis.__listContinuityTest.preview.state;export const closeLocalPreview=()=>globalThis.__listContinuityTest.preview.close();export const invalidateLocalPreviewPosition=()=>globalThis.__listContinuityTest.invalidatePosition();'),
    './components/preview/PreviewHost.vue':asModule('export default {render(){return null;}};')
  };
  const file=new URL('../web/src/App.vue',import.meta.url);
  const {descriptor}=parse(fs.readFileSync(file,'utf8'),{filename:file.pathname});
  const compiled=compileScript(descriptor,{id:'list-continuity-app',inlineTemplate:true}).content;
  const source=compiled.replace(/from\s+["']([^"']+)["']/g,(_match,name)=>`from ${JSON.stringify(overrides[name]||
    (name==='vue'?import.meta.resolve('vue'):new URL(name,file).href))}`);
  const App=(await import(asModule(source))).default;
  ui.renderComponent(App);await flushApp();
  assert.equal(viewportProperties.get('--app-viewport-height'),'719.625px');
  window.visualViewport.height=348.875;listeners.get('visual-resize')();
  assert.equal(viewportProperties.get('--app-viewport-height'),'348.875px');
  const oldViewportResize=listeners.get('visual-resize');
  const state=window.__codexWebDebug.state;
  const beforeSamePage=positionInvalidations;
  state.sessionSearch='Project';await flushApp();state.sessionSearch='';await flushApp();
  await preview.open({target:'/tmp/report.pdf'});preview.frameLoaded(preview.state.revision);await flushApp();
  assert.equal(positionInvalidations,beforeSamePage,'search and preview status do not invalidate same-page position');
  preview.close();const queuedOldPosition=previewScheduled.at(-1);
  const previousState=state.sessionListViewState;
  ui.byClass('session-show-more')[0].props.onClick();await flushApp();
  assert.equal(ui.byClass('session-row').length,25,'the real App requests another server page');
  const staleToggle=ui.byClass('session-show-more')[0].props.onClick;
  staleToggle();await flushApp();
  assert.equal(ui.byClass('session-row').length,45);
  ui.page.rowTops.set('s-30',2340);ui.page.y=2300;
  const beforeRoutePosition=positionInvalidations;
  route.name='chat';route.params={sessionId:'history:codex:test-thread'};
  assert.ok(positionInvalidations>beforeRoutePosition,'App invalidates preview position synchronously on route change');
  queuedOldPosition();
  assert.equal(previewScrolls.length,0);assert.equal(previewFocus.length,0);
  await flushApp();
  assert.equal(previousState.position.top,2300,'unmount captures the old state after the route generation changes');
  ui.page.y=0;
  await preview.open({target:'/tmp/report.pdf'});
  views.findLast(view=>view.name==='CodexThreadView').emit('back');await flushApp();
  ui.flushFrames();
  assert.equal(ui.page.y,2300,'the actual App back handler restores the list page');
  assert.equal(preview.state.open,true,'route invalidation retains the preview panel');
  preview.close();for(const callback of [...previewFrames.values()])callback();previewFrames.clear();
  assert.equal(previewScrolls.length,0,'closing the old chat preview cannot overwrite the returned list');
  assert.equal(ui.byClass('session-row').length,45);
  assert.equal(state.sessionListViewState,previousState);
  route.name='chat';route.params={sessionId:'history:codex:test-thread'};await flushApp();
  ui.page.y=0;
  views.findLast(view=>view.name==='CodexThreadView').emit('back');await flushApp();
  const beforeRouteChange=ui.page.writes.length;
  route.name='chat';route.params={sessionId:'history:codex:other-thread'};
  ui.flushFrames();
  assert.equal(ui.page.writes.length,beforeRouteChange,'the immediate route getter cancels before queued App cleanup');
  await flushApp();
  views.findLast(view=>view.name==='CodexThreadView').emit('back');await flushApp();ui.flushFrames();
  enterSearch(ui,'Project');await new Promise(resolve=>setTimeout(resolve,270));await flushApp();
  ui.byClass('session-show-more')[0].props.onClick();await flushApp();
  assert.equal(state.sessionSearch,'Project');
  assert.equal(ui.byClass('session-row').length,25);
  route.name='chat';route.params={sessionId:'history:codex:test-thread'};await flushApp();
  views.findLast(view=>view.name==='CodexThreadView').emit('back');await flushApp();
  const beforeAuthChange=ui.page.writes.length;
  await preview.open({target:'/tmp/report.pdf'});
  const beforeAuthPosition=positionInvalidations;
  listeners.get('codex-auth-expired')();ui.flushFrames();
  assert.ok(positionInvalidations>beforeAuthPosition,'App invalidates preview position synchronously on identity change');
  previewScheduled.at(-1)();
  assert.equal(previewScrolls.length,0);assert.equal(previewFocus.length,0);assert.equal(previewFrames.size,0);
  assert.equal(ui.page.writes.length,beforeAuthChange,'auth invalidation prevents a pending old-instance restore before flush');
  await flushApp();
  assert.notEqual(state.sessionListViewState,previousState);
  assert.equal(state.sessionSearch,'');
  assert.equal(state.sessionListViewState.searchQuery,'');
  assert.equal(state.sessionListViewState.searchLimits.size,0);
  assert.equal(state.sessionListViewState.expandedLists.size,0);
  assert.equal(state.sessionListViewState.position,null);
  state.accessToken='synthetic-test-token';
  views.findLast(view=>view.name==='LoginView').emit('submit');await flushApp();
  assert.equal(state.isAuthenticated,true);
  assert.equal(ui.byClass('session-row').length,5);
  staleToggle();await nextTick();
  assert.equal(ui.byClass('session-row').length,5);
  ui.renderComponent({render:()=>null});await flushApp();
  assert.equal(viewportProperties.size,0);
  assert.equal(listeners.size,0,'App removes its auth and viewport listeners at unmount');
  oldViewportResize();assert.equal(viewportProperties.size,0,'a late old viewport callback cannot write after App unmount');
});

test('legacy Response to API to App and List keeps early rows usable, cancels leave, and recovers full preview search after a tail failure',async(t)=>{
  const ui=mountList(t,[]),previousFetch=globalThis.fetch,listeners=new Map(),intervals=new Set(),streams=[];
  const route=reactive({name:'sessions',params:{},query:{},fullPath:'/sessions'});
  const navigate=async(target)=>Object.assign(route,{params:{},query:{},...target});
  const sessions=fixtures(31).map((session,index)=>({...session,kind:'thread',name:`会话 ${index}`,
    inputPreview:index===30?'oldest hidden preview':`preview ${index}`,activityState:index<2?'running':'idle',
    updatedAt:new Date(Date.UTC(2026,9,16,0,31-index)).toISOString()}));
  const group={id:'project:a',name:'Project',cwd:'/project',groupKind:'project'};
  const payload={sidebarFormat:'compact-v1',sessions,projectGroups:[{...group,sessionIds:sessions.map(session=>session.id)}]};
  const counts={sessionsTotal:31,activitiesTotal:31,runningTotal:2,groups:[{key:group.id,total:31,running:2}]};
  const common={protocol:'session-sidebar-progressive-v1',snapshotId:'A'.repeat(43)};
  const bootstrap={...common,type:'bootstrap',complete:false,counts,payload:{...payload,sessions:sessions.slice(0,20),
    projectGroups:[{...group,sessionIds:sessions.slice(0,20).map(session=>session.id)}]}};
  const complete={...common,type:'complete',complete:true,payload};
  const send=(stream,frame)=>stream.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
  const properties=new Map();document.documentElement.style={getPropertyValue:name=>properties.get(name)||'',getPropertyPriority:()=>'',
    setProperty:(name,value)=>properties.set(name,value),removeProperty:name=>properties.delete(name)};
  Object.assign(window,{location:{protocol:'http:',host:'localhost'},
    addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:name=>listeners.delete(name),
    setInterval:()=>{const id={};intervals.add(id);return id;},clearInterval:id=>intervals.delete(id),setTimeout,clearTimeout});
  globalThis.__progressiveListApp={route,router:{push:navigate,replace:navigate},List};
  globalThis.fetch=async(url,options)=>{
    if(url.startsWith('/api/sessions?')) {
      const stream={url,signal:options.signal,cancelled:0};
      const body=new ReadableStream({start(controller){stream.controller=controller;},cancel(){stream.cancelled++;}});
      stream.body=body;streams.push(stream);return new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
    }
    return new Response(JSON.stringify(url==='/api/auth/session'?{authenticated:true}:{}),{headers:{'Content-Type':'application/json'}});
  };
  const module=(source)=>`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const overrides={
    './lib/session-runtime.js':module(`import {createSessionRuntimeController as create} from ${JSON.stringify(new URL('../web/src/lib/session-runtime.js',import.meta.url).href)};
      export const createSessionRuntimeController=options=>create({...options,pagedCatalog:false});`),
    'vue-router':module('export const useRoute=()=>globalThis.__progressiveListApp.route;export const useRouter=()=>globalThis.__progressiveListApp.router;'),
    './lib/async-view.js':module(`import {h} from ${JSON.stringify(import.meta.resolve('vue'))};
      export function defineAppView(loader){const name=loader.toString().match(/components\\/(\\w+)/)[1];
        const view=name==='SessionListView'?globalThis.__progressiveListApp.List:{render(){return h(name);}};
        view.preload=()=>Promise.resolve(true);return view;}`),
    './lib/preview.js':module('export const previewState={open:false};export const closeLocalPreview=()=>{};export const invalidateLocalPreviewPosition=()=>{};'),
    './components/preview/PreviewHost.vue':module('export default {render(){return null;}};')
  };
  const file=new URL('../web/src/App.vue',import.meta.url),{descriptor}=parse(fs.readFileSync(file,'utf8'),{filename:file.pathname});
  const compiled=compileScript(descriptor,{id:'stream-list-app',inlineTemplate:true}).content;
  const source=compiled.replace(/from\s+["']([^"']+)["']/g,(_match,name)=>`from ${JSON.stringify(overrides[name]||
    (name==='vue'?import.meta.resolve('vue'):new URL(name,file).href))}`);
  try {
    const App=(await import(module(source))).default;ui.renderComponent(App);await flushApp();
    assert.equal(streams.length,1);assert.equal(streams[0].url,'/api/sessions?compact=1&progressive=1');
    send(streams[0],bootstrap);await flushApp();
    assert.equal(ui.byClass('session-row').length,5);assert.equal(ui.byClass('session-group-count')[0].text,'31');
    assert.equal(nodeText(ui.byClass('session-running-count')[0]),'2 个运行中');
    assert.equal(ui.byClass('session-group-add')[0].props.disabled,true);
    ui.byClass('session-row')[0].props.onClick();await flushApp();
    assert.equal(route.name,'chat');assert.equal(route.params.sessionId,'history:codex:s-0');
    assert.equal(streams[0].signal.aborted,true);assert.equal(streams[0].body.locked,false);assert.equal(streams[0].cancelled,1);
    route.name='sessions';await flushApp();assert.equal(streams.length,2);
    assert.equal(ui.byClass('session-row').length,5,'reentry retains the readable first batch');
    send(streams[1],bootstrap);await flushApp();enterSearch(ui,'oldest hidden preview');await flushApp();
    assert.equal(ui.byClass('session-row').length,0);assert.equal(ui.byClass('session-search-count').length,0);
    assert.equal(ui.byClass('state-empty').length,0);assert.equal(ui.byClass('state-loading').length,1);
    streams[1].controller.close();await flushApp();
    assert.equal(ui.byClass('session-list-error').length,1);assert.equal(ui.byClass('state-empty').length,0);
    assert.equal(ui.byClass('session-list-error')[0].children.find(node=>node.type==='span').text,'会话列表尚未完整加载，请重试。');
    assert(window.__codexWebDebug.state.sessionListError.cause instanceof Error);
    assert.equal(window.__codexWebDebug.state.sessionListComplete,false);
    ui.byClass('session-list-error')[0].children.find(node=>node.type==='button').props.onClick();await flushApp();
    assert.equal(streams.length,3);send(streams[2],bootstrap);send(streams[2],{...complete,protocol:'wrong'});streams[2].controller.close();await flushApp();
    assert.equal(ui.byClass('session-list-error')[0].children.find(node=>node.type==='span').text,'会话列表尚未完整加载，请重试。');
    assert.equal(window.__codexWebDebug.state.sessionListComplete,false);assert.equal(ui.byClass('state-empty').length,0);
    ui.byClass('session-list-error')[0].children.find(node=>node.type==='button').props.onClick();await flushApp();
    assert.equal(streams.length,4);send(streams[3],bootstrap);send(streams[3],complete);streams[3].controller.close();await flushApp();
    assert.equal(ui.byClass('session-row').length,1);assert.equal(ui.byClass('session-row')[0].props['data-session-id'],'s-30');
    assert.equal(ui.byClass('session-search-count')[0].text,'1 个匹配会话');
    assert.equal(ui.byClass('session-group-add')[0].props.disabled,false);
    assert.equal(window.__codexWebDebug.state.sessionListComplete,true);assert.equal(window.__codexWebDebug.state.sessionListCounts,null);
    assert.equal(ui.byClass('session-list-error').length,0);assert.equal(window.__codexWebDebug.state.statusText,'');
  } finally {
    ui.renderComponent({render:()=>null});
    for(const stream of streams)try{stream.controller.close();}catch{/* Closed or cancelled. */}
    await flushApp();globalThis.fetch=previousFetch;delete globalThis.__progressiveListApp;
    assert.equal(intervals.size,0);assert.equal(listeners.size,0);assert.equal(properties.size,0);
    assert(streams.every(stream=>!stream.body.locked),'every owned Response reader is released');
  }
});

for(const mode of ['groups','activity']) {
  test(`${mode} list lifecycle restores a searched row once and a changed offscreen query cancels it`,async(t)=>{
    const group={id:'project:a',name:'Project',sessions:fixtures(45)},viewState=retainedListState();
    const ui=mountList(t,[group],{viewState,searchQuery:'Project'});
    if(mode==='activity')ui.find(node=>node.type==='button'&&node.text==='最近活动')[0].props.onClick();
    await nextTick();
    ui.byClass('session-show-more')[0].props.onClick();await nextTick();
    ui.byClass('session-show-more')[0].props.onClick();await nextTick();
    assert.equal(ui.byClass('session-row').length,45);
    ui.page.rowTops.set('s-30',2340);ui.page.y=2300;
    ui.remount();ui.page.y=0;ui.page.rowTops.set('s-30',2740);await nextTick();ui.flushFrames();
    assert.equal(ui.page.y,2700);
    assert.equal(viewState.position.mode,mode);
    assert.equal(ui.byClass('session-row').length,45);
    const count=ui.page.writes.length;
    ui.page.y=700;ui.update([{...group,sessions:[...group.sessions]}]);await nextTick();ui.flushFrames();
    assert.equal(ui.page.y,700);assert.equal(ui.page.writes.length,count,'polling cannot replay the restore');
    ui.remount({searchQuery:'no-match'});ui.page.y=0;await nextTick();ui.flushFrames();
    assert.equal(ui.byClass('session-row').length,0);assert.equal(ui.page.writes.length,count);
  });
}

test('list waits for loaded content and user interaction cancels its deferred restore',async(t)=>{
  const group={id:'a',name:'Project',sessions:fixtures(45)},viewState=retainedListState();
  const ui=mountList(t,[group],{viewState});
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  ui.page.y=1900;ui.remount({loaded:false});ui.page.y=0;await nextTick();ui.flushFrames();
  assert.equal(ui.page.writes.length,0);
  ui.setProps({loaded:true});await nextTick();
  ui.page.listeners.get('wheel')({type:'wheel'});ui.flushFrames();
  assert.equal(ui.page.writes.length,0);assert.equal(ui.page.frames.size,0);assert.equal(ui.page.listeners.size,0);
});

test('replacing the auth view object cancels pending work and leaves old-instance capture isolated',async(t)=>{
  const group={id:'a',name:'Project',sessions:fixtures(45)},oldState=retainedListState();
  const ui=mountList(t,[group],{viewState:oldState});
  ui.page.y=1900;ui.remount();ui.page.y=0;await nextTick();
  const newState=retainedListState();
  ui.setProps({viewState:newState});ui.flushFrames();
  assert.equal(ui.page.writes.length,0);assert.equal(ui.page.listeners.size,0);
  ui.page.y=700;ui.renderComponent({render:()=>null});
  assert.equal(oldState.position.top,700);
  assert.equal(newState.position,null,'unmount saves only the owned object even after props are replaced');
});

test('explicitly collapsing the active group survives background refresh', async(t)=>{
  const group={id:'a',name:'A',collapsed:true,sessions:fixtures(7)};
  const ui=mountList(t,[group],{activeSessionId:'s-0'});
  assert.equal(ui.byClass('session-row').length,5);
  ui.byClass('session-group-toggle-area')[0].props.onClick();await nextTick();
  ui.update([{...group,sessions:[...group.sessions]}]);await nextTick();
  assert.equal(ui.byClass('session-row').length,0);
});

test('groups preview five, expand/collapse independently and retain expansion across list updates',async(t)=>{
  const groups=[{id:'a',name:'A',sessions:fixtures(8)},{id:'b',name:'B',sessions:fixtures(3)}];
  const ui=mountList(t,groups);
  assert.equal(ui.byClass('session-row').length,8);
  assert.equal(ui.byClass('session-show-more').length,1);
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,11);
  ui.update([{...groups[0],sessions:fixtures(9)},groups[1]]);await nextTick();
  assert.equal(ui.byClass('session-row').length,12);
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,8);
});

test('running markers update without confusing unknown state or opening collapsed groups',async(t)=>{
  const group={id:'a',name:'A',collapsed:true,sessions:fixtures(7)};
  group.sessions[6].activityState='running';group.sessions[0].activityState='unknown';
  const ui=mountList(t,[group]);
  assert.equal(ui.byClass('session-row').length,0);
  assert.equal(ui.byClass('session-running-count').length,2);
  ui.byClass('session-group-toggle-area')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,5);
  assert.equal(ui.byClass('session-row-running').length,0);
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row-running').length,1);
  ui.update([{...group,sessions:group.sessions.map(s=>({...s,activityState:'idle'}))}]);await nextTick();
  assert.equal(ui.byClass('session-row-running').length,0);
  assert.equal(ui.byClass('session-running-count').length,0);
});

test('recent activity switches view, opens the same session, pages older entries, and remembers the choice',async(t)=>{
  const group={id:'a',projectId:'a',groupKind:'project',name:'项目',sessions:fixtures(25)};
  const ui=mountList(t,[group]);
  const switchView=ui.find(node=>node.type==='button'&&node.text==='最近活动')[0];
  switchView.props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,20);
  assert.equal(ui.byClass('session-row')[0].props['data-session-id'],'s-24');
  assert.equal(ui.byClass('session-row-project')[0].text,'项目');
  ui.byClass('session-row')[0].props.onClick();assert.deepEqual(ui.opened,['s-24']);
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,25);
  ui.remount();await nextTick();
  assert.equal(ui.find(node=>node.type==='button'&&node.text==='最近活动')[0].props['aria-pressed'],true);
  assert.equal(ui.byClass('session-row').length,20);
  ui.find(node=>node.type==='button'&&node.text==='按项目')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,5);
});

test('running filter opens activity, excludes idle and unknown sessions, and remains clearable when none remain',async(t)=>{
  const sessions=fixtures(4);
  sessions[0].activityState='running';sessions[1].activityState='idle';sessions[2].activityState='unknown';sessions[3].activityState='running';
  const group={id:'a',name:'Project',sessions},ui=mountList(t,[group]);
  const toggle=()=>ui.find(node=>node.type==='button'&&String(node.props?.class||'').split(' ').includes('session-running-count'))[0];
  assert.equal(toggle().props['aria-pressed'],false);
  toggle().props.onClick();await nextTick();
  assert.equal(toggle().props['aria-pressed'],true);
  assert.equal(ui.find(node=>node.type==='button'&&node.text==='最近活动')[0].props['aria-pressed'],true);
  assert.deepEqual(ui.byClass('session-row').map(node=>node.props['data-session-id']),['s-3','s-0']);
  ui.byClass('session-row')[0].props.onClick();assert.deepEqual(ui.opened,['s-3']);
  const stopped={...group,sessions:sessions.map(session=>({...session,activityState:'idle'}))};
  ui.update([stopped]);await nextTick();
  assert.equal(ui.byClass('session-row').length,0);
  assert.equal(toggle().props['aria-pressed'],true);
  assert.equal(nodeText(toggle()),'0 个运行中');
  toggle().props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,4);
  ui.update([group]);await nextTick();
  toggle().props.onClick();await nextTick();
  ui.find(node=>node.type==='button'&&node.text==='按项目')[0].props.onClick();await nextTick();
  assert.equal(toggle().props['aria-pressed'],false);
  assert.equal(ui.byClass('session-row').length,4);
});

test('search keeps the running filter visible and clearing it preserves the query, including an empty running result',async(t)=>{
  const sessions=fixtures(3).map((session,index)=>({...session,
    displayTitle:index<2?'needle task':'unrelated task',activityState:index===1?'idle':'running'}));
  const group={id:'a',name:'Project',sessions},ui=mountList(t,[group]);
  const toggle=()=>ui.find(node=>node.type==='button'&&String(node.props?.class||'').split(' ').includes('session-running-count'))[0];
  const ids=()=>ui.byClass('session-row').map(node=>node.props['data-session-id']);
  toggle().props.onClick();await nextTick();
  enterSearch(ui,'needle');await nextTick();
  assert.deepEqual(ids(),['s-0']);
  assert.equal(ui.byClass('session-search-count')[0].text,'1 个匹配会话');
  assert.equal(ui.byClass('session-search-clear').length,1);
  assert.equal(toggle().props['aria-pressed'],true,'search results must not replace the active filter control');
  toggle().props.onClick();await nextTick();
  assert.equal(toggle().props['aria-pressed'],false);
  assert.equal(ui.byClass('session-search-input')[0].value,'needle');
  assert.deepEqual(ui.searches,['needle']);
  assert.deepEqual(ids(),['s-1','s-0']);
  assert.equal(ui.byClass('session-search-count')[0].text,'2 个匹配会话');
  toggle().props.onClick();await nextTick();
  ui.update([{...group,sessions:sessions.map(session=>({...session,activityState:'idle'}))}]);await nextTick();
  assert.deepEqual(ids(),[]);
  assert.equal(ui.byClass('session-search-count')[0].text,'0 个匹配会话');
  assert.equal(toggle().props['aria-pressed'],true);
  assert.match(nodeText(ui.byClass('state-empty')[0]),/没有匹配的运行中会话/);
  assert.match(nodeText(ui.byClass('state-empty')[0]),/试试其他关键词，或关闭运行中筛选/);
  toggle().props.onClick();await nextTick();
  assert.equal(ui.byClass('session-search-input')[0].value,'needle');
  assert.deepEqual(ui.searches,['needle']);
  assert.deepEqual(ids(),['s-1','s-0']);
  assert.equal(ui.byClass('state-empty').length,0);
});

test('paged running toggle requests server filtering and preserves its context in search and return navigation',async(t)=>{
  const contexts=[];
  const pagination=reactive({view:'groups',query:'',runningOnly:false,revision:'r1',page:{runningTotal:25,activitiesTotal:100},
    loading:false,loadingGroups:new Set(),groupErrors:new Map()});
  const ui=mountList(t,[],{loaded:true,pagination,onCatalogView:context=>contexts.push(context)});
  const toggle=()=>ui.find(node=>node.type==='button'&&String(node.props?.class||'').split(' ').includes('session-running-count'))[0];
  toggle().props.onClick();await nextTick();
  assert.deepEqual(contexts,[{view:'activity',query:'',runningOnly:true}]);
  Object.assign(pagination,{view:'activity',runningOnly:true});
  const running=fixtures(2).map(session=>({...session,activityState:'running'}));
  ui.update([{id:'a',name:'Project',sessions:running,catalogPage:{total:100,running:25,nextCursor:null}}]);await nextTick();
  assert.equal(ui.byClass('session-row').length,2);
  assert.equal(nodeText(toggle()),'25 个运行中','the toolbar uses the full server count, not loaded rows');
  ui.remount();await nextTick();
  assert.equal(toggle().props['aria-pressed'],true);
  enterSearch(ui,'needle');await nextTick();
  await new Promise(resolve=>setTimeout(resolve,270));
  assert.deepEqual(contexts.at(-1),{view:'activity',query:'needle',runningOnly:true});
  ui.find(node=>node.type==='button'&&node.text==='按项目')[0].props.onClick();await nextTick();
  assert.deepEqual(contexts.at(-1),{view:'groups',query:'needle',runningOnly:false});
});

test('activity view reorders when actual usage changes and removes a finished running marker',async(t)=>{
  const sessions=fixtures(3);sessions[0].activityState='running';
  const group={id:'a',name:'A',sessions};const ui=mountList(t,[group]);
  ui.find(node=>node.type==='button'&&node.text==='最近活动')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row')[0].props['data-session-id'],'s-2');
  assert.equal(ui.byClass('session-row-running').length,1);
  ui.update([{...group,sessions:sessions.map(s=>s.id==='s-0'?{...s,activityState:'idle',lastActivityAt:'2026-10-16T01:00:00Z'}:s)}]);await nextTick();
  assert.equal(ui.byClass('session-row')[0].props['data-session-id'],'s-0');
  assert.equal(ui.byClass('session-row-running').length,0);
});

test('session search matches normalized words across title, preview, project and paths without changing input',()=>{
  const session={id:'old',provider:'codex',resumeSessionId:'thread',name:'Release Notes',inputPreview:'解决中文输入',cwd:'/work/tools'};
  const groups=[{id:'pinned',groupKind:'pinned',name:'置顶',sessions:[{...session,projectId:'p'}]},
    {id:'project:p',projectId:'p',groupKind:'project',name:'开发平台',cwd:'/work/tools',sessions:[]},
    {id:'other',name:'Other',sessions:[{id:'other',name:'Unrelated'}]}];
  const before=structuredClone(groups),search=createSessionSearch(groups);
  assert.equal(search('  '),groups);
  for(const query of ['ＲＥＬＥＡＳＥ 中文','开发平台 release','/WORK/TOOLS notes','codex thread']){
    assert.deepEqual(search(query).flatMap(group=>group.sessions.map(item=>item.id)),['old']);
  }
  assert.deepEqual(search('missing'),[]);
  assert.deepEqual(search('开发平台').map(group=>group.id),['pinned','project:p']);
  assert.equal(search('release')[0].sessions[0],groups[0].sessions[0]);
  assert.deepEqual(groups,before);
});

function enterSearch(ui,value){const input=ui.byClass('session-search-input')[0];input.value=value;input.listeners.input({target:input});}

test('search reaches hidden old sessions, opens their identity and restores collapse on clear',async(t)=>{
  const group={id:'a',name:'Project',collapsed:true,sessions:fixtures(120)};
  const ui=mountList(t,[group]);
  assert.equal(ui.byClass('session-row').length,0);
  enterSearch(ui,'会话 119');await nextTick();
  assert.equal(ui.byClass('session-row').length,1);
  assert.equal(ui.byClass('session-row')[0].props['data-session-id'],'s-119');
  ui.byClass('session-row')[0].props.onClick();assert.deepEqual(ui.opened,['s-119']);
  ui.byClass('session-search-clear')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,0);
  assert.equal(document.activeElement,ui.byClass('session-search-input')[0]);
  assert.equal(ui.searches.at(-1),'');
});

test('broad group search renders bounded batches and preserves original expansion and query on remount',async(t)=>{
  const group={id:'a',name:'Project',sessions:fixtures(150)};
  const ui=mountList(t,[group]);
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,150);
  enterSearch(ui,'会话');await nextTick();
  assert.equal(ui.byClass('session-row').length,5);
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,25);
  ui.update([{...group,sessions:fixtures(151)}]);await nextTick();
  assert.equal(ui.byClass('session-row').length,25);
  ui.byClass('session-search-clear')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,151,'clearing restores the original expanded list');
  enterSearch(ui,'会话');await nextTick();
  ui.remount();await nextTick();
  assert.equal(ui.byClass('session-search-input')[0].value,'会话');
  assert.equal(ui.byClass('session-row').length,5);
  ui.byClass('session-search-clear')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,5,'a new list instance starts with its usual preview');
});

test('activity search has independent pagination and clearing recovers the previous activity page',async(t)=>{
  const ui=mountList(t,[{id:'a',name:'Project',sessions:fixtures(75)}]);
  ui.find(node=>node.type==='button'&&node.text==='最近活动')[0].props.onClick();await nextTick();
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,40);
  enterSearch(ui,'会话');await nextTick();
  assert.equal(ui.byClass('session-row').length,20);
  ui.byClass('session-show-more')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,40);
  ui.byClass('session-search-input')[0].props.onKeydown({key:'Escape',preventDefault(){}});await nextTick();
  assert.equal(ui.byClass('session-row').length,40);
});

test('matching many projects caps automatic rendering and exposes the remaining groups without losing them',async(t)=>{
  const groups=Array.from({length:70},(_,index)=>({id:'p-'+index,name:'Project '+index,collapsed:true,
    sessions:fixtures(8).map(session=>({...session,id:index+'-'+session.id,resumeSessionId:index+'-'+session.id}))}));
  const ui=mountList(t,groups);
  enterSearch(ui,'Project');await nextTick();
  assert.equal(ui.byClass('session-group').length,20);
  assert.equal(ui.byClass('session-row').length,100);
  ui.byClass('session-more-projects')[0].props.onClick();await nextTick();
  assert.equal(ui.byClass('session-group').length,40);
  assert.equal(ui.byClass('session-row').length,200);
  enterSearch(ui,'Project 69');await nextTick();
  assert.deepEqual(ui.byClass('session-group').map(node=>node.props['data-group-id']),['p-69']);
});

test('search uses Vue composition handling and does not reset an in-progress IME value on list updates',async(t)=>{
  const group={id:'a',name:'Project',sessions:fixtures(3)};
  const ui=mountList(t,[group]),input=ui.byClass('session-search-input')[0];
  input.listeners.compositionstart({target:input});input.value='hui';input.listeners.input({target:input});
  input.props.onKeydown({key:'Escape',target:input,isComposing:true,preventDefault(){assert.fail('IME cancellation must remain native');}});
  await nextTick();ui.update([{...group,sessions:[...group.sessions]}]);await nextTick();
  assert.equal(input.value,'hui');
  assert.equal(ui.byClass('session-row').length,3);
  input.value='会话 2';input.listeners.compositionend({target:input});await nextTick();
  assert.equal(ui.byClass('session-row').length,1);
  assert.equal(ui.byClass('session-row')[0].props['data-session-id'],'s-2');
});

test('partial list displays real counts and usable rows while withholding searches and writes until complete',async(t)=>{
  const sessions=fixtures(6),group={id:'a',name:'Project',cwd:'/project',sessions};
  const counts={sessionsTotal:51,activitiesTotal:50,runningTotal:8,groups:[{key:'a',total:51,running:8}]};
  const ui=mountList(t,[group],{loaded:true,complete:false,loading:true,counts});
  assert.equal(ui.byClass('session-row').length,5);
  assert.equal(ui.byClass('session-group-count')[0].text,'51');
  assert.ok(ui.byClass('session-running-count').every(node=>nodeText(node)==='8 个运行中'));
  assert.equal(ui.byClass('session-group-add')[0].props.disabled,true);
  assert.equal(ui.byClass('session-show-more')[0].props.disabled,true);
  ui.byClass('session-row')[0].props.onClick();await nextTick();assert.equal(ui.opened.length,1);
  ui.setProps({searchQuery:'last hidden preview'});await nextTick();
  assert.equal(ui.byClass('session-row').length,0);
  assert.equal(ui.byClass('session-search-count').length,0);assert.equal(ui.byClass('state-empty').length,0);
  assert.equal(ui.byClass('state-loading').length,1);
  ui.setProps({loading:false,loadError:'尚未完整加载，请重试。'});await nextTick();
  assert.equal(ui.byClass('session-list-error').length,1);assert.equal(ui.byClass('state-empty').length,0);
  const last={...fixtures(1)[0],id:'last',resumeSessionId:'last',inputPreview:'last hidden preview'};
  ui.setProps({complete:true,counts:null,loading:false,loadError:''});ui.update([{...group,sessions:[...sessions,last]}]);await nextTick();
  assert.equal(ui.byClass('session-row').length,1);assert.equal(ui.byClass('session-search-count')[0].text,'1 个匹配会话');
  assert.equal(ui.byClass('session-group-add')[0].props.disabled,false);
});

test('partial activity mode keeps its actual running total and disables further pagination',async(t)=>{
  const ui=mountList(t,[{id:'a',name:'Project',sessions:fixtures(25)}],{loaded:true,complete:false,loading:true,
    counts:{sessionsTotal:45,activitiesTotal:45,runningTotal:12,groups:[{key:'a',total:45,running:12}]}});
  const activity=ui.find(node=>node.type==='button'&&node.text==='最近活动')[0];activity.props.onClick();await nextTick();
  assert.equal(ui.byClass('session-row').length,20);assert.equal(ui.byClass('session-show-more')[0].props.disabled,true);
  assert.equal(nodeText(ui.byClass('session-running-count')[0]),'12 个运行中');
});

test('initial loading and failed reads never pretend to be an empty catalog, and refresh errors retain rows',async(t)=>{
  const ui=mountList(t,[],{loaded:false,loading:true});
  assert.equal(ui.byClass('state-loading').length,1);
  assert.equal(ui.byClass('state-loading')[0].props.role,'status');
  assert.equal(ui.byClass('state-loading')[0].props['aria-busy'],true);
  assert.match(nodeText(ui.byClass('state-loading')[0]),/正在加载会话/);
  assert.equal(ui.byClass('state-empty').length,0);
  ui.setProps({loading:false,loadError:'读取失败'});await nextTick();
  assert.equal(ui.byClass('session-list-error').length,1);
  assert.equal(ui.byClass('state-empty').length,0);
  ui.find(node=>node.props?.['aria-label']==='重新加载会话')[0].props.onClick();assert.equal(ui.retries.length,1);
  ui.setProps({loading:true});await nextTick();
  assert.equal(ui.find(node=>node.props?.['aria-label']==='重新加载会话')[0].props.disabled,true);
  ui.setProps({loading:false,loaded:true,loadError:''});await nextTick();
  assert.equal(ui.byClass('state-empty').length,1);
  assert.match(nodeText(ui.byClass('state-empty')[0]),/还没有可展示的会话/);
  ui.update([{id:'a',name:'Project',sessions:fixtures(8)}]);await nextTick();
  ui.setProps({loadError:'刷新失败'});await nextTick();
  assert.equal(ui.byClass('session-row').length,5);
});

test('a degraded empty snapshot shows recovery feedback without asserting empty results',async(t)=>{
  const ui=mountList(t,[],{loaded:true,loadError:'数据暂时无法更新'});
  assert.equal(ui.byClass('session-list-error').length,1);
  assert.equal(ui.byClass('state-empty').length,0);
  ui.update([{id:'project',name:'Project',sessions:[]}]);await nextTick();
  assert.equal(ui.byClass('session-row-placeholder').length,0);
  ui.setProps({loadError:''});await nextTick();
  assert.equal(ui.byClass('session-row-placeholder').length,1);
});
