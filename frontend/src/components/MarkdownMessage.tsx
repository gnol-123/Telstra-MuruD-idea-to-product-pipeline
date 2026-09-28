"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";
import type { Components } from "react-markdown";

const components: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-[1.6]">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-white/90">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1.5">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[13.5px] font-semibold mt-3 mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-[13px] font-semibold mt-2 mb-1">{children}</h3>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-[1.6]">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-accent/50 pl-3 my-2 text-white/55 italic">{children}</blockquote>
  ),
  hr: () => <hr className="border-white/10 my-3" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent hover:text-[#8FB1FF] underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="text-[12px] border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-white/15 bg-white/[0.05] px-2.5 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-white/10 px-2.5 py-1">{children}</td>,
  // inline code
  code: ({ children, className }) => {
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    const raw = String(children).replace(/\n$/, "");
    // block code: className is set by remark
    if (lang) {
      let highlighted = raw;
      try {
        highlighted = hljs.highlight(raw, { language: lang }).value;
      } catch {
        try {
          highlighted = hljs.highlightAuto(raw).value;
        } catch {}
      }
      return (
        <code
          className="hljs block text-[11.5px] leading-[1.6]"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      );
    }
    if (className) {
      // fenced block without a lang hint
      return (
        <code className="block text-[11.5px] leading-[1.6] text-[#F5EDE2]/80">{children}</code>
      );
    }
    // inline
    return (
      <code className="font-mono text-[11.5px] px-1.5 py-0.5 rounded bg-white/[0.07] text-[#8FB1FF]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 rounded-[8px] bg-white/[0.04] border border-white/[0.08] px-3.5 py-3 overflow-x-auto font-mono">
      {children}
    </pre>
  ),
};

export default function MarkdownMessage({ content, pending }: { content: string; pending?: boolean }) {
  if (!content && pending) {
    return <span className="text-accent anim-softpulse">Thinking…</span>;
  }
  return (
    <div className="text-[13px] leading-[1.6]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content + (pending ? "◍" : "")}
      </ReactMarkdown>
    </div>
  );
}
