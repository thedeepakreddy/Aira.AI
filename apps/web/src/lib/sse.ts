/**
 * Parses a Server-Sent Events byte stream into `data:` payloads.
 *
 * A chunk boundary can land anywhere, including mid-event, so bytes are held
 * until a complete `\n\n`-delimited frame is present. Splitting on chunk
 * arrival instead would corrupt any event that spans two reads.
 *
 * Used for both the Aira gateway and the OpenCode agent server; neither can use
 * EventSource, because both need an Authorization header.
 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
