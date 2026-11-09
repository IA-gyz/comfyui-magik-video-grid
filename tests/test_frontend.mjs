// Run: node Magik_Video_Grid/tests/test_frontend.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as selectionTools from '../js/axis_editor.mjs';
globalThis.selectionTools = selectionTools;
class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.value = ''; }
    append(...items) { for (const item of items) { this.children.push(item); if (typeof item === "object") item.parent = this; } }
    replaceChildren(...items) { this.children = items; }
    get lastChild() { return this.children.at(-1); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c=>c!==this); }
    pause() {}
    load() {}
    play() { return Promise.resolve(); }
    removeAttribute() {}
}
globalThis.document = { createElement: tag => new Element(tag) };
if (!globalThis.crypto) globalThis.crypto = webcrypto;
let serializations = 0, extension, onSubmit;
let liveChoices=['euler','dpmpp','custom_live'];
const definitions={Sampler:{input:{required:{cfg:['FLOAT',{min:0,max:20,step:0.5}],seed:['INT',{min:0,max:Number.MAX_SAFE_INTEGER}],sampler_name:[['euler','dpmpp']],enabled:['BOOLEAN'],text:['STRING',{multiline:true}]}}},Generator:{input:{required:{value:['INT',{min:1,max:100,step:1}]}}}};
const queued = [];
const base = { output: {
    '1': {class_type:'Sampler',inputs:{images:['2',0],seed:123,cfg:4,enabled:true,sampler_name:'euler',text:'first\nline'}},
    '2': {class_type:'Generator',inputs:{value:10}},
    '10': {class_type:'MagikVideoGrid',inputs:{images:['1',0],fps:24,crf:20,grid_state:'{}'}},
    '99': {class_type:'UnrelatedSave',inputs:{filename:'other'}}
}, workflow:{nodes:[]} };
globalThis.app = {graph:{getNodeById:id=>String(id)==='1'?{title:'My sampler',widgets:[{name:'sampler_name',options:{values:()=>liveChoices}}]}:null},registerExtension:e=>{extension=e;}, graphToPrompt:async()=>{serializations++;return structuredClone(base);} };
globalThis.api = {getNodeDefs:async()=>definitions,apiURL:p=>p,queuePrompt:async(n,data)=>{queued.push(structuredClone(data));onSubmit?.();return {prompt_id:String(queued.length)};} };
let source = await fs.readFile(new URL('../js/video_grid.js',import.meta.url),'utf8');
source = source.replace(/^import .*;\n/gm,'');
source = 'const {app,api}=globalThis; const {createAxisEditor,describeSetting,scalarTargetValue,settingValues}=globalThis.selectionTools;\n'+source;
const {valuesFor,upstreamIds,normalizePreview} = await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
assert.deepEqual(valuesFor('1\n2.5',0),[1,2.5]);
assert.deepEqual(valuesFor('true\nFALSE',true),[true,false]);
assert.throws(()=>valuesFor('yes',true));
assert.throws(()=>valuesFor('Infinity',1));
assert.throws(()=>valuesFor('',1));
assert.deepEqual([...upstreamIds(base.output,'10')].sort(),['1','10','2']);
class Node {
 constructor() {this.id=10;this.widgets=[{name:'grid_state'}];this.properties={};this.changes=0;this.graph={change:()=>this.changes++};}
 addDOMWidget(name,type,root){this.root=root;return {};}
 setSize(){}
}
await extension.beforeRegisterNodeDef(Node,{name:'MagikVideoGrid'});
const node=new Node();node.onNodeCreated();
assert.equal(serializations,0,'Creation must not serialize a partly restored graph');
const [controls,row,status,,grid]=node.root.children;
const [refresh,run,stop]=row.children;
node.properties.magikVideoGrid={x:'["1","cfg"]',y:'["2","value"]',xv:'2\n4',yv:'10\n20',lockSeed:true};
node.onConfigure();
assert.equal(controls.children[0].children[6].value,'2\n4');
await refresh.onclick();
assert(!controls.children[0].children[1].children.some(e=>e.textContent?.includes('Unrelated')));
assert.equal(controls.children[0].children[2].value,'["1","cfg"]');
await run.onclick();
assert.equal(queued.length,4);
assert.deepEqual(queued.map(p=>[p.output['1'].inputs.cfg,p.output['2'].inputs.value]),[[2,10],[4,10],[2,20],[4,20]]);
assert(queued.every(p=>p.output['1'].inputs.seed===123));
assert.equal(base.output['1'].inputs.cfg,4,'Original prompt must not be mutated');
const old=JSON.parse(queued[0].output['10'].inputs.grid_state);
const cell=s=>({...s,filename:'cell.mp4',subfolder:`magik_video_grid/${s.session}`,type:'output',fps:24});
node.onExecuted({magik_video_cell:[cell(old)]});
assert.equal(grid.children.length,4);
// Start a newer plot, then deliver a late result from the old plot.
await run.onclick();
node.onExecuted({magik_video_cell:[cell(old)]});
assert.equal(grid.children.length,0,'Late cells must not replace a newer session');
const fresh=JSON.parse(queued[4].output['10'].inputs.grid_state);
node.onExecuted({magik_video_cell:[cell(fresh)]});
assert.equal(grid.children.length,4);
const before=queued.length;onSubmit=()=>stop.onclick();
await run.onclick();
assert.equal(queued.length,before+1,'Stop must prevent the next cell submission');
assert.equal(run.disabled,false);assert.equal(refresh.disabled,false);
onSubmit=null;
const latest=JSON.parse(queued.at(-1).output['10'].inputs.grid_state);
node.onExecuted({magik_video_cell:[cell(latest)],magik_video_export:[{
    ...latest,filename:'grid.mp4',subfolder:`magik_video_grid/${latest.session}`,type:'output',width:280,height:344,duration:1
}]});
assert.equal(node.root.children[5].children.length,4,'Combined preview and download link must be displayed');
assert.match(status.textContent,/Combined MP4 is ready/);
base.output['10'].inputs.export_grid=true;
node.properties.magikVideoGrid.xv=Array.from({length:17},(_,i)=>String(i)).join('\n');
node.properties.magikVideoGrid.y='';
const count=queued.length;
const originalError=console.error;console.error=()=>{};
await run.onclick();
console.error=originalError;
assert.equal(queued.length,count,'Oversized combined exports must be rejected before queueing');
assert.match(status.textContent,/up to 16 cells/);
console.log('PASS: target filtering, restored settings, 2×2 prompt injection, seed locking, immutable snapshot, stale-session isolation stop submissions, combined preview and export limits');

