export interface TextAttachment { name: string; content: string }
export const MAX_ATTACHMENT_BYTES = 48 * 1024;
export const TEXT_FILE_ACCEPT = '.txt,.md,.mdx,.json,.csv,.ts,.tsx,.js,.jsx,.py,.rs,.html,.css,.yaml,.yml,.toml,.xml,.sql,.sh,.log';

export async function readTextAttachment(file: File): Promise<TextAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('Choose a text or code file smaller than 48 KB.');
  const extension = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!TEXT_FILE_ACCEPT.split(',').includes(extension)) throw new Error('Attachments currently support text and code files. Images and PDFs need a document connector.');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('This file is not UTF-8 text. Export it as a text file and try again.'); }
  if (content.includes('\0')) throw new Error('This file contains binary data. Choose a text or code file.');
  return { name: file.name, content };
}

export function messageContent(message: { text: string; attachment?: TextAttachment }): string {
  if (!message.attachment) return message.text;
  return `${message.text}\n\nAttached file (${JSON.stringify(message.attachment.name)}):\n${message.attachment.content}`;
}
