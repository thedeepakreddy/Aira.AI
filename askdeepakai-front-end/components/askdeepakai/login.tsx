'use client';
import {useState} from 'react';
import {ArrowUpRight,Eye,EyeOff,ArrowLeft} from 'lucide-react';
export default function Login({onComplete,onBack,reduceMotion}:{onComplete:()=>void;onBack:()=>void;reduceMotion:boolean}){
 const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [showPassword,setShowPassword]=useState(false);
 return <section className="login-page screen-content"><div className="login-story"><div className="login-orb"><img src="/assets/orb.jpg" alt="Glowing orb"/></div><span className="eyebrow">AIRA BY ASKDEEPAKAI</span><h1>Big ideas.<br/>A little spark.</h1><p>Your conversations, your tools.<br/>One place to bring it all together.</p></div>
 <div className="login-card"><button className="back-link" onClick={onBack}><ArrowLeft/>Back to workspace</button><span className="eyebrow">LET’S PICK UP WHERE YOU LEFT OFF</span><h2>Welcome back.</h2><p>Step into your Aira workspace.</p>
 <form onSubmit={event=>{event.preventDefault();setPassword('');onComplete()}}><label htmlFor="login-email">Email address</label><input id="login-email" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" autoComplete="off"/><label htmlFor="login-password">Demo password</label><div className="password-field"><input id="login-password" type={showPassword?'text':'password'} required minLength={6} value={password} onChange={e=>setPassword(e.target.value)} placeholder="Any 6+ characters" autoComplete="off"/><button type="button" onClick={()=>setShowPassword(!showPassword)} aria-label={showPassword?'Hide password':'Show password'}>{showPassword?<EyeOff/>:<Eye/>}</button></div><button type="submit" className="warm-button">Enter demo workspace<ArrowUpRight/></button></form>
 <p className="login-note">Preview sign-in only. Use made-up credentials; they are never sent or stored. Real account authentication is not connected.</p></div></section>
}

