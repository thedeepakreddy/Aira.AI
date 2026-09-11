import {useCallback,useEffect,useRef,useState} from 'react';
import {Mic,MicOff,Loader2} from 'lucide-react';
import {streamChat,type ChatMessage} from '@/lib/gateway';
import {listen,speak,stopSpeaking,speechSupported,warmVoices,type Listener} from '@/lib/voice';
import {playOrb} from '@/lib/orb';

/**
 * A spoken conversation with Aira.
 *
 * Replaces the reference project's scripted demo, which played a canned
 * transcript word by word and then dropped the user into the chat screen. This
 * listens, answers, speaks, and listens again until the user closes it — it
 * never navigates away on its own.
 *
 * The loop deliberately never listens while Aira is speaking. A live
 * microphone during playback transcribes Aira's own voice and answers itself,
 * which is the usual way hands-free assistants fall into a loop.
 */

type Phase='idle'|'listening'|'thinking'|'speaking';

export default function VoiceScreen({reduceMotion}:{reduceMotion:boolean}){
 const [phase,setPhase]=useState<Phase>('idle');
 const [heard,setHeard]=useState('');
 const [reply,setReply]=useState('');
 const [error,setError]=useState('');
 const [muted,setMuted]=useState(false);

 const orb=useRef<HTMLVideoElement>(null);
 const listener=useRef<Listener|null>(null);
 const history=useRef<ChatMessage[]>([]);
 const request=useRef<AbortController|null>(null);
 const cancelSpeech=useRef<(()=>void)|null>(null);
 // Guards the loop against a reply arriving after the user has closed the screen.
 const live=useRef(true);

 const stopListening=useCallback(()=>{listener.current?.stop();listener.current=null},[]);

 const startListening=useCallback(()=>{
  if(!live.current||muted)return;
  stopListening();
  setPhase('listening');
  const l=listen({
   onPartial:text=>{if(live.current)setHeard(text)},
   onFinal:text=>{if(live.current)void respond(text)},
   onError:message=>{if(live.current){setError(message);setPhase('idle')}},
  });
  if(!l){setError('This system has no speech recognition available.');setPhase('idle');return}
  listener.current=l;
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[muted,stopListening]);

 /** One turn: send what was heard, stream the answer, speak it, listen again. */
 const respond=useCallback(async(said:string)=>{
  // Stop listening first: anything captured while Aira talks is Aira.
  stopListening();
  setHeard(said);setReply('');setError('');setPhase('thinking');

  const turn:ChatMessage[]=[...history.current,{role:'user',content:said}];
  history.current=turn;

  const controller=new AbortController();request.current=controller;
  let answer='';
  try{
   for await(const event of streamChat({messages:turn,surface:'voice',signal:controller.signal})){
    if(!live.current)return;
    if(event.type==='text'){answer+=event.text;setReply(answer)}
    else if(event.type==='error'){setError(event.message)}
   }
  }catch{
   if(live.current)setError('Aira could not answer just then.');
  }
  if(!live.current)return;

  const spoken=answer.trim();
  if(!spoken){setPhase('listening');startListening();return}

  history.current=[...turn,{role:'assistant',content:spoken}];
  setPhase('speaking');
  cancelSpeech.current=speak(spoken,()=>{
   if(!live.current)return;
   startListening();
  });
 },[startListening,stopListening]);

 // Start the conversation on mount, and tear everything down on close.
 useEffect(()=>{
  live.current=true;
  warmVoices();
  if(!speechSupported.listening){
   setError('This system has no speech recognition available.');
   setPhase('idle');
  }else{
   startListening();
  }
  return()=>{
   live.current=false;
   listener.current?.stop();listener.current=null;
   request.current?.abort();
   cancelSpeech.current?.();
   stopSpeaking();
  };
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);

 useEffect(()=>playOrb(orb.current,reduceMotion),[reduceMotion,phase]);

 function toggleMute(){
  const next=!muted;
  setMuted(next);
  if(next){
   stopListening();
   cancelSpeech.current?.();stopSpeaking();
   request.current?.abort();
   setPhase('idle');
  }else{
   startListening();
  }
 }

 const status=error?error
  :muted?'Paused — tap the microphone to resume'
  :phase==='listening'?'Aira is listening…'
  :phase==='thinking'?'Aira is thinking…'
  :phase==='speaking'?'Aira is speaking…'
  :'Starting…';

 // While Aira answers, her words replace the user's on screen — the transcript
 // area always shows whoever currently holds the conversation.
 const shown=phase==='speaking'||phase==='thinking'?reply:heard;

 return <section className="voice-screen screen-content" key="voice" aria-label="Voice conversation">
  <div className={'orb-wrap '+(phase==='speaking'?'is-speaking':muted?'is-paused':'')}>
   {reduceMotion
    ? <img className="orb-still" src="/assets/orb.jpg" alt="Aira"/>
    : <video ref={orb} className="orb-video" src="/assets/orb.mp4" poster="/assets/orb.jpg" loop muted playsInline preload="auto" aria-hidden="true"/>}
  </div>

  <p className={'listening-status '+(error?'is-error':'')} aria-live="polite">{status}</p>

  <p className={'transcript live '+(phase==='speaking'||phase==='thinking'?'from-aira':'')} aria-live="polite">
   {shown||(phase==='listening'&&!muted?'Say something…':'')}
  </p>

  <div className="voice-actions">
   <span className="voice-secondary voice-phase" aria-hidden="true">
    {phase==='thinking'?<Loader2 className="spin"/>:null}
   </span>
   <div className="mic-orbit">
    <button className="mic-button voice-mic" onClick={toggleMute}
     aria-label={muted?'Resume the conversation':'Pause the conversation'} aria-pressed={!muted}>
     {muted?<MicOff/>:<Mic/>}
    </button>
   </div>
   <span className="voice-secondary" aria-hidden="true"/>
  </div>
 </section>;
}
