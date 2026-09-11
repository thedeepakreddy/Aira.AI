import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders assistant text as Markdown.
 *
 * Models answer in Markdown by default — headings, lists, tables and fenced
 * code — and rendering that as plain text shows the reader raw `**` and ``` `` ``
 * instead of the formatting they encode. For a product whose main surface is a
 * coding agent, code fences in particular have to render.
 *
 * Raw HTML is deliberately not enabled: model output is untrusted input, and
 * react-markdown ignores embedded HTML unless a plugin opts in. Links open in a
 * new tab with `noreferrer`, so a model cannot navigate the app away.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: text, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener">
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
