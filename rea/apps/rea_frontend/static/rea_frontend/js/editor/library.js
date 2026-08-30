/**
 * library.js
 *
 * The exercise list: find an exercise to edit, or start a new one.
 *
 * The library holds around twelve thousand lessons, so this is a *search*,
 * not a tree — a teacher who wants "the G major octave formula, ABC variant"
 * types part of it and narrows with the same facets the exercises are filed
 * under.  Nothing here loads a lesson's notes; opening one does that.
 */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

export class Library {
  /**
   * @param {HTMLElement} root
   * @param {object} hooks  {onOpen(system, id), onNew(system), search(params)}
   */
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.system = "relative";
    this.filters = {};
    this.results = [];
    this.count = 0;
    this.loading = false;
    this.error = null;
    this.currentId = null;
    this.options = null;
  }

  setOptions(options) { this.options = options; }

  /** Mark which exercise is open, so the list shows where you are. */
  setCurrent(system, id) {
    this.system = system || this.system;
    this.currentId = id;
    this._paintResults();
  }

  async refresh() {
    this.loading = true;
    this.error = null; // a new search clears the last one's failure
    this._paintResults();
    try {
      const data = await this.hooks.search(Object.assign({ system: this.system }, this.filters));
      this.results = data.results || [];
      this.count = data.count || 0;
    } catch (e) {
      this.results = [];
      this.count = 0;
      this.error = e.message;
    }
    this.loading = false;
    this._paintResults();
  }

  render() {
    this.root.innerHTML = "";

    const head = el("div", "ed-lib-head");
    head.appendChild(el("h2", "ed-lib-title", "Exercises"));
    const newButton = el("button", "ed-btn ed-btn-primary", "New");
    newButton.type = "button";
    newButton.title = "Start an empty exercise in this system";
    newButton.addEventListener("click", () => this.hooks.onNew(this.system));
    head.appendChild(newButton);
    this.root.appendChild(head);

    const systems = el("div", "ed-seg");
    [["relative", "Relative"], ["absolute", "Absolute"]].forEach(([value, label]) => {
      const button = el("button", `ed-seg-btn${this.system === value ? " is-active" : ""}`, label);
      button.type = "button";
      button.addEventListener("click", () => {
        if (this.system === value) return;
        this.system = value;
        this.filters = {};
        this.render();
        this.refresh();
      });
      systems.appendChild(button);
    });
    this.root.appendChild(systems);

    const search = el("input", "ed-input ed-lib-search");
    search.type = "search";
    search.placeholder = this.system === "relative"
      ? "Search key, formula, variant…"
      : "Search category, exercise type…";
    search.value = this.filters.search || "";
    let timer = null;
    search.addEventListener("input", () => {
      this.filters.search = search.value;
      clearTimeout(timer);
      timer = setTimeout(() => this.refresh(), 220);
    });
    this.root.appendChild(search);

    this.root.appendChild(this._filters());

    this.list = el("div", "ed-lib-list");
    this.root.appendChild(this.list);
    this._paintResults();
  }

  _filters() {
    const wrap = el("div", "ed-lib-filters");
    const options = this.options || {};

    const select = (key, label, values) => {
      const node = el("select", "ed-input ed-input-sm");
      const blank = el("option", null, label);
      blank.value = "";
      node.appendChild(blank);
      (values || []).forEach((value) => {
        const option = typeof value === "object" ? value : { value, label: value };
        const item = el("option", null, option.label);
        item.value = String(option.value);
        node.appendChild(item);
      });
      node.value = this.filters[key] || "";
      node.addEventListener("change", () => {
        this.filters[key] = node.value;
        this.refresh();
      });
      wrap.appendChild(node);
    };

    select("texture", "Any texture", [
      { value: "mono", label: "Melodic" },
      { value: "poly", label: "Harmonic" },
    ]);

    if (this.system === "relative") {
      select("key_model", "Any key", (options.keys || []).map((k) => ({ value: k.id, label: k.name })));
      select("category", "Any category", ((options.relative || {}).categories || []));
      select("formula_name", "Any formula", (options.relative || {}).formula_names);
    } else {
      select("category", "Any category", ((options.absolute || {}).categories || []));
      select("span", "Any span", ((options.absolute || {}).spans || []));
      select("exercise_type", "Any type", (options.absolute || {}).exercise_types);
    }
    return wrap;
  }

  _paintResults() {
    if (!this.list) return;
    this.list.innerHTML = "";
    if (this.loading) {
      this.list.appendChild(el("p", "ed-hint", "Searching…"));
      return;
    }
    if (this.error) {
      this.list.appendChild(el("p", "ed-error", this.error));
      return;
    }
    if (!this.results.length) {
      this.list.appendChild(el("p", "ed-hint", "No exercises match. Widen the search, or start a new one."));
      return;
    }

    const shown = this.results.length;
    this.list.appendChild(el(
      "p", "ed-lib-count",
      shown < this.count ? `${shown} of ${this.count} — narrow the search to see the rest` : `${this.count} exercise${this.count === 1 ? "" : "s"}`
    ));

    this.results.forEach((row) => {
      const isCurrent = this.currentId === row.id && this.system === row.system;
      const item = el("button", `ed-lib-item${isCurrent ? " is-current" : ""}`);
      item.type = "button";
      item.appendChild(el("span", "ed-lib-name", row.name));
      item.appendChild(el("span", "ed-lib-meta", `${row.bars} bar${row.bars === 1 ? "" : "s"}`));
      item.addEventListener("click", () => this.hooks.onOpen(row.system, row.id));
      this.list.appendChild(item);
    });
  }
}
