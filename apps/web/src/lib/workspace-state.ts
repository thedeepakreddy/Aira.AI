export type Message = {role:'user'|'assistant';text:string};
export type Conversation = {id:string;title:string;updatedAt:number;messages:Message[]};
export const HISTORY_KEY='askdeepakai.chat-history.v1';
export function parseHistory(raw:string|null):Conversation[]{
 try{
  const parsed:unknown=JSON.parse(raw||'[]');if(!Array.isArray(parsed))return[];
  return parsed.filter((item):item is Conversation=>{
   if(!item||typeof item!=='object')return false;
   return typeof item.id==='string'&&typeof item.title==='string'&&typeof item.updatedAt==='number'&&Array.isArray(item.messages)&&item.messages.every((m:Message)=>m&&['user','assistant'].includes(m.role)&&typeof m.text==='string');
  }).slice(0,30).map(c=>({...c,title:c.title.slice(0,80),messages:c.messages.slice(-100).map(m=>({...m,text:m.text.slice(0,12000)}))}));
 }catch{return[]}
}
export function saveConversation(history:Conversation[],id:string,messages:Message[],now:number):Conversation[]{
 if(!messages.length)return history;
 const title=(messages.find(m=>m.role==='user')?.text||'New conversation').slice(0,60);
 return [{id,title,updatedAt:now,messages:messages.slice(-100)},...history.filter(c=>c.id!==id)].slice(0,30);
}
