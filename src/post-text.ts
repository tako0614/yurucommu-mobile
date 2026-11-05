export interface MobilePostContent {
  readonly ap_id: string;
  readonly content: string;
  readonly summary?: unknown;
  readonly edited_at?: unknown;
  readonly attachments?: unknown;
}

/** Malformed warning metadata must not silently reveal the body. */
export function postWarning(summary: unknown): string | null {
  if (summary === undefined || summary === null || summary === "") return null;
  return typeof summary === "string" ? summary.trim() || "内容の警告" : "内容の警告";
}

/** Viewer counters and read provenance do not change the disclosed content. */
export function postContentRevision(post: MobilePostContent): string {
  return JSON.stringify([
    post.ap_id,
    post.content,
    post.summary ?? null,
    post.edited_at ?? null,
    post.attachments ?? null,
  ]);
}

// Keep ActivityPub HTML inert, without fetching embedded images or scripts.
export function postText(content: string): string {
  const template = document.createElement("template");
  template.innerHTML = content;
  template.content.querySelectorAll("script,style,noscript").forEach(node => node.remove());
  template.content.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
  template.content.querySelectorAll("p,div,li").forEach(node => node.append("\n"));
  return template.content.textContent?.trim() ?? "";
}
