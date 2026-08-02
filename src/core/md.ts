/** Pipeline markdown compartido (Reader + ChatView): instancia AISLADA de
 *  marked (no tocar la global que usa FileView) con code blocks resueltos a
 *  nivel STRING: caja + header con lenguaje + boton copiar + hljs.
 *
 *  REGLA DURA: el HTML se genera COMPLETO aqui y NUNCA se muta el DOM despues
 *  del render (React 19 re-setea innerHTML en cada re-render; ver Reader.tsx).
 *  El boton copiar se atiende por DELEGACION (handleDocClick). */
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import * as ipc from "./ipc";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const md = new Marked({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : null;
      let inner: string;
      try {
        inner = language
          ? hljs.highlight(text, { language }).value
          : hljs.highlightAuto(text.slice(0, 30_000)).value;
      } catch {
        inner = escapeHtml(text);
      }
      return (
        `<div class="reader-code"><div class="reader-code-head">` +
        `<span>${escapeHtml(language ?? "code")}</span>` +
        `<button class="reader-copybtn" type="button">⧉ copiar</button></div>` +
        `<pre><code class="hljs">${inner}</code></pre></div>`
      );
    },
  },
});

/** Markdown → HTML seguro, listo para dangerouslySetInnerHTML. */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.parse(text, { async: false }) as string);
}

/** Delegacion de clicks dentro de un documento renderizado: boton copiar de
 *  code blocks + links que NUNCA navegan el webview (http sale al browser). */
export function handleDocClick(e: React.MouseEvent): boolean {
  const t = e.target as HTMLElement;
  const btn = t.closest(".reader-copybtn") as HTMLButtonElement | null;
  if (btn) {
    e.preventDefault();
    const code = btn.closest(".reader-code")?.querySelector("pre code") as HTMLElement | null;
    if (code) {
      void navigator.clipboard.writeText(code.innerText);
      btn.textContent = "✓ copiado";
      btn.classList.add("ok");
      setTimeout(() => {
        btn.textContent = "⧉ copiar";
        btn.classList.remove("ok");
      }, 1800);
    }
    return true;
  }
  const a = t.closest("a");
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^https?:\/\//.test(href)) void ipc.openUrl(href);
    return true;
  }
  return false;
}
