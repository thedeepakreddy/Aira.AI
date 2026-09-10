'use client';
import {useEffect,useRef,useState} from 'react';
import {Terminal,ArrowUpRight,Power,Wifi,Send,Folder,ChevronRight} from 'lucide-react';
import {COMMANDS,runDemoCommand} from '@/lib/workspace-state';
type Entry={command:string;output:string};
export default function RemoteTerminal(){
 const [connected,setConnected]=useState(false);
 const [command,setCommand]=useState('');
 const [entries,setEntries]=useState<Entry[]>([]);
 const [history,setHistory]=useState<string[]>([]);
 const [cursor,setCursor]=useState(-1);
 const [announcement,setAnnouncement]=useState('');
 const log=useRef<HTMLDivElement>(null);
 const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'instant'})},[entries,connected]);
 function connect(){setConnected(true);setAnnouncement('Demo session started. No remote server is connected.');setTimeout(()=>input.current?.focus(),0)}
 function disconnect(){setConnected(false);setAnnouncement('Demo session ended.')}
 function execute(value=command){
  if(!connected||!value.trim())return;
  const clean=value.trim();const next=[...history,clean].slice(-100);
  setHistory(next);setCommand('');setCursor(-1);
  if(clean==='clear'){setEntries([]);setAnnouncement('Terminal cleared.');return}
  const output=runDemoCommand(clean,next);
  setEntries(rows=>[...rows,{command:clean,output}].slice(-150));
  setAnnouncement(output);
 }
 return <section className="cli-page screen-content" aria-label="Remote CLI">
  <div className="cli-heading"><div><span className="eyebrow">YOUR WORKSPACE, ANYWHERE</span><h1><span className="mobile-only">Remote </span>CLI<span className="desktop-only"> workspace.</span></h1><p>A direct line to your next idea.</p></div><span className="session-badge"><span/>{connected?'Demo session active':'Not connected'}</span></div>
  <div className="cli-grid"><aside className="connection-card"><div className="connection-icon"><Wifi/></div><span className="eyebrow">REMOTE SESSION</span><h2>Take your workspace<br/>with you.</h2><p>Run through the terminal experience from your laptop or phone.</p><dl><div><dt>Environment</dt><dd>Preview sandbox</dd></div><div><dt>Remote server</dt><dd>Not connected</dd></div></dl><button className="warm-button" onClick={connected?disconnect:connect}><Power/>{connected?'End demo session':'Start demo session'}<ArrowUpRight/></button><small>Simulated commands. A backend is required for real remote access.</small></aside>
  <div className="terminal-window"><div className="terminal-title"><Terminal/><span>aira — remote CLI</span><span className="terminal-mode">DEMO</span></div><div className="terminal-path"><Folder/> /workspace/aira</div>
  <div className="terminal-log" ref={log} role="region" aria-label="Terminal output" tabIndex={0}><div className="terminal-welcome"><span>Aira CLI</span><p>{connected?'Session ready. Type help to explore.':'Start a demo session to open your terminal.'}</p></div>{entries.map((entry,index)=><div className="terminal-entry" key={index}><div className="terminal-command"><span>❯</span> {entry.command}</div><pre>{entry.output}</pre></div>)}</div>
  <form className="terminal-input-row" onSubmit={e=>{e.preventDefault();execute()}}><ChevronRight/><input ref={input} aria-label="CLI command" value={command} disabled={!connected} placeholder={connected?'Type a command…':'Start a session first'} autoComplete="off" autoCapitalize="off" spellCheck={false} onChange={e=>setCommand(e.target.value)} onKeyDown={e=>{
   if(e.key==='ArrowUp'){e.preventDefault();const next=cursor<0?history.length-1:Math.max(0,cursor-1);setCursor(next);setCommand(history[next]||'')}
   if(e.key==='ArrowDown'){e.preventDefault();const next=cursor<0?-1:cursor+1;if(next>=history.length){setCursor(-1);setCommand('')}else{setCursor(next);setCommand(history[next]||'')}}
   if(e.key==='Tab'){const matches=COMMANDS.filter(c=>c.startsWith(command));if(command&&matches.length===1){e.preventDefault();setCommand(matches[0]+' ')}}
  }}/><button type="submit" disabled={!connected||!command.trim()} aria-label="Run demo command"><Send/></button></form>
  <div className="terminal-shortcuts">{['help','ls','status','clear'].map(c=><button key={c} disabled={!connected} onClick={()=>execute(c)}>{c}</button>)}<span>↑ ↓ history</span></div></div></div><p role="status" className="sr-only">{announcement}</p>
 </section>
}