// Preview references round-trip through workflow JSON without video data or prompt payloads.
const stored=JSON.parse(JSON.stringify(node.properties));
assert.equal(stored.magikVideoGridPreview.cells.length,1);
assert(!('xLabels' in stored.magikVideoGridPreview.cells[0]),'Shared labels must not be duplicated per cell');
const restored=new Node();restored.onNodeCreated();restored.properties=stored;
const beforeRestore=serializations, queuedBeforeRestore=queued.length;
restored.onConfigure();
assert.equal(restored.root.children[4].children.length,4,'Restore pending cells as well as ready cells');
assert.equal(restored.root.children[5].children.length,4,'Restore combined player');
assert.equal(restored.changes,0,'Restoring must not dirty the workflow');
assert.equal(serializations,beforeRestore,'Restoring must not serialize the graph');
assert.equal(queued.length,queuedBeforeRestore,'Restoring must not queue generation');
const restoredVideo=restored.root.children[4].children[0].children[1];
restoredVideo.onerror();
assert.match(restored.root.children[4].children[0].lastChild.textContent,/unavailable/);
restored.root.children[5].children[1].onerror();
assert.match(restored.root.children[5].lastChild.textContent,/unavailable/);
const loopInput=restored.root.children[3].lastChild.children[0];
loopInput.checked=false;loopInput.onchange();
assert.equal(restored.properties.magikVideoGrid.loop,false);
assert.equal(restoredVideo.loop,false);
// Ignore extra payload fields and reject invalid paths or duplicate coordinates.
const extra=structuredClone(stored.magikVideoGridPreview);extra.cells[0].prompt='not part of preview';
assert(!('prompt' in normalizePreview(extra).cells[0]));
const unsafe=structuredClone(extra);unsafe.cells[0].filename='../outside.mp4';
assert.equal(normalizePreview(unsafe),null);
const duplicated=structuredClone(extra);duplicated.cells.push({...duplicated.cells[0]});
assert.equal(normalizePreview(duplicated),null);
// Clear preview drops references and prevents queued late results from repopulating it.
restored.root.children[1].children[4].onclick();
assert.equal(restored.properties.magikVideoGridPreview,undefined);
assert.equal(restored.root.children[4].children.length,0);
restored.onExecuted({magik_video_cell:[cell(latest)]});
assert.equal(restored.root.children[4].children.length,0);
assert.equal(queued.length,queuedBeforeRestore);
console.log('PASS: preview JSON round-trip, compact storage, clean restoration, missing-video errors, loop persistence, invalid snapshot rejection and clear-preview isolation');

