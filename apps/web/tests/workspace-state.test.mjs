import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHistory,saveConversation} from '../src/lib/workspace-state.ts';
const messages=[{role:'user',text:'Build my project'},{role:'assistant',text:'Ready.'}];
test('invalid stored history recovers without crashing',()=>{for(const raw of [null,'bad','{}','[null]','[{"id":"x","messages":[{}]}]'])assert.deepEqual(parseHistory(raw),[])});
test('saved conversations survive serialization',()=>{const saved=saveConversation([],'a',messages,100);assert.deepEqual(parseHistory(JSON.stringify(saved)),saved);assert.equal(saved[0].title,'Build my project')});
test('updating one conversation preserves other chats',()=>{const first=saveConversation([],'a',messages,1);const second=saveConversation(first,'b',[{role:'user',text:'Another'}],2);const result=saveConversation(second,'a',[...messages,{role:'user',text:'Continue'}],3);assert.equal(result.length,2);assert.equal(result[0].id,'a');assert.equal(result[1].id,'b');assert.equal(result[0].messages.length,3)});
test('empty drafts do not enter history; history is bounded',()=>{assert.deepEqual(saveConversation([],'a',[],1),[]);let result=[];for(let i=0;i<35;i++)result=saveConversation(result,String(i),messages,i);assert.equal(result.length,30);assert.equal(result[0].id,'34')});
test('history rejects invalid message roles',()=>{assert.deepEqual(parseHistory(JSON.stringify([{id:'a',title:'bad',updatedAt:1,messages:[{role:'system',text:'not a chat'}]}])),[])});

