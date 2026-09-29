import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { h, iconButton, notice, setIcon } from "./dom";
import { LANGS, Lang, detectLang, isLang, lang, setLang, t } from "./i18n";
import {
  ApiUsage, DEFAULTS, Hit, Rule, Settings, Tally, Usage, Violation, activate, activeField, clearHits, closeActive,
  defaultRules, emptyUsage, evaluate, hitField, lintExtensions, newRule, ruleLabel, sentenceField, setAbbreviations,
  setHits, stepActive,
} from "./lint";
import { SAMPLE } from "./sample";
import "./style.css";

// ---------- Storage ----------
// localStorage can be unavailable (private mode, blocked site data); the app then just doesn't persist.
function load<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(`jev-lint:${key}`);
    return v === null ? null : JSON.parse(v);
  } catch {
    return null;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(`jev-lint:${key}`, JSON.stringify(value));
  } catch {
    // Not persisted.
  }
}

// ---------- Editor ----------
const markdownStyle = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.35em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "700" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
  { tag: tags.quote, color: "var(--text-muted)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--text-faint)" },
]);

const editorTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--paper)" },
  "&.cm-focused": { outline: "none" },
  // Tall lines leave room above each line for the sentence ids.
  ".cm-scroller": { fontFamily: "var(--font-text)", fontSize: "18px", lineHeight: "2.1" },
  // The wide left padding is the gutter for paragraph ids.
  ".cm-content": {
    maxWidth: "var(--line-width)", margin: "0 auto", padding: "56px 24px 40vh 72px", caretColor: "var(--text)",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-selectionBackground": { background: "var(--selection) !important" },
});

// ---------- App ----------
class JevLint {
  settings: Settings;
  // condition -> (sentence text -> P(yes)). Keyed by condition so editing a rule invalidates only it.
  cache = new Map<string, Map<string, number>>();
  usageTotal: Usage;
  usageSession: Usage = emptyUsage();
  tally: Tally[] = [];
  running = false;
  rerun = false;
  // Wall time of the last run that asked Jev anything, and whether any of its requests failed.
  lastRunMs: number | null = null;
  lastRunFailed = false;
  view: EditorView;
  panel: LintPanel;
  stats: StatsBar;

