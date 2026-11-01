/* A searchable presentation layer over the existing project <select> controls. */
const ProjectPicker = (() => {
  let active = null;
  let nextId = 0;
  const controllers = new WeakMap();
  const normalize = (text) => String(text).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
  const matches = (name, query) => normalize(query).trim().split(/\s+/).every((word) => normalize(name).includes(word));
  const chevron = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function close(restoreFocus = false) {
    if (!active) return;
    const previous = active;
    active = null;
    previous.menu.remove();
    previous.trigger.setAttribute('aria-expanded', 'false');
    previous.trigger.removeAttribute('aria-controls');
    if (restoreFocus) previous.trigger.focus({ preventScroll: true });
  }

  function position() {
    if (!active) return;
    if (!active.trigger.isConnected) { close(); return; }
    const { menu, trigger } = active;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const topEdge = viewport?.offsetTop || 0;
    const leftEdge = viewport?.offsetLeft || 0;
    const viewportWidth = viewport?.width || window.innerWidth;
    const bottomEdge = topEdge + (viewport?.height || window.innerHeight);
    const below = bottomEdge - rect.bottom - 20;
    const above = rect.top - topEdge - 20;
    const openBelow = below >= 280 || below >= above;
    const maxHeight = Math.max(120, Math.min(420, openBelow ? below : above));
    const width = Math.min(Math.max(rect.width, 340), viewportWidth - 24);
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.left = `${Math.max(leftEdge + 12, Math.min(rect.left, leftEdge + viewportWidth - width - 12))}px`;
    const height = menu.getBoundingClientRect().height;
    const top = openBelow ? rect.bottom + 8 : rect.top - height - 8;
    menu.style.top = `${Math.max(topEdge + 12, Math.min(top, bottomEdge - height - 12))}px`;
  }

  function enhance(select, label) {
    const base = select.id || `project-picker-${++nextId}`;
    select.id = base;
    const wrapper = document.createElement('div');
    wrapper.className = 'project-picker';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'project-picker-trigger';
    trigger.id = `${base}-trigger`;
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    const selected = select.selectedOptions[0];
    const text = document.createElement('span');
    text.className = 'project-picker-value';
    text.textContent = selected?.textContent || 'Choose a project';
    trigger.title = text.textContent;
    trigger.setAttribute('aria-label', `${label}: ${text.textContent}`);
    trigger.appendChild(text);
    trigger.insertAdjacentHTML('beforeend', chevron);
    select.hidden = true;
    wrapper.append(select, trigger);

    function open() {
      if (trigger.disabled || !trigger.isConnected) return;
      close();
      const menu = document.createElement('div');
      menu.className = 'project-picker-menu';
      menu.id = `${base}-menu`;
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-label', label);
      const heading = document.createElement('div');
      heading.className = 'project-picker-heading';
      heading.textContent = 'Choose a project';
      const searchWrap = document.createElement('div');
      searchWrap.className = 'project-picker-search';
      searchWrap.innerHTML = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      const search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Search projects…';
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.setAttribute('role', 'combobox');
      search.setAttribute('aria-label', 'Search projects by name');
      search.setAttribute('aria-autocomplete', 'list');
      search.setAttribute('aria-expanded', 'true');
      search.setAttribute('aria-controls', `${base}-list`);
      searchWrap.appendChild(search);
      const list = document.createElement('div');
      list.id = `${base}-list`;
      list.className = 'project-picker-list';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Matching projects');
      const empty = document.createElement('div');
      empty.className = 'project-picker-empty';
      empty.textContent = 'No matching projects. Try another name.';
      empty.hidden = true;
      const footer = document.createElement('div');
      footer.className = 'project-picker-footer';
      footer.setAttribute('role', 'status');
      menu.append(heading, searchWrap, list, empty, footer);
      document.body.appendChild(menu);
      active = { menu, trigger, wrapper };
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-controls', menu.id);
      let results = [], highlighted = -1;

      function highlight(index, scroll = true) {
        highlighted = index;
        [...list.children].forEach((option, i) => option.classList.toggle('is-highlighted', i === index));
        const option = list.children[index];
        if (option) {
          search.setAttribute('aria-activedescendant', option.id);
          if (scroll) option.scrollIntoView({ block: 'nearest' });
        } else search.removeAttribute('aria-activedescendant');
      }
      function choose(index) {
        const option = results[index];
        if (!option || option.disabled) return;
        const changed = select.value !== option.value;
        select.value = option.value;
        text.textContent = option.textContent;
        trigger.title = option.textContent;
        trigger.setAttribute('aria-label', `${label}: ${option.textContent}`);
        close();
        if (changed) select.dispatchEvent(new Event('change', { bubbles: true }));
        // Existing change handlers may rebuild the row (e.g. selecting Other).
        document.getElementById(trigger.id)?.focus({ preventScroll: true });
      }
      function render() {
        results = [...select.options].filter((option) => matches(option.textContent, search.value));
        results.sort((a, b) => Number(a.value === 'other') - Number(b.value === 'other'));
        list.replaceChildren();
        results.forEach((option, index) => {
          const item = document.createElement('div');
          item.className = `project-picker-option${option.value === 'other' ? ' is-other' : ''}`;
          item.id = `${base}-option-${index}`;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', String(option.value === select.value));
          item.setAttribute('aria-disabled', String(option.disabled));
          const name = document.createElement('span');
          name.className = 'project-picker-option-name';
          name.textContent = option.textContent;
          item.appendChild(name);
          if (option.value === 'other') {
            const description = document.createElement('small');
            description.textContent = 'Work outside a listed project';
            item.appendChild(description);
          }
          if (option.disabled) {
            const note = document.createElement('small');
            note.textContent = 'Already added to this day';
            item.appendChild(note);
          } else if (option.value === select.value) {
            const check = document.createElement('span');
            check.className = 'project-picker-check';
            check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
            item.appendChild(check);
          }
          item.addEventListener('pointerdown', (e) => e.preventDefault());
          item.addEventListener('click', () => choose(index));
          item.addEventListener('pointermove', () => { if (!option.disabled) highlight(index, false); });
          list.appendChild(item);
        });
        empty.hidden = results.length !== 0;
        list.hidden = results.length === 0;
        footer.textContent = `${results.length} ${results.length === 1 ? 'option' : 'options'} · ↑ ↓ to navigate · Enter to select`;
        const current = results.findIndex((option) => option.value === select.value && !option.disabled);
        highlight(current >= 0 ? current : results.findIndex((option) => !option.disabled), false);
        position();
      }
      search.addEventListener('input', render);
      search.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const enabled = results.map((option, i) => option.disabled ? -1 : i).filter((i) => i >= 0);
          const current = enabled.indexOf(highlighted);
          if (enabled.length) highlight(enabled[(current + (e.key === 'ArrowDown' ? 1 : enabled.length - 1) + enabled.length) % enabled.length]);
        } else if (e.key === 'Enter') {
          e.preventDefault(); choose(highlighted);
        } else if (e.key === 'Tab') {
          // Resume normal tab navigation from the original field, not the portal.
          close(true);
        }
      });
      render();
      search.focus({ preventScroll: true });
      highlight(highlighted);
    }
    function toggle() { if (active?.trigger === trigger) close(true); else open(); }
    controllers.set(trigger, { toggle });
    trigger.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      // Commit any hours field first; its blur handler can rebuild the day.
      trigger.focus({ preventScroll: true });
      controllers.get(document.getElementById(trigger.id))?.toggle();
    });
    trigger.addEventListener('click', (e) => { if (e.detail === 0) toggle(); });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    return wrapper;
  }

  document.addEventListener('pointerdown', (e) => {
    if (active && !active.menu.contains(e.target) && !active.wrapper.contains(e.target)) close();
  });
  document.addEventListener('focusin', (e) => {
    if (active && !active.menu.contains(e.target) && !active.wrapper.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) { e.preventDefault(); close(true); }
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', (e) => { if (active && !active.menu.contains(e.target)) position(); }, true);
  window.visualViewport?.addEventListener('resize', position);
  window.visualViewport?.addEventListener('scroll', position);
  return { enhance };
})();
