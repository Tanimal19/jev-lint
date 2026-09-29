type Props = { cls?: string; text?: string; attrs?: Record<string, string> };

export function h<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement | null, tag: K, { cls, text, attrs }: Props = {}
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
}

// Lucide icon bodies (24×24, stroke-based).
const ICONS = {
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  "panel-right": '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

export function setIcon(el: HTMLElement, name: keyof typeof ICONS) {
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export function iconButton(parent: HTMLElement, icon: keyof typeof ICONS, label: string): HTMLButtonElement {
  const b = h(parent, "button", { cls: "icon-button", attrs: { "aria-label": label, title: label, type: "button" } });
  setIcon(b, icon);
  return b;
}

export function notice(message: string) {
  const host = document.querySelector(".notices") ?? h(document.body, "div", { cls: "notices" });
  const n = h(host as HTMLElement, "div", { cls: "notice", text: message });
  setTimeout(() => n.remove(), 4500);
}
