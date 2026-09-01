import { lazy, Suspense } from "react";
import { type KnowledgeContent } from "./api";

const MarkdownContent = lazy(() => import("./MarkdownContent").then(({ MarkdownContent: Component }) => ({ default: Component })));

export function ContentRenderer({ content, emptyMessage }: { content: KnowledgeContent; emptyMessage: string }) {
  if (!content.data) return <div className="content-copy">{emptyMessage}</div>;
  if (content.format.toLowerCase() === "markdown" || content.format.toLowerCase() === "md") {
    return <Suspense fallback={<div className="content-copy">{content.data}</div>}><MarkdownContent value={content.data} /></Suspense>;
  }
  return <div className="content-copy">{content.data}</div>;
}