  constructor(editorEl: HTMLElement, panelEl: HTMLElement, statsEl: HTMLElement, statusEl: HTMLElement) {
    const { usage, ...saved } = load<Partial<Settings> & { usage?: Usage }>("settings") ?? {};
    this.usageTotal = { ...emptyUsage(), ...usage };
    this.settings = { ...DEFAULTS, rules: defaultRules(), ...saved };

    let saveTimer: number | undefined;
    this.view = new EditorView({
      parent: editorEl,
      state: EditorState.create({
        doc: load<string>("doc") ?? SAMPLE,
        extensions: [
          history(),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => { this.run(true); return true; } },
            // Only while a details card is open; otherwise these fall through to the default bindings.
            { key: "Alt-ArrowDown", run: (v) => stepActive(v, 1) },
            { key: "Alt-ArrowUp", run: (v) => stepActive(v, -1) },
            { key: "Escape", run: closeActive },
            indentWithTab, ...defaultKeymap, ...historyKeymap,
          ]),
          markdown(),
          syntaxHighlighting(markdownStyle),
          EditorView.lineWrapping,
          editorTheme,
          lintExtensions(this.settings.abbreviations),
          EditorView.updateListener.of((u) => {
            const activeChanged = u.startState.field(activeField) !== u.state.field(activeField);
            if (activeChanged || u.startState.field(hitField) !== u.state.field(hitField)) this.panel.renderCard();
            if (activeChanged && u.state.field(activeField) !== null) showPanel();
            if (!u.docChanged) return;
            this.stats.render();
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => store("doc", this.view.state.doc.toString()), 300);
          }),
        ],
      }),
    });
    this.stats = new StatsBar(statsEl, statusEl, this);
    this.panel = new LintPanel(panelEl, this);
    this.render();
  }

  refresh() {
    this.panel.refresh();
    this.stats.render();
  }

  saveSettings() {
    store("settings", { ...this.settings, usage: this.usageTotal });
  }

  addUsage(u: ApiUsage) {
    const cost = (u.input_tokens / 1e6) * this.settings.pricePerMTok;
    for (const t of [this.usageTotal, this.usageSession]) {
      t.inputTokens += u.input_tokens;
      t.outputTokens += u.output_tokens;
      t.cost += cost;
    }
    this.refresh();
  }

  resetUsage() {
    this.usageTotal = emptyUsage();
    this.saveSettings();
    this.refresh();
  }

  // Drop results of conditions no rule uses anymore.
  pruneRules() {
    const live = new Set(this.settings.rules.map((r) => r.condition));
    for (const cond of this.cache.keys()) if (!live.has(cond)) this.cache.delete(cond);
  }

  // Draw highlights from cache using the current document offsets.
  render() {
    const tally: Tally[] = this.settings.rules.map((rule) => ({
      rule,
      count: rule.condition && this.cache.has(rule.condition) ? 0 : null,
    }));
    const hits: Hit[] = [];
    for (const x of this.view.state.field(sentenceField).list) {
      const violations: Violation[] = [];
      for (const t of tally) {
        const r = t.rule;
        const p = r.condition ? this.cache.get(r.condition)?.get(x.text) : undefined;
        if (p === undefined || p < r.threshold) continue;
        violations.push({ rule: r, p });
        t.count!++;
      }
      if (violations.length) hits.push({ from: x.from, to: x.to, violations });
    }
    this.view.dispatch({ effects: setHits.of(hits) });
    this.tally = tally;
    this.refresh();
  }

  clear() {
    this.view.dispatch({ effects: clearHits.of(null) });
  }

  // Select the next highlighted sentence (after the cursor, wrapping around) that violates `rule`.
  jumpToNext(rule: Rule) {
    const cm = this.view;
    const ranges: [number, number][] = [];
    cm.state.field(hitField).between(0, cm.state.doc.length, (from, to, deco) => {
      if ((deco.spec.violations as Violation[]).some((v) => v.rule === rule)) ranges.push([from, to]);
    });
    if (!ranges.length) return;
    const cursor = cm.state.selection.main.to;
    const [from, to] = ranges.find(([f]) => f >= cursor) ?? ranges[0];
    cm.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: "center" }) });
    cm.focus();
  }

  async run(auto: boolean) {
    if (this.running) {
      this.rerun = true;
      return;
    }
    const conditions = [...new Set(this.settings.rules.map((r) => r.condition).filter(Boolean))];
    if (!this.settings.apiKey || !conditions.length) {
      if (!auto) notice(t.needKeyAndRule);
      return;
    }

    const doc = this.view.state.doc.toString();
    const texts = [...new Set(this.view.state.field(sentenceField).list.map((x) => x.text))];

    this.pruneRules();
    const present = new Set(texts);
    for (const ruleCache of this.cache.values()) {
      for (const t of ruleCache.keys()) if (!present.has(t)) ruleCache.delete(t);
    }

    this.running = true;
    this.refresh();
    const startedAt = performance.now();
    try {
      let checked = 0;
      const results = await Promise.allSettled(
        conditions.map(async (cond) => {
          if (!this.cache.has(cond)) this.cache.set(cond, new Map());
          const ruleCache = this.cache.get(cond)!;
          const todo = texts.filter((t) => !ruleCache.has(t));
          if (!todo.length) return;
          const res = await evaluate(this.settings, cond, doc, todo, (u) => this.addUsage(u));
          res.forEach((p, t) => ruleCache.set(t, p));
          checked += todo.length;
        })
      );
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (checked || failed.length) {
        this.lastRunMs = Math.round(performance.now() - startedAt);
        this.lastRunFailed = failed.length > 0;
      }
      this.render();
      this.saveSettings();
      if (failed.length) {
        failed.forEach((f) => console.error(f.reason));
        notice(t.runFailed(failed.length, conditions.length, (failed[0].reason as Error).message));
      } else if (!auto) {
        notice(t.runDone(checked, conditions.length));
      }
    } catch (e) {
      console.error(e);
      this.lastRunFailed = true;
      notice(t.runError((e as Error).message));
    } finally {
      this.running = false;
      this.refresh();
      if (this.rerun) {
        this.rerun = false;
        this.run(true);
      }
    }
  }
}

