import ReactMarkdown from "react-markdown";

export function MarkdownContent({ value }: { value: string }) {
  return <div className="markdown-content"><ReactMarkdown skipHtml>{value}</ReactMarkdown></div>;
}