const {describeSetting,scalarTargetValue,numericRange,suggestedNumbers,settingValues}=selectionTools;
const integer=describeSetting('steps',20,{input:{required:{steps:['INT',{min:1,max:100,step:1}]}}});
assert.deepEqual(numericRange(1,3,1,integer),[1,2,3]);
assert.deepEqual(numericRange(3,1,-1,integer),[3,2,1]);
assert.throws(()=>numericRange(1,3,-1,integer));
assert.throws(()=>numericRange(1,100,1,integer));
assert.throws(()=>numericRange(1,2,0.5,integer));
assert.throws(()=>numericRange('',2,1,integer));
assert.deepEqual(numericRange(0.1,0.3,0.1),[0.1,0.2,0.3]);
const seedMeta=describeSetting('seed',Number.MAX_SAFE_INTEGER,definitions.Sampler);
assert.deepEqual(suggestedNumbers('seed',seedMeta),[Number.MAX_SAFE_INTEGER]);
assert.deepEqual(numericRange(Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER,1,seedMeta),[Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER]);
assert.deepEqual(settingValues('["multi\\nline", ""]',{value:'',meta:{kind:'text'}},'json'),['multi\nline','']);
assert.throws(()=>settingValues('1.5',{value:1,meta:integer}));
assert.throws(()=>settingValues('old_sampler',{value:'euler',meta:{kind:'choices',choices:['euler']}}));
const editorNode=new Node();editorNode.onNodeCreated();
const [editorControls,editorRow]=editorNode.root.children;
await editorRow.children[0].onclick();
const xEditor=editorControls.children[0];
const [heading,nodeSelect,settingSelect,info,panel,format,text,summary]=xEditor.children;
assert.equal(nodeSelect.children.length,3,'Node dropdown contains each upstream node only once');
nodeSelect.value='1';nodeSelect.onchange();
assert(settingSelect.children.some(o=>o.value==='["1","cfg"]'));
assert(!settingSelect.children.some(o=>o.value==='["2","value"]'),'Settings are restricted to the chosen node');
settingSelect.value='["1","cfg"]';settingSelect.onchange();
assert.match(info.textContent,/Node definition/);
const fields=panel.children[2];
fields.children[0].children[0].value='1';fields.children[1].children[0].value='2';fields.children[2].children[0].value='0.5';
panel.children[3].onclick();
assert.equal(text.value,'1\n1.5\n2');
settingSelect.value='["1","enabled"]';settingSelect.onchange();
assert.equal(text.value,'false\ntrue');
assert.equal(panel.children[3].children.length,2,'Boolean checklist has two options');
settingSelect.value='["1","sampler_name"]';settingSelect.onchange();
assert.equal(panel.children[3].children.length,3,'Combo choices include the live widget list');
panel.children[1].value='custom';panel.children[1].oninput();
panel.children[2].children[0].onclick();
assert.equal(text.value,'custom_live');
liveChoices=['euler','dpmpp'];
await editorRow.children[0].onclick();
assert.match(summary.textContent,/no longer available/,'Changed live choices invalidate stale selections');
settingSelect.value='["1","text"]';settingSelect.onchange();
assert.equal(format.value,'json');
assert.deepEqual(JSON.parse(text.value),['first\nline']);
format.value='lines';format.onchange();
assert.equal(format.value,'json','Multiline values must not silently split into separate cells');
console.log('PASS: node-grouped selectors, live combo fetching, booleans, numeric ranges/limits, safe large seeds, multiline values and stale-choice validation');

const linkedDefinition={input:{required:{width:['INT',{default:512,min:64,max:2048,step:64}],images:['IMAGE']}}};
assert.equal(scalarTargetValue('width',['2',0],linkedDefinition),512);
assert.equal(scalarTargetValue('images',['2',0],linkedDefinition),undefined);
assert.equal(scalarTargetValue('width',['2',0],linkedDefinition,{value:768}),768);
// A converted numeric input stays selectable on the receiving node and overrides its wire.
base.output['1'].inputs.linked_width=['2',0];definitions.Sampler.input.required.linked_width=['INT',{default:512,min:64,max:2048,step:64}];
await editorRow.children[0].onclick();
nodeSelect.value='1';nodeSelect.onchange();
assert(settingSelect.children.some(o=>o.value==='["1","linked_width"]'));
settingSelect.value='["1","linked_width"]';settingSelect.onchange();
assert.match(info.textContent,/override its wire/);
text.value='512\n768';text.oninput();
const preLinked=queued.length;await editorRow.children[1].onclick();
assert.equal(queued.length,preLinked+2);
assert.deepEqual(queued.slice(preLinked).map(p=>p.output['1'].inputs.linked_width),[512,768]);
console.log('PASS: connected scalar settings use widget/schema reference values and replace links in queued prompts');