// ---------- Rule card ----------
function ruleEditor(parent: HTMLElement, rule: Rule, onChange: () => void, onDelete: () => void) {
  const box = h(parent, "div", { cls: "jev-rule-editor" });
  const head = h(box, "div", { cls: "jev-rule-editor-head" });
  const color = h(head, "input", { attrs: { type: "color", "aria-label": t.ruleColor } });
  color.value = rule.color;
  const name = h(head, "input", { attrs: { type: "text", placeholder: t.untitledRule, "aria-label": t.ruleName } });
  // The name is written in the rule's ink, like its margin labels.
  name.style.color = rule.color;
  color.addEventListener("input", () => { rule.color = color.value; name.style.color = rule.color; onChange(); });
  name.value = rule.name;
  name.addEventListener("input", () => { rule.name = name.value.trim(); onChange(); });
  iconButton(head, "trash", t.deleteRule).addEventListener("click", onDelete);

  const condition = h(box, "textarea", {
    attrs: { "aria-label": t.condition, placeholder: t.conditionPlaceholder },
  });
  condition.value = rule.condition;
  condition.addEventListener("input", () => { rule.condition = condition.value.trim(); onChange(); });

  const threshold = h(box, "div", { cls: "jev-rule-editor-threshold" });
  h(threshold, "div", { cls: "jev-rule-editor-label", text: t.threshold });
  const slider = h(threshold, "input", {
    attrs: { type: "range", min: "0.5", max: "0.99", step: "0.01", "aria-label": t.threshold },
  });
  slider.value = String(rule.threshold);
  const value = h(threshold, "span", { cls: "jev-rule-editor-value", text: rule.threshold.toFixed(2) });
  slider.addEventListener("input", () => {
    rule.threshold = Number(slider.value);
    value.textContent = rule.threshold.toFixed(2);
    onChange();
  });
}

// ---------- Side panel ----------
class LintPanel {
  // Ids of collapsed sections.
  private collapsed = new Set(load<string[]>("collapsed") ?? []);
  private cardEl!: HTMLElement;
  private violationsEl!: HTMLElement;
  private rulesEl!: HTMLElement;
  private usageEl!: HTMLElement;

  constructor(private el: HTMLElement, private app: JevLint) {
    this.build();
  }

  // Also rebuilds everything in the current language.
  build() {
    const { el } = this;
    el.replaceChildren();
    this.cardEl = h(el, "div", { cls: "jev-card", attrs: { role: "region", "aria-label": t.sentenceDetails } });
    this.cardEl.hidden = true;
    this.violationsEl = this.section(el, "violations", t.violations);
    this.rulesEl = this.section(el, "rules", t.rules);
    this.usageEl = this.section(el, "usage", t.usage);
    this.renderRules();
    this.renderCard();
  }

  // A section with a clickable heading that collapses it. Returns the body to render into.
  private section(parent: HTMLElement, id: string, title: string): HTMLElement {
    const section = h(parent, "section", { cls: "jev-panel-section" });
    section.classList.toggle("is-collapsed", this.collapsed.has(id));
    const head = h(section, "button", { cls: "jev-panel-section-head", attrs: { type: "button" } });
    head.setAttribute("aria-expanded", String(!this.collapsed.has(id)));
    setIcon(h(head, "span", { cls: "jev-panel-section-icon" }), "chevron-down");
    h(head, "h2", { text: title });
    head.addEventListener("click", () => {
      const collapse = !this.collapsed.has(id);
      if (collapse) this.collapsed.add(id);
      else this.collapsed.delete(id);
      section.classList.toggle("is-collapsed", collapse);
      head.setAttribute("aria-expanded", String(!collapse));
      store("collapsed", [...this.collapsed]);
    });
    return h(section, "div", { cls: "jev-panel-section-body" });
  }

