import {useState} from 'react';
import {ArrowUpRight,Eye,EyeOff,ArrowLeft,Loader2} from 'lucide-react';
import {signIn,signUp,isAuthConfigured} from '@/lib/supabase';

type Mode='signin'|'signup';
type Message={tone:'error'|'info';text:string};

export default function Login({onComplete,onBack,reduceMotion}:{onComplete:()=>void;onBack:()=>void;reduceMotion:boolean}){
 const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [showPassword,setShowPassword]=useState(false);
 const [mode,setMode]=useState<Mode>('signin');const [pending,setPending]=useState(false);const [message,setMessage]=useState<Message|null>(null);
 const signup=mode==='signup';

 async function submit(event:React.FormEvent){
  event.preventDefault();
  if(pending)return;
  setPending(true);setMessage(null);
  const error=signup?await signUp(email,password):await signIn(email,password);
  setPending(false);
  // A new account has no session until the emailed link is clicked; saying so
  // beats a form that appears to do nothing.
  if(error==='CONFIRM_EMAIL'){setPassword('');setMode('signin');setMessage({tone:'info',text:'Check your inbox to confirm your address, then sign in.'});return}
  if(error){setMessage({tone:'error',text:error});return}
  setPassword('');
  onComplete();
 }
 function switchMode(){setMode(signup?'signin':'signup');setMessage(null)}

 return <section className="login-page screen-content"><div className="login-story"><div className="login-orb">{reduceMotion?<img src="/assets/orb.jpg" alt="Glowing orb"/>:<video src="/assets/orb.mp4" poster="/assets/orb.jpg" autoPlay loop muted playsInline aria-hidden="true"/>}</div><span className="eyebrow">AIRA BY ASKDEEPAKAI</span><h1>Big ideas.<br/>A little spark.</h1><p>Your conversations, your tools.<br/>One place to bring it all together.</p></div>
 <div className="login-card"><button className="back-link" onClick={onBack}><ArrowLeft/>Back to workspace</button><span className="eyebrow">{signup?'A FEW SECONDS AND YOU’RE IN':'LET’S PICK UP WHERE YOU LEFT OFF'}</span><h2>{signup?'Create your account.':'Welcome back.'}</h2><p>{signup?'Start your Aira workspace.':'Step into your Aira workspace.'}</p>
 <form onSubmit={submit}><label htmlFor="login-email">Email address</label><input id="login-email" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" disabled={pending}/><label htmlFor="login-password">Password</label><div className="password-field"><input id="login-password" type={showPassword?'text':'password'} required minLength={6} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 6 characters" autoComplete={signup?'new-password':'current-password'} disabled={pending}/><button type="button" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?'Hide password':'Show password'}>{showPassword?<EyeOff/>:<Eye/>}</button></div>
 {message&&<p className={'login-message '+message.tone} role={message.tone==='error'?'alert':'status'}>{message.text}</p>}
 <button type="submit" className="warm-button" disabled={pending||!isAuthConfigured}>{pending?<><Loader2 className="spin"/>{signup?'Creating account…':'Signing in…'}</>:<>{signup?'Create account':'Sign in'}<ArrowUpRight/></>}</button></form>
 <button type="button" className="login-toggle" onClick={switchMode}>{signup?<>Already have an account? <b>Sign in</b></>:<>New to Aira? <b>Create an account</b></>}</button>
 <p className="login-note">{isAuthConfigured?'Your password is sent directly to Supabase over HTTPS and is never stored by Aira.':'Sign-in is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'}</p></div></section>
}
