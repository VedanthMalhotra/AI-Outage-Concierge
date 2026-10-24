/* Small, typed DOM helpers shared across the app. */

/** Query a single element, typed. Throws if required and missing. */
export function $<T extends Element = HTMLElement>(
  sel: string,
  required = true
): T {
  const node = document.querySelector<T>(sel);
  if (!node && required) throw new Error(`Element not found: ${sel}`);
  return node as T;
}

/** Create an element with an optional class and inner HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string | null,
  html?: string | null
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}

/** Fetch and parse a JSON file from the mock API folder. */
export async function getJSON<T>(apiBase: string, name: string): Promise<T> {
  const res = await fetch(`${apiBase}/${name}`);
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return (await res.json()) as T;
}

/** Transient status toast. */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string): void {
  const t = $<HTMLElement>("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