  refresh() {
    this.renderViolations();
    this.renderUsage();
    document.body.classList.toggle("is-running", this.app.running);
  }

  // Details of the sentence whose highlight was clicked.
  renderCard() {
    const el = this.cardEl;
    const { view, settings } = this.app;
    const pos = view.state.field(activeField);
    const found: Hit[] = [];
    if (pos !== null) {
      view.state.field(hitField).between(pos, pos, (from, to, deco) => {
        if (from === pos) found.push({ from, to, violations: deco.spec.violations });
      });
    }
    el.replaceChildren();
    el.hidden = !found.length;
    if (!found.length) return;
    const { from, to, violations } = found[0];

    const head = h(el, "div", { cls: "jev-card-head" });
    h(head, "q", { cls: "jev-card-quote", text: view.state.sliceDoc(from, to) });
    iconButton(head, "x", t.close).addEventListener("click", () => activate(view, null));

    for (const { rule, p } of [...violations].sort((a, b) => b.p - a.p)) {
      const item = h(el, "div", { cls: "jev-card-item" });
      const title = h(item, "div", { cls: "jev-card-title" });
      h(title, "span", { cls: "jev-card-rule", text: ruleLabel(rule) }).style.color = rule.color;
      h(title, "span", { cls: "jev-card-score", text: `${Math.round(p * 100)}%` });
      if (rule.condition && rule.condition !== ruleLabel(rule)) {
        h(item, "p", { cls: "jev-card-desc", text: rule.condition });
      }
      h(item, "div", {
        cls: "jev-card-meta",
        text: t.judgedBy(settings.model, Math.round(rule.threshold * 100)),
      });
    }
    h(el, "div", { cls: "jev-card-hint", text: t.cardHint });
  }

  private renderViolations() {
    const el = this.violationsEl;
    el.replaceChildren();
    const { tally } = this.app;
    if (!tally.length) {
      h(el, "div", { cls: "jev-panel-empty", text: t.noLintRules });
      return;
    }
    for (const { rule, count } of tally) {
      const row = h(el, count ? "button" : "div", { cls: "jev-panel-rule" });
      h(row, "span", { cls: "jev-swatch" }).style.backgroundColor = rule.color;
      h(row, "span", { cls: "jev-panel-rule-label", text: ruleLabel(rule) });
      h(row, "span", { cls: "jev-panel-rule-count", text: count === null ? "–" : String(count) });
      if (count) {
        row.classList.add("is-clickable");
        row.title = t.jumpToNext;
        row.addEventListener("click", () => this.app.jumpToNext(rule));
      }
    }
  }

  // Rebuilt only on structural changes: rebuilding while a field has focus would drop the caret or a slider drag.
  renderRules() {
    const el = this.rulesEl;
    el.replaceChildren();
    const { app } = this;
    const commit = () => { app.saveSettings(); app.render(); };
    if (!app.settings.rules.length) h(el, "div", { cls: "jev-panel-empty", text: t.noRulesYet });
    for (const rule of app.settings.rules) {
      ruleEditor(el, rule, commit, () => {
        app.settings.rules = app.settings.rules.filter((r) => r.id !== rule.id);
        commit();
        this.renderRules();
      });
    }
    h(el, "button", { cls: "jev-add-rule", text: t.addRule, attrs: { type: "button" } }).addEventListener("click", () => {
      app.settings.rules.push(newRule(app.settings.rules));
      commit();
      this.renderRules();
      el.querySelector<HTMLTextAreaElement>(".jev-rule-editor:last-of-type textarea")?.focus();
    });
  }

