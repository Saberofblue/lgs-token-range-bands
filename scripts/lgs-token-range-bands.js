/**
 * Lyinggods Token Range Bands - Foundry VTT 13/14 build.
 *
 * Range bands are drawn on the canvas interface layer (Foundry 14 removed MeasuredTemplates, which
 * the original used) and mirrored to every client over the module socket. The narrative labels are
 * applied to both rulers Foundry 13 introduced: the drag ruler (Ruler) and the token ruler
 * (TokenRuler), through their waypoint label context.
 */
const MODULE_ID = "lgs-token-range-bands";
const SOCKET = `module.${MODULE_ID}`;
const BAND_COLORS = ["#C75153", "#D3BE82", "#BBD8AB", "#63856B", "#7aa384", "#95c7a1", "#aae3b8", "#c8fad4", "#9df5b2"];
const DEFAULT_RANGES = [
  { name: "Short Range", distance: 2 },
  { name: "Medium Range", distance: 5 },
  { name: "Long Range", distance: 10 },
  { name: "Extreme Range", distance: 20 },
];

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);

  game.settings.register(MODULE_ID, "distanceConfig", {
    name: "Distance Configuration",
    scope: "world",
    config: false,
    type: Object,
    default: [],
  });

  game.settings.register(MODULE_ID, "sizeMultiplier", {
    name: "Size Multiplier",
    hint: "The default value for determining relative size of range bands relative to grid/token size. Change based on expected scale of maps. Recommend values between 5-10. Individual scenes are customizable via Scene Configuration",
    scope: "client",
    config: true,
    default: 5,
    type: Number,
  });

  game.settings.register(MODULE_ID, "exceedRangeMessage", {
    name: "Exceeds Range Message",
    hint: "The message to be shown when narrative drag ruler exceeds maximum range",
    scope: "client",
    config: true,
    default: "Exceeds Range",
    type: String,
  });

  game.settings.registerMenu(MODULE_ID, "distanceConfigMenu", {
    name: "Configure Distance Ranges",
    label: "Configure",
    hint: "Set up the narrative range distance categories.",
    icon: "fas fa-ruler-combined",
    type: DistanceConfigApp,
    restricted: true,
  });

  game.settings.register(MODULE_ID, "dragRulerApproximation", {
    name: "Drag Ruler Approximation",
    hint: "When grid type is 'square' attempts to compensate for system Euclidean calculations so that drag ruler approximates range bands on diagonal measurements. This has no effect if scene grid type is not 'Square'.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  // Narrative labels on both rulers
  for (const target of [
    "foundry.canvas.interaction.Ruler.prototype._getWaypointLabelContext",
    "foundry.canvas.placeables.tokens.TokenRuler.prototype._getWaypointLabelContext",
  ]) {
    libWrapper.register(MODULE_ID, target, function (wrapped, waypoint, state, ...rest) {
      const context = wrapped(waypoint, state, ...rest);
      try {
        return applyNarrativeLabel(context, waypoint);
      } catch (err) {
        console.error(`${MODULE_ID} | failed to apply the narrative range label`, err);
        return context;
      }
    }, "WRAPPER");
  }
});

Hooks.once("ready", async () => {
  if (!game.settings.get(MODULE_ID, "distanceConfig")) {
    await game.settings.set(MODULE_ID, "distanceConfig", []);
  }

  game.socket.on(SOCKET, (data) => {
    if (!data || data.senderId === game.user.id) return;
    if (!canvas.ready || data.sceneId !== canvas.scene?.id) return;
    if (data.action === "showBands") RangeBands.draw(data.tokenId);
    else if (data.action === "clearBands") RangeBands.clear(data.tokenId);
  });
});

/* -------------------------------------------- */
/*  Narrative ruler labels                      */
/* -------------------------------------------- */

/**
 * Sorted range configuration.
 * @returns {{name: string, distance: number}[]}
 */
