/* Portable browser API. Dream Skin and Codex are optional adapters. */
(function exposeShelf(root) {
  const scriptBase = root.document?.currentScript?.src;
  const defaultBase = scriptBase ? new URL('../', scriptBase).href : root.location?.href;
  let manifestPromise;

  function selectCharacters(data, ids) {
    if (ids === undefined) return data.characters;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('Choose at least one unique character.');
    return ids.map((id) => {
      const character = data.characters.find((item) => item.id === id);
      if (!character) throw new Error(`Unknown character: ${id}`);
      return character;
    });
  }

  async function loadData(baseUrl = defaultBase) {
    if (root.CompanionShelfData) return root.CompanionShelfData;
    if (!manifestPromise) manifestPromise = (async () => {
      const base = new URL(baseUrl, root.location.href);
      const response = await root.fetch(new URL('assets/companions.json', base));
      if (!response.ok) throw new Error('Unable to load the character manifest.');
      const manifest = await response.json();
      const characters = structuredClone(manifest.characters || manifest);
      for (const character of characters) {
        if (character.animations) for (const stage of Object.values(character.animations)) stage.src = new URL(stage.src, base).href;
        else character.src = new URL(character.src, base).href;
      }
      return { characters, images: {}, theme: { image: new URL('themes/white-dragon-lavender/wallpaper.png', base).href } };
    })().catch((error) => { manifestPromise = null; throw error; });
    return manifestPromise;
  }

  function setWallpaper(source, target = root.document.body) {
    if (!target?.style) throw new Error('A wallpaper target element is required.');
    const properties = ['background-image', 'background-size', 'background-position', 'background-repeat', 'background-attachment', 'background-color'];
    const saved = properties.map((property) => [property, target.style.getPropertyValue(property), target.style.getPropertyPriority(property)]);
    target.style.setProperty('background-image', source ? `url(${JSON.stringify(source)})` : 'none');
    target.style.setProperty('background-size', 'auto 100%');
    target.style.setProperty('background-position', 'right center');
    target.style.setProperty('background-repeat', 'no-repeat');
    target.style.setProperty('background-attachment', 'fixed');
    target.style.setProperty('background-color', '#fbfaff');
    const applied = properties.map((property) => target.style.getPropertyValue(property));
    return () => properties.forEach((property, index) => {
      if (target.style.getPropertyValue(property) !== applied[index]) return;
      const [, value, priority] = saved[index];
      if (value) target.style.setProperty(property, value, priority);
      else target.style.removeProperty(property);
    });
  }

  async function mount(options = {}) {
    const data = options.data || await loadData(options.baseUrl);
    const characters = selectCharacters(data, options.characters);
    const target = typeof options.target === 'string' ? () => root.document.querySelector(options.target) :
      options.target ? () => options.target : options.getTarget;
    const config = { characters, images: data.images || {}, characterWidth: 56, gap: -8,
      rightInset: 8, overlap: 3, reserveComposerSpace: false, ...options.layout };
    if (target) config.getComposer = target;
    else if (options.composerSelector) config.composerSelector = options.composerSelector;
    const instance = root.CodexCompanions.install(config);
    let restoreWallpaper;
    if (options.wallpaper) restoreWallpaper = setWallpaper(options.wallpaper === true ? data.theme?.image : options.wallpaper);
    const destroy = instance.destroy;
    instance.destroy = () => { restoreWallpaper?.(); destroy(); };
    return instance;
  }

  root.CompanionShelf = { mount, loadData, setWallpaper, selectCharacters };
})(globalThis);