  private renderUsage() {
    const el = this.usageEl;
    el.replaceChildren();
    const { usageSession, usageTotal } = this.app;
    const table = h(el, "table", { cls: "jev-usage" });
    const head = h(table, "tr");
    for (const label of ["", t.session, t.total]) h(head, "th", { text: label });
    const rows: [string, (u: Usage) => string][] = [
      [t.inputTokens, (u) => u.inputTokens.toLocaleString()],
      [t.outputTokens, (u) => u.outputTokens.toLocaleString()],
      [t.cost, (u) => `$${u.cost.toFixed(u.cost < 0.01 ? 6 : 4)}`],
    ];
    for (const [label, fmt] of rows) {
      const tr = h(table, "tr");
      h(tr, "td", { text: label });
      h(tr, "td", { text: fmt(usageSession) });
      h(tr, "td", { text: fmt(usageTotal) });
    }
    h(el, "button", { cls: "button", text: t.resetTotal, attrs: { type: "button" } })
      .addEventListener("click", () => this.app.resetUsage());
  }
}

// ---------- Stats bar ----------
// Each CJK character counts as a word.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;
// Rough reading speeds, per minute.
const CJK_PER_MIN = 300;
const WORDS_PER_MIN = 230;

class StatsBar {
  constructor(private el: HTMLElement, private statusEl: HTMLElement, private app: JevLint) {}

  render() {
    const { el, app } = this;
    const sentences = app.view.state.field(sentenceField).list;
    let cjk = 0;
    let words = 0;
    for (const { text } of sentences) {
      cjk += text.match(CJK)?.length ?? 0;
      words += text.replace(CJK, " ").match(WORD)?.length ?? 0;
    }

    el.replaceChildren();
    const stat = (value: number, label: string, tag: "span" | "button" = "span") => {
      const s = h(el, tag, { cls: "stat" });
      h(s, "b", { text: String(value) });
      return h(s, "span", { text: label });
    };
    stat(cjk + words, t.words);
    stat(sentences.length, t.sentences);
    stat(Math.max(1, Math.ceil(cjk / CJK_PER_MIN + words / WORDS_PER_MIN)), t.minutes);
    for (const { rule, count } of app.tally) {
      if (!count) continue;
      const label = stat(count, ruleLabel(rule), "button");
      label.style.color = rule.color;
      const button = label.parentElement!;
      Object.assign(button, { type: "button", title: t.jumpToNext });
      button.addEventListener("click", () => app.jumpToNext(rule));
    }

    const status = this.statusEl;
    status.classList.toggle("is-running", app.running);
    status.classList.toggle("is-failed", !app.running && app.lastRunFailed);
    status.textContent = app.lastRunMs === null ? app.settings.model : `${app.settings.model} · ${app.lastRunMs} ms`;
  }
}

