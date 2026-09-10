import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {title:'Aira by AskDeepakAI — What are we building today?',description:'An interactive Aira voice interface by AskDeepakAI.',appleWebApp:{capable:true,statusBarStyle:'black-translucent',title:'Aira by AskDeepakAI'}};
export const viewport: Viewport = {width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#ed7000'};
export default function RootLayout({children}:{children:React.ReactNode}) {return <html lang="en" className="dark"><body>{children}</body></html>}