function sortedRanges() {
  const config = game.settings.get(MODULE_ID, "distanceConfig") || [];
  return config
    .filter((r) => r && Number.isFinite(Number(r.distance)))
    .map((r) => ({ name: r.name, distance: Number(r.distance) }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Replace (or extend) the measured distance in a ruler waypoint label with the narrative range band.
 * The waypoint label template shows `cost` when the ruler provides it (the token ruler always does),
 * otherwise `distance`; whichever is shown carries the band name.
 * @param {object|undefined} context  The label context built by Foundry, or undefined for no label.
 * @param {object} waypoint           The ruler waypoint.
 * @returns {object|undefined}
 */
function applyNarrativeLabel(context, waypoint) {
  if (!context) return context;
  const measurementOption = canvas.scene?.getFlag(MODULE_ID, "measurementOption") || "narrative";
  if (measurementOption === "numeric") return context;
  const ranges = sortedRanges();
  if (!ranges.length) return context;

  const multiplier = canvas.scene?.getFlag(MODULE_ID, "rangeBandMultiplier") || 1;
  const measured = Number(waypoint?.measurement?.distance ?? 0);

  // Optional compensation for square-grid diagonals (kept from the original implementation)
  let angleAdjustment = 1;
  if (game.settings.get(MODULE_ID, "dragRulerApproximation") && (canvas.grid.type === CONST.GRID_TYPES.SQUARE) && waypoint?.ray) {
    const dx = Math.abs(waypoint.ray.dx);
    const dy = Math.abs(waypoint.ray.dy);
    if (dx !== 0 || dy !== 0) {
      const angle = Math.atan2(dy, dx);
      const diff = Math.min(angle, Math.abs(Math.PI / 2 - angle));
      const t = diff / (Math.PI / 4);
      angleAdjustment = 1 - t * (1 - 0.71875);
    }
  }

  let label = null;
  for (const { name, distance } of ranges) {
    if (measured <= distance * multiplier * angleAdjustment) {
      label = name;
      break;
    }
  }
  if (label === null) {
    label = game.settings.get(MODULE_ID, "exceedRangeMessage") || "Exceeds Range";
    context.cssClass = [context.cssClass, "lgs-range-exceeded"].filterJoin(" ");
  }

  const target = context.cost ?? context.distance;
  if (!target) return context;
  if (measurementOption === "addToMeasurements") {
    const numeric = `${target.total ?? ""} ${context.units ?? ""}`.trim();
    target.total = numeric ? `${numeric} · ${label}` : label;
  } else {
    target.total = label;
  }
  delete target.delta;
  context.units = "";
  if (context.cost) context.cost.units = "";
  return context;
}

/* -------------------------------------------- */
/*  Range band drawing                          */
/* -------------------------------------------- */

class RangeBands {
  /** @type {PIXI.Container|null} */
  static #layer = null;

  /** Drawn bands, keyed by token id. @type {Map<string, PIXI.Container>} */
  static #bands = new Map();

  static get layer() {
    if (!this.#layer || this.#layer.destroyed || this.#layer.parent !== canvas.interface) {
      this.#layer = new PIXI.Container();
      this.#layer.name = MODULE_ID;
      this.#layer.eventMode = "none";
      canvas.interface.addChild(this.#layer);
    }
    return this.#layer;
  }

  static has(tokenId) {
    return this.#bands.has(tokenId);
  }

  static get tokenIds() {
    return [...this.#bands.keys()];
  }

  /** Forget everything (the canvas is being torn down or rebuilt). */
  static reset() {
    for (const c of this.#bands.values()) if (!c.destroyed) c.destroy({ children: true });
    this.#bands.clear();
    if (this.#layer && !this.#layer.destroyed) this.#layer.destroy({ children: true });
    this.#layer = null;
  }

  static clear(tokenId) {
    const c = this.#bands.get(tokenId);
    if (c && !c.destroyed) c.destroy({ children: true });
    this.#bands.delete(tokenId);
    canvas.tokens.hud?.render();
  }

  /**
   * Draw the configured range bands around a token.
   * @param {string} tokenId
   * @returns {boolean} whether bands were drawn
   */
  static draw(tokenId) {
    this.clear(tokenId);
    const token = canvas.tokens.get(tokenId);
    if (!token) return false;
    const ranges = sortedRanges();
    if (!ranges.length) {
      ui.notifications.warn("Token Range Bands: no ranges configured. Configure them in the module settings.");
      return false;
    }
    const multiplier = canvas.scene.getFlag(MODULE_ID, "rangeBandMultiplier") || game.settings.get(MODULE_ID, "sizeMultiplier") || 1;
    const pxPerUnit = canvas.dimensions.size / canvas.dimensions.distance;
    const { x: cx, y: cy } = token.center;

    const group = new PIXI.Container();
    group.eventMode = "none";
    // outermost first so the inner bands draw on top
    for (let i = ranges.length - 1; i >= 0; i--) {
      const radius = ranges[i].distance * multiplier * pxPerUnit;
      const fill = foundry.utils.Color.from(BAND_COLORS[i] ?? "#ffffff");
      const shape = new PIXI.Graphics();
      shape.lineStyle(2, 0x0000ff, 0.8).beginFill(fill, 0.25).drawCircle(cx, cy, radius).endFill();
      group.addChild(shape);

      const style = CONFIG.canvasTextStyle.clone();
      style.fontSize = Math.round(22 * canvas.dimensions.uiScale);
      const label = new foundry.canvas.containers.PreciseText(ranges[i].name, style);
      label.anchor.set(0.5, 1);
      label.position.set(cx, cy - radius - 2);
      group.addChild(label);
    }
    this.layer.addChild(group);
    this.#bands.set(tokenId, group);
    canvas.tokens.hud?.render();
    return true;
  }

  static redrawAll() {
    for (const id of this.tokenIds) this.draw(id);
  }
}

/**
 * Toggle the range bands of a token, here and on every other client looking at this scene.
 * @param {Token} token
 */
function toggleRangeBands(token) {
  const tokenId = token.id;
  const sceneId = canvas.scene.id;
  if (RangeBands.has(tokenId)) {
    RangeBands.clear(tokenId);
    game.socket.emit(SOCKET, { action: "clearBands", tokenId, sceneId, senderId: game.user.id });
  } else if (RangeBands.draw(tokenId)) {
    game.socket.emit(SOCKET, { action: "showBands", tokenId, sceneId, senderId: game.user.id });
  }
}

Hooks.on("canvasReady", () => RangeBands.reset());
Hooks.on("canvasTearDown", () => RangeBands.reset());

// bands follow nothing: a token that moves (or changes size) loses its bands, on every client
Hooks.on("updateToken", (tokenDoc, changes) => {
  if (!canvas.ready || tokenDoc.parent?.id !== canvas.scene?.id) return;
  if (!RangeBands.has(tokenDoc.id)) return;
  if (["x", "y", "elevation", "width", "height"].some((k) => k in changes)) RangeBands.clear(tokenDoc.id);
});

Hooks.on("deleteToken", (tokenDoc) => {
  if (canvas.ready && RangeBands.has(tokenDoc.id)) RangeBands.clear(tokenDoc.id);
});

// a changed multiplier resizes bands that are currently shown
Hooks.on("updateScene", (scene, changes) => {
  if (!canvas.ready || scene.id !== canvas.scene?.id) return;
  if (foundry.utils.getProperty(changes, `flags.${MODULE_ID}.rangeBandMultiplier`) !== undefined) RangeBands.redrawAll();
});

/* -------------------------------------------- */
/*  Token HUD button                            */
/* -------------------------------------------- */

Hooks.on("renderTokenHUD", (hud, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const token = hud.object;
  if (!root || !token) return;
  const column = root.querySelector(".col.right");
  if (!column || column.querySelector(".lgs-range-bands")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon lgs-range-bands";
  button.classList.toggle("active", RangeBands.has(token.id));
  button.dataset.tooltip = "Toggle Range Bands";
  button.setAttribute("aria-label", "Toggle Range Bands");
  button.innerHTML = '<i class="fas fa-circle" inert></i>';
  button.addEventListener("click", (event) => {
    event.preventDefault();
    toggleRangeBands(token);
    button.classList.toggle("active", RangeBands.has(token.id));
  });
  column.append(button);
});

/* -------------------------------------------- */
/*  Scene configuration fields                  */
/* -------------------------------------------- */

const SCENE_TAB_ID = "lgs-range-bands";

// Register a Scene Configuration tab of our own. Foundry renders the nav entry from the static TABS
// list; the content panel is injected below on render. (Injecting into the Grid tab matched the
// nav link before the panel and left the fieldset inside a non-clickable tab link.)
Hooks.once("init", () => {
  const tabs = foundry.applications?.sheets?.SceneConfig?.TABS?.sheet?.tabs;
  if (Array.isArray(tabs) && !tabs.some((t) => t.id === SCENE_TAB_ID)) {
    tabs.push({ id: SCENE_TAB_ID, icon: "fa-solid fa-ruler", label: "Range Bands" });
  }
});

Hooks.on("renderSceneConfig", (app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const scene = app.document ?? app.object;
  if (!root || !scene) return;
  const form = app.form ?? root.querySelector("form") ?? root;
  if (form.querySelector(".lgs-range-bands-config")) return;

  const multiplier = scene.getFlag(MODULE_ID, "rangeBandMultiplier") ?? game.settings.get(MODULE_ID, "sizeMultiplier");
  const measurementOption = scene.getFlag(MODULE_ID, "measurementOption") || "narrative";
  const options = [
    ["narrative", "Narrative Drag Ruler Only"],
    ["addToMeasurements", "Add to Measurements"],
    ["numeric", "Numeric Measurements Only"],
  ].map(([v, l]) => `<option value="${v}" ${measurementOption === v ? "selected" : ""}>${l}</option>`).join("");

  const fieldset = document.createElement("fieldset");
  fieldset.className = "lgs-range-bands-config";
  fieldset.innerHTML = `
    <legend>Narrative Range Bands</legend>
    <p class="hint">Recommend the Gridless grid type for range bands and the narrative ruler.</p>
    <div class="form-group">
      <label>Range Band Multiplier</label>
      <div class="form-fields">
        <input type="number" name="flags.${MODULE_ID}.rangeBandMultiplier" value="${multiplier}" step="0.1" min="0">
      </div>
      <p class="hint">Sets the size of the range bands for this scene.</p>
    </div>
    <div class="form-group">
      <label>Measurement Display Option</label>
      <div class="form-fields">
        <select name="flags.${MODULE_ID}.measurementOption">${options}</select>
      </div>
    </div>`;

  // Our tab was registered at init: give it a content panel that core's tab switching toggles.
  const navLink = form.querySelector(`nav.tabs [data-tab="${SCENE_TAB_ID}"]`);
  if (navLink) {
    const section = document.createElement("div");
    section.className = "tab scrollable";
    section.dataset.group = "sheet";
    section.dataset.tab = SCENE_TAB_ID;
    if (app.tabGroups?.sheet === SCENE_TAB_ID) section.classList.add("active");
    section.append(fieldset);
    const footer = form.querySelector("footer.form-footer");
    if (footer) footer.before(section);
    else form.append(section);
    return;
  }

  // No registered tab (older core): fall back to the Grid tab's content panel, never its nav link.
  const gridTab = form.querySelector(`.tab[data-group="sheet"][data-tab="grid"]`) ?? form.querySelector(`section.tab[data-tab="grid"], div.tab[data-tab="grid"]`);
  if (gridTab) gridTab.append(fieldset);
});

// new scenes start with the default multiplier
Hooks.on("createScene", async (scene, options, userId) => {
  if (userId !== game.user.id) return;
  if (scene.getFlag(MODULE_ID, "rangeBandMultiplier") === undefined) {
    await scene.setFlag(MODULE_ID, "rangeBandMultiplier", game.settings.get(MODULE_ID, "sizeMultiplier"));
  }
});

/* -------------------------------------------- */
/*  Distance configuration dialog               */
/* -------------------------------------------- */

class DistanceConfigApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "distance-config",
      title: "Distance Configuration",
      template: `modules/${MODULE_ID}/templates/distance-config.html`,
      width: 500,
      height: "auto",
      closeOnSubmit: true,
    });
  }

  getData() {
    const distances = game.settings.get(MODULE_ID, "distanceConfig") || [];
    return { distances };
  }

  async _updateObject(event, formData) {
    let names = formData.name ?? [];
    let values = formData.distance ?? [];
    if (!Array.isArray(names)) {
      names = [names];
      values = [values];
    }
    const distances = [];
    for (let i = 0; i < names.length; i++) {
      if (!names[i]) continue;
      distances.push({ name: names[i], distance: Number(values[i]) });
    }
    await game.settings.set(MODULE_ID, "distanceConfig", distances);
    if (canvas.ready) RangeBands.redrawAll();
  }

  activateListeners(html) {
    super.activateListeners(html);
    const app = this;
    let dragged = null;

    function attachDragEvents(row) {
      row.attr("draggable", true);
      row.on("dragstart", (ev) => {
        dragged = ev.currentTarget;
        $(dragged).addClass("dragging");
      });
      row.on("dragend", () => {
        $(dragged).removeClass("dragging");
        dragged = null;
      });
      row.on("dragover", (ev) => ev.preventDefault());
      row.on("drop", (ev) => {
        ev.preventDefault();
        const target = ev.currentTarget;
        if (dragged && target !== dragged) {
          $(dragged).insertBefore(target);
          app.setPosition();
        }
      });
    }

    const rowHtml = (name, distance) => `
      <div class="distance-row" style="padding-left:20px; cursor: move; margin-bottom: 5px;" draggable="true">
        <input type="text" name="name" placeholder="Name" value="${name}" style="width:291px; margin-right:5px;">
        <input type="number" name="distance" placeholder="Distance" value="${distance}" style="width:146px; margin-right:5px;">
        <i class="fas fa-trash remove-row" style="cursor:pointer;"></i>
      </div>`;

    html.find(".distance-row").each((i, row) => attachDragEvents($(row)));

    html.find(".add-row").click(() => {
      const newRow = $(rowHtml("", ""));
      html.find(".distance-rows").append(newRow);
      attachDragEvents(newRow);
      app.setPosition();
    });

    html.find(".reset-ranges").click(() => {
      const $rows = html.find(".distance-rows");
      $rows.find(".distance-row:gt(0)").remove();
      for (const range of DEFAULT_RANGES) {
        const newRow = $(rowHtml(range.name, range.distance));
        $rows.append(newRow);
        attachDragEvents(newRow);
      }
      app.setPosition();
    });

    html.on("click", ".remove-row", (ev) => {
      $(ev.currentTarget).closest(".distance-row").remove();
      app.setPosition();
    });
  }
}
