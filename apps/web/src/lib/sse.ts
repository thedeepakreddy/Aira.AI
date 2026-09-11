/** Parse SSE data fields across byte boundaries, including CRLF and UTF-8. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fields: string[] = [];
  let reachedEnd = false;

  function line(value: string): string | undefined {
    if (value === '') {
      if (!fields.length) return;
      const data = fields.join('\n');
      fields = [];
      return data;
    }
    if (value === 'data') fields.push('');
    else if (value.startsWith('data:')) {
      const data = value.slice(5);
      fields.push(data.startsWith(' ') ? data.slice(1) : data);
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let offset = 0;
      for (let index = 0; index < buffer.length; index++) {
        const char = buffer[index];
        if (char !== '\n' && char !== '\r') continue;
        if (char === '\r' && index + 1 === buffer.length && !done) break;
        const data = line(buffer.slice(offset, index));
        if (char === '\r' && buffer[index + 1] === '\n') index++;
        offset = index + 1;
        if (data !== undefined) yield data;
      }
      buffer = buffer.slice(offset);
      if (done) { reachedEnd = true; break; }
    }
  } finally {
    if (!reachedEnd) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
