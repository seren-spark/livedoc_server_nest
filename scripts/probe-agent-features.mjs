import fs from 'node:fs';
import { parse } from 'dotenv';
const env = parse(fs.readFileSync('.env'));
const headers = { Authorization: `Bearer ${env.LLM_API_KEY}`, 'Content-Type': 'application/json' };
for (const kind of ['thinking', 'search']) {
  const body = kind === 'thinking' ? {
    model: env.LLM_MODEL, enable_thinking: true, stream: false, max_tokens: 1024,
    messages: [{ role: 'user', content: '请计算17×23，调用finish_answer提交答案。' }],
    tools: [{ type: 'function', function: { name: 'finish_answer', description: '提交答案', parameters: { type: 'object', properties: {answer:{type:'string'}}, required:['answer'], additionalProperties:false } } }], tool_choice: 'auto', parallel_tool_calls: false,
  } : {
    model: env.LLM_MODEL, enable_thinking: false, enable_search: true, stream: false, max_tokens: 1200,
    search_options: { forced_search: true, enable_source: true, enable_citation: false },
    messages: [{ role: 'user', content: '搜索 Tiptap 官方 Markdown 文档，只给出官方页面名称和网址。' }],
  };
  const response = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
  const data=await response.json();
  const message=data.choices?.[0]?.message;
  console.log(JSON.stringify({kind,status:response.status,error:response.ok?undefined:data.error,keys:Object.keys(data),choiceKeys:Object.keys(data.choices?.[0]??{}),messageKeys:Object.keys(message??{}),reasoningCharacters:message?.reasoning_content?.length||0,tools:message?.tool_calls?.map(c=>c.function.name),searchInfo:data.search_info??data.output?.search_info,annotations:message?.annotations,answer:kind==='search'?message?.content:undefined,usage:data.usage}));
}
