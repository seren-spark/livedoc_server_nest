import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
const base='http://127.0.0.1:8001';
async function json(path,options){const r=await fetch(base+path,options);if(!r.ok)throw new Error(`${path}: ${r.status} ${await r.text()}`);return r.json();}
const login=await json('/dev/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'alice@livedoc.local',password:'Demo@123456'})});
const headers={'Content-Type':'application/json',Authorization:`Bearer ${login.token}`};
try{
 const caps=await json('/ai/agent/capabilities',{headers});assert(caps.thinking_supported&&caps.web_available);assert(caps.web_tools.includes('search_web'));console.log('CAPABILITIES',JSON.stringify(caps));
 const node={type:'paragraph',content:[{type:'text',text:'用于验证开关的未保存文档。'}]};
 const snapshot={identity:{kind:'unsaved',local_id:'feature-smoke'},title:'功能验证',json:{type:'doc',content:[node]},revision:0,hash:'feature-smoke',selection:{text:'',inline:true,region_ids:['b0']},regions:[{id:'b0',type:'paragraph',text:'用于验证开关的未保存文档。',markdown:'用于验证开关的未保存文档。',heading_path:[],original_json:node}]};
 for(const test of [{label:'thinking',thinking:true,web:false,query:'查询并计算 (17×23)-(19×7)，给出数值答案，不要修改文档。'},{label:'web-and-thinking',thinking:true,web:true,query:'查询北京今天的天气，必须联网检索，注明预报日期和来源。只回答问题，不要修改文档。'},{label:'web-off',thinking:false,web:false,query:'查询深圳今天的天气，目前未开启联网时请说明无法查询实时天气，不要修改文档。'}]){
 const r=await fetch(base+'/ai/agent',{method:'POST',headers,signal:AbortSignal.timeout(300000),body:JSON.stringify({request_id:randomUUID(),conversation_id:randomUUID(),mode:'ask',output_target:'current_document',query:test.query,deep_thinking:test.thinking,allow_web:test.web,editor_snapshot:snapshot,references:[]})});
 if(!r.ok)throw new Error(`Agent: ${r.status} ${await r.text()}`);
 const transcript=await r.text();const frames=transcript.split('\n\n').filter(f=>f.startsWith('event:')).map(f=>({event:f.split('\n')[0].slice(7),data:JSON.parse(f.split('\ndata: ')[1])}));
 const result=frames.find(f=>f.event==='result')?.data.result;const tools=frames.filter(f=>f.event==='tool_start').map(f=>f.data.name);assert(result,JSON.stringify(frames.find(f=>f.event==='error')?.data));assert.equal(result.kind,'answer');assert(!transcript.includes('reasoning_content'));
 if(test.label==='thinking')assert(result.answer.includes('258'));
 if(test.web){assert(tools.includes('search_web'));const citations=frames.flatMap(f=>f.data.citations??[]).filter(c=>c.kind==='web');assert(citations.length>0);assert(result.citation_ids.length>0);}else assert(!tools.some(t=>t==='search_web'||t.startsWith('mcp__')||t.startsWith('personal_tavily')));
 const runId=frames[0].data.run_id;const audit=await json('/ai/tool-audits?run_id='+runId,{headers});console.log('FEATURE_OK',JSON.stringify({label:test.label,tools,result,reflection:frames.filter(f=>f.event==='reflection').map(f=>f.data),auditCount:Array.isArray(audit)?audit.length:undefined}));
 }
}finally{await fetch(base+'/dev/auth/logout',{method:'POST',headers});}