// ---------- Settings dialog ----------
function openSettings(app: JevLint) {
  const s = app.settings;
  const dialog = h(document.body, "dialog", { cls: "settings" });

  const field = (label: string, desc?: string) => {
    const row = h(dialog, "label", { cls: "setting" });
    h(row, "span", { cls: "setting-name", text: label });
    if (desc) h(row, "span", { cls: "setting-desc", text: desc });
    return row;
  };
  const input = (row: HTMLElement, value: string, type = "text") => {
    const i = h(row, "input", { attrs: { type, spellcheck: "false" } });
    i.value = value;
    return i;
  };

  // Rebuilt in place when the language changes, so the dialog stays open.
  const build = () => {
    dialog.replaceChildren();
    const head = h(dialog, "div", { cls: "settings-head" });
    h(head, "h2", { text: t.settings });
    iconButton(head, "x", t.close).addEventListener("click", () => dialog.close());

    const language = h(field(t.language), "select");
    for (const [l, name] of Object.entries(LANGS)) h(language, "option", { text: name, attrs: { value: l } });
    language.value = lang;
    language.addEventListener("change", () => {
      if (!isLang(language.value)) return;
      changeLang(language.value);
      build();
      dialog.querySelector("select")!.focus();
    });

    const key = input(field(t.apiKey, t.apiKeyDesc), s.apiKey, "password");
    key.addEventListener("input", () => { s.apiKey = key.value.trim(); app.saveSettings(); });

    const endpoint = input(field(t.endpoint, t.endpointDesc), s.endpoint);
    endpoint.addEventListener("input", () => {
      s.endpoint = endpoint.value.trim() || DEFAULTS.endpoint;
      app.saveSettings();
    });

    const model = input(field(t.model), s.model);
    model.addEventListener("input", () => {
      s.model = model.value.trim();
      app.cache.clear();
      app.saveSettings();
      app.stats.render();
    });

    const price = input(field(t.price, t.priceDesc), String(s.pricePerMTok), "number");
    Object.assign(price, { min: "0", step: "any" });
    price.addEventListener("input", () => {
      const n = Number(price.value);
      if (price.value.trim() !== "" && Number.isFinite(n) && n >= 0) { s.pricePerMTok = n; app.saveSettings(); }
    });

    const abbr = h(field(t.abbreviations, t.abbreviationsDesc), "textarea", { attrs: { spellcheck: "false" } });
    abbr.value = s.abbreviations.join(" ");
    abbr.addEventListener("input", () => {
      s.abbreviations = abbr.value.split(/\s+/).filter(Boolean);
      app.saveSettings();
      app.view.dispatch({ effects: setAbbreviations.of(s.abbreviations) });
      app.render();
    });
  };
  build();

  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.showModal();
}

// ---------- Boot ----------
const savedLang = load<unknown>("lang");
setLang(isLang(savedLang) ? savedLang : detectLang());

const panelEl = document.querySelector<HTMLElement>(".panel")!;
const app = new JevLint(
  document.querySelector(".editor")!, panelEl,
  document.querySelector(".stats")!, document.querySelector(".status")!,
);

const wide = matchMedia("(min-width: 860px)");
const setPanel = (open: boolean) => {
  document.body.classList.toggle("panel-open", open);
  if (wide.matches) store("panel-open", open);
};
setPanel(wide.matches && (load<boolean>("panel-open") ?? true));

// Reveals an opened details card. On narrow screens the panel covers the text, so it stays closed there.
function showPanel() {
  if (wide.matches && !document.body.classList.contains("panel-open")) setPanel(true);
}

const actions = document.querySelector<HTMLElement>(".topbar-actions")!;
// The status element lives in `actions` too; only the buttons after it are rebuilt.
const status = actions.querySelector(".status")!;
function renderActions() {
  while (status.nextSibling) status.nextSibling.remove();
  panelEl.setAttribute("aria-label", t.lintPanel);
  const runButton = h(actions, "button", { cls: "button mod-cta run-button", attrs: { type: "button" } });
  h(runButton, "span", { text: t.runLint });
  h(runButton, "kbd", { text: navigator.platform.startsWith("Mac") ? "⌘S" : "Ctrl+S" });
  runButton.addEventListener("click", () => app.run(false));
  h(actions, "button", { cls: "button", text: t.clear, attrs: { type: "button", title: t.clearHighlights } })
    .addEventListener("click", () => app.clear());
  iconButton(actions, "settings", t.settings).addEventListener("click", () => openSettings(app));
  iconButton(actions, "panel-right", t.togglePanel)
    .addEventListener("click", () => setPanel(!document.body.classList.contains("panel-open")));
}
renderActions();
document.querySelector(".panel-scrim")!.addEventListener("click", () => setPanel(false));

function changeLang(l: Lang) {
  setLang(l);
  store("lang", l);
  renderActions();
  app.panel.build();
  app.render();
}

app.view.focus();
