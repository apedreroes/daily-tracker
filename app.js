/*
 * Hábitos — lógica de la aplicación
 *
 *  1. Configuración y utilidades
 *  2. Fechas
 *  3. Estado y almacenamiento local (la app es "offline-first")
 *  4. Nube: Supabase (RPC + Realtime) y sincronización
 *  5. Espacios (multidispositivo sin login)
 *  6. Vista diaria
 *  7. Resumen semanal
 *  8. Resumen mensual
 *  9. Ajustes y gestión de hábitos
 * 10. Notificaciones
 * 11. Navegación e inicio
 */
(() => {
  'use strict';

  /* ======================================================================
     1. Configuración y utilidades
     ====================================================================== */

  const CFG = window.HABITOS_CONFIG || {};
  // Sin URL/clave (o sin la librería cargada) la app trabaja solo en local.
  const CLOUD = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);

  const VIEWS = ['dia', 'semana', 'mes', 'ajustes'];
  const VIEW_TITLES = { dia: 'Registro diario', semana: 'Resumen semanal', mes: 'Resumen mensual', ajustes: 'Ajustes' };
  const PALETTE_SIZE = 8;
  const DOW_SHORT = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const DOW_LONG = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

  const DEFAULT_HABITS = [
    { name: 'Consumo de azúcar', multi: false, options: ['0 azúcar', 'Mínimo', 'Normal'] },
    { name: 'Alimentación sin gluten', multi: false, options: ['0 gluten', 'Espelta', 'Gluten de trigo'] },
    { name: 'Ejercicio', multi: true, options: ['Fuerza', 'Carrera'] }
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Crea nodos del DOM sin innerHTML (los nombres de hábitos son texto del usuario).
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === false || value == null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child);
    }
    return node;
  }

  const uuid = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

  const shortId = () => uuid().slice(0, 8);

  let toastTimer;
  function toast(message) {
    const box = $('#toast');
    box.textContent = '';
    // Pequeño retardo para que los lectores de pantalla anuncien mensajes repetidos.
    setTimeout(() => { box.textContent = message; }, 30);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.textContent = ''; }, 4000);
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch (_) {
      toast('No se pudo copiar. Selecciona el texto y cópialo a mano.');
    }
  }

  /* ======================================================================
     2. Fechas (siempre en hora local y formato AAAA-MM-DD)
     ====================================================================== */

  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromISO = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => toISO(new Date());
  const addDays = (iso, n) => { const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
  const addMonths = (iso, n) => { const d = fromISO(iso); return toISO(new Date(d.getFullYear(), d.getMonth() + n, 1)); };
  const startOfWeek = (iso) => addDays(iso, -((fromISO(iso).getDay() + 6) % 7)); // lunes
  const isValidISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(fromISO(s)) === s;

  const fmtLong = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const fmtFull = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtShort = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
  const fmtMonth = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });

  function dayLabel(iso) {
    const t = today();
    const d = fromISO(iso);
    const text = d.getFullYear() === new Date().getFullYear() ? fmtLong.format(d) : fmtFull.format(d);
    if (iso === t) return `Hoy · ${text}`;
    if (iso === addDays(t, -1)) return `Ayer · ${text}`;
    return text;
  }

  /* ======================================================================
     3. Estado y almacenamiento local
     ====================================================================== */

  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`habitos.${key}`);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(`habitos.${key}`, JSON.stringify(value)); } catch (_) { /* almacenamiento lleno o bloqueado */ }
    }
  };

  /*
   * Modelo de datos
   *   habits:  [{ id, name, multi, options: [{ id, label }], position }]
   *   entries: { 'AAAA-MM-DD': { values: { habitId: [optionId, ...] }, updated_at } }
   *   pending: [{ t: 'habit' | 'habit-del' | 'entry', id, v }]  ← cambios aún no subidos
   */
  const state = {
    space: LS.get('space', null),
    habits: LS.get('habits', []),
    entries: LS.get('entries', {}),
    pending: LS.get('pending', []),
    prefs: { notif: false, hour: 8, mode: 'none', ...LS.get('prefs', {}) },

    view: 'dia',
    date: today(),       // día mostrado en la vista diaria
    weekRef: today(),    // cualquier día de la semana mostrada
    monthRef: today(),   // cualquier día del mes mostrado
    monthHabit: 'all',
    draft: {},           // selección en curso del día (aún sin guardar)
    dirty: false,
    sync: 'local'
  };

  function persist() {
    LS.set('habits', state.habits);
    LS.set('entries', state.entries);
    LS.set('pending', state.pending);
    updateSwContext();
  }

  const isDone = (iso) => Boolean(state.entries[iso]);

  // Anota un cambio pendiente de subir (uno por elemento: el último gana).
  function queue(t, id) {
    state.pending = state.pending.filter((op) => !(op.id === id && op.t.split('-')[0] === t.split('-')[0]));
    state.pending.push({ t, id, v: Date.now() });
  }

  function loadDraft() {
    const entry = state.entries[state.date];
    state.draft = entry ? JSON.parse(JSON.stringify(entry.values || {})) : {};
    state.dirty = false;
  }

  /* ======================================================================
     4. Nube: Supabase y sincronización
     ====================================================================== */

  let sb = null;
  let channel = null;

  if (CLOUD) {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false } // no hay usuarios ni sesiones
    });
  }

  async function rpc(fn, args) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw error;
    return data;
  }

  // Canal Realtime del espacio: cada dispositivo avisa a los demás cuando guarda algo.
  function subscribeChannel() {
    if (!sb || !state.space) return;
    if (channel) sb.removeChannel(channel);
    channel = sb
      .channel(`habitos:${state.space}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'changed' }, () => syncNow())
      .subscribe();
  }

  function announceChange() {
    if (channel) channel.send({ type: 'broadcast', event: 'changed', payload: {} }).catch(() => {});
  }

  const SYNC_TEXT = {
    local: 'Solo en este dispositivo',
    ok: 'Sincronizado',
    syncing: 'Sincronizando…',
    offline: 'Sin conexión',
    error: 'Error de sincronización'
  };

  function setSync(status) {
    state.sync = status;
    const node = $('#sync-status');
    const n = state.pending.length;
    const waiting = CLOUD && n && status !== 'syncing' ? ` · ${n} ${n === 1 ? 'cambio pendiente' : 'cambios pendientes'}` : '';
    node.dataset.state = status;
    node.textContent = SYNC_TEXT[status] + waiting;
  }

  // Sube los cambios pendientes. Devuelve true si ha enviado algo.
  async function flush() {
    let sent = false;
    for (const op of [...state.pending]) {
      if (op.t === 'habit') {
        const h = state.habits.find((x) => x.id === op.id);
        if (h) {
          await rpc('habitos_save_habit', {
            p_space: state.space, p_id: h.id, p_name: h.name, p_multi: h.multi,
            p_options: h.options, p_position: h.position
          });
        }
      } else if (op.t === 'habit-del') {
        await rpc('habitos_delete_habit', { p_space: state.space, p_id: op.id });
      } else if (op.t === 'entry') {
        const entry = state.entries[op.id];
        if (entry) await rpc('habitos_save_entry', { p_space: state.space, p_day: op.id, p_data: entry.values });
      }
      // Solo se da por enviado si no se ha vuelto a modificar mientras tanto.
      state.pending = state.pending.filter((x) => !(x.t === op.t && x.id === op.id && x.v === op.v));
      LS.set('pending', state.pending);
      sent = true;
    }
    return sent;
  }

  // Descarga el estado del espacio y lo combina con lo que aún no se ha subido.
  async function pull() {
    const data = await rpc('habitos_pull', { p_space: state.space });
    const pend = new Set(state.pending.map((op) => `${op.t}:${op.id}`));
    const before = JSON.stringify([state.habits, state.entries]);

    const habits = (data.habits || [])
      .filter((h) => !pend.has(`habit-del:${h.id}`))
      .map((h) => (pend.has(`habit:${h.id}`) && state.habits.find((x) => x.id === h.id)) || {
        id: h.id, name: h.name, multi: Boolean(h.multi), options: h.options || [], position: h.position || 0
      });
    for (const h of state.habits) {
      if (pend.has(`habit:${h.id}`) && !habits.some((x) => x.id === h.id)) habits.push(h);
    }
    habits.sort((a, b) => a.position - b.position);

    const entries = {};
    for (const row of data.entries || []) entries[row.day] = { values: row.data || {}, updated_at: row.updated_at };
    for (const op of state.pending) {
      if (op.t === 'entry' && state.entries[op.id]) entries[op.id] = state.entries[op.id];
    }

    state.habits = habits;
    state.entries = entries;
    persist();

    if (JSON.stringify([habits, entries]) !== before) {
      if (!state.dirty) loadDraft();
      render();
    }
  }

  let syncing = false;
  let syncAgain = false;

  async function syncNow() {
    if (!CLOUD || !state.space) return setSync('local');
    if (!navigator.onLine) return setSync('offline');
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    setSync('syncing');
    try {
      const sent = await flush();
      await pull();
      if (sent) announceChange();
      setSync('ok');
    } catch (err) {
      console.error('[Hábitos] Sincronización fallida:', err);
      setSync('error');
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  }

  /* ======================================================================
     5. Espacios: multidispositivo sin login
     Un "espacio" es un código aleatorio largo. Quien lo tiene, ve y edita los
     datos; por eso se comparte solo entre los dispositivos propios.
     ====================================================================== */

  const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const CODE_LENGTH = 24;

  function generateCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  }
  const normalizeCode = (raw) => String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const prettyCode = (code) => (code || '').replace(/(.{4})(?=.)/g, '$1-');

  function createSpace() {
    state.space = generateCode();
    LS.set('space', state.space);
    state.habits = DEFAULT_HABITS.map((h, i) => ({
      id: uuid(), name: h.name, multi: h.multi, position: i,
      options: h.options.map((label) => ({ id: shortId(), label }))
    }));
    state.entries = {};
    state.pending = [];
    state.habits.forEach((h) => queue('habit', h.id));
    persist();
    loadDraft();
    subscribeChannel();
    syncNow();
  }

  async function joinSpace(raw) {
    const code = normalizeCode(raw);
    if (code.length < 20) { toast('Ese código no parece válido. Revísalo e inténtalo de nuevo.'); return false; }
    if (code === state.space) { toast('Este dispositivo ya está en ese espacio.'); return false; }
    if (!CLOUD) { toast('La nube no está configurada en esta instalación.'); return false; }
    if (!navigator.onLine) { toast('Necesitas conexión para conectar con otro dispositivo.'); return false; }
    try {
      const data = await rpc('habitos_pull', { p_space: code });
      if (!(data.habits || []).length && !(data.entries || []).length) {
        toast('No hay datos con ese código. Comprueba que lo has copiado completo.');
        return false;
      }
      state.space = code;
      LS.set('space', code);
      state.habits = [];
      state.entries = {};
      state.pending = [];
      state.dirty = false;
      persist();
      subscribeChannel();
      await syncNow();
      loadDraft();
      render();
      if (state.prefs.notif) subscribePush();
      toast('Dispositivo conectado. Ya compartes los mismos datos.');
      return true;
    } catch (err) {
      console.error(err);
      toast('No se pudo conectar. Inténtalo de nuevo en un momento.');
      return false;
    }
  }

  /* ======================================================================
     6. Vista diaria
     ====================================================================== */

  function changeDate(iso) {
    if (!isValidISO(iso)) { renderDay(); return; }
    if (iso > today()) iso = today();
    if (iso === state.date) { renderDay(); return; }
    if (state.dirty && !confirm('Tienes cambios sin guardar en este día. ¿Descartarlos?')) { renderDay(); return; }
    state.date = iso;
    loadDraft();
    renderDay();
  }

  function renderDay() {
    const t = today();
    const yesterday = addDays(t, -1);
    $('#day-input').max = t;
    $('#day-input').value = state.date;
    $('#day-label').textContent = dayLabel(state.date);
    $('#day-next').disabled = state.date >= t;
    $('#day-today').hidden = state.date === t;

    // Aviso dentro de la app: ayer quedó sin registrar (solo si ya había registros anteriores).
    const hadHistory = Object.keys(state.entries).some((d) => d < yesterday);
    $('#yesterday-banner').hidden = !(hadHistory && !isDone(yesterday) && state.date !== yesterday);

    const list = $('#habit-list');
    list.replaceChildren();
    if (!state.habits.length) {
      list.append(el('p', { class: 'empty' }, 'Aún no hay hábitos. ', el('a', { href: '#ajustes', text: 'Crea el primero en Ajustes' }), '.'));
    }
    state.habits.forEach((h) => list.append(habitCard(h)));
    $('#day-save').hidden = !state.habits.length;
    updateSaveBar();
  }

  function habitCard(h) {
    const selected = state.draft[h.id] || [];
    const type = h.multi ? 'checkbox' : 'radio';
    const card = el('fieldset', { class: 'card habit' });

    const clear = el('button', {
      type: 'button', class: 'link-btn clear', hidden: h.multi || !selected.length,
      onclick: () => {
        $$('input', card).forEach((input) => { input.checked = false; });
        onPick();
        $('input', card).focus();
      }
    }, 'Quitar selección');

    function onPick() {
      const ids = $$('input:checked', card).map((input) => input.value);
      if (ids.length) state.draft[h.id] = ids; else delete state.draft[h.id];
      state.dirty = true;
      clear.hidden = h.multi || !ids.length;
      updateSaveBar();
    }

    card.append(
      el('legend', { text: h.name }),
      h.multi ? el('p', { class: 'hint', text: 'Puedes marcar varias opciones.' }) : '',
      el('div', { class: 'chips' }, h.options.map((o) => el('label', { class: 'chip' },
        el('input', { type, name: `h-${h.id}`, value: o.id, checked: selected.includes(o.id), onchange: onPick }),
        el('span', { text: o.label })
      ))),
      clear
    );
    return card;
  }

  function updateSaveBar() {
    const exists = isDone(state.date);
    const status = $('#day-status');
    $('#day-save').textContent = exists ? 'Actualizar día' : 'Guardar día';
    status.dataset.dirty = String(state.dirty);
    status.textContent = state.dirty ? 'Cambios sin guardar' : exists ? 'Día registrado' : 'Día sin registrar';
  }

  function saveDay(event) {
    event.preventDefault();
    // Se descartan valores de hábitos u opciones que ya no existen.
    const values = {};
    for (const h of state.habits) {
      const ids = (state.draft[h.id] || []).filter((id) => h.options.some((o) => o.id === id));
      if (ids.length) values[h.id] = ids;
    }
    if (!Object.keys(values).length) { toast('Marca al menos una opción antes de guardar.'); return; }

    const existed = isDone(state.date);
    state.entries[state.date] = { values, updated_at: new Date().toISOString() };
    queue('entry', state.date);
    persist();
    loadDraft();
    renderDay();
    toast(existed ? 'Día actualizado.' : 'Día guardado.');
    syncNow();
  }

  /* ======================================================================
     Utilidades comunes a los resúmenes
     ====================================================================== */

  const abbr = (label) => label.replace(/\s+/g, '').slice(0, 3);
  const colorClass = (index) => `c${index % PALETTE_SIZE}`;

  // Qué se marcó en un hábito un día concreto: [{ index, label }]
  function picks(h, iso) {
    const ids = (state.entries[iso] && state.entries[iso].values[h.id]) || [];
    return h.options
      .map((o, index) => ({ index, label: o.label, id: o.id }))
      .filter((o) => ids.includes(o.id));
  }

  // Celda de un día para un hábito (se usa en la semana y en el calendario).
  function dayCell(h, iso, { showNumber }) {
    const t = today();
    const d = fromISO(iso);
    const name = fmtLong.format(d);
    const number = showNumber && el('span', { class: 'n', text: String(d.getDate()) });
    if (iso > t) return el('span', { class: 'cell future', 'aria-label': `${name}: día futuro` }, number);

    let cls = 'cell';
    let text = '';
    let desc;
    if (!isDone(iso)) {
      cls += ' missing'; desc = 'sin registrar';
    } else if (!h) {
      cls += ' done'; text = '✓'; desc = 'registrado';
    } else {
      const sel = picks(h, iso);
      if (sel.length) {
        cls += ` ${colorClass(sel[0].index)}`;
        text = abbr(sel[0].label) + (sel.length > 1 ? `+${sel.length - 1}` : '');
        desc = sel.map((o) => o.label).join(' y ');
      } else {
        cls += ' blank'; text = '–'; desc = 'nada marcado';
      }
    }
    if (iso === t) cls += ' today';
    return el('a', { class: cls, href: `#dia=${iso}`, 'aria-label': `${name}: ${desc}. Abrir día` },
      number, el('span', { class: 'v', text }));
  }

  // Reparto por opción de un hábito en una lista de días.
  function breakdown(h, days) {
    const total = days.length || 1;
    return el('ul', { class: 'breakdown' }, h.options.map((o, index) => {
      const count = days.filter((iso) => picks(h, iso).some((p) => p.id === o.id)).length;
      return el('li', null,
        el('span', { class: 'name' }, el('span', { class: `swatch ${colorClass(index)}`, 'aria-hidden': 'true', text: abbr(o.label) }), o.label),
        el('span', { class: 'count', text: `${count} ${count === 1 ? 'día' : 'días'}` }),
        el('div', { class: 'bar', 'aria-hidden': 'true' }, el('span', { class: colorClass(index), style: `width:${(count / total) * 100}%` }))
      );
    }));
  }

  function progressCard(title, done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return el('section', { class: 'card' },
      el('h3', { text: title }),
      el('p', { class: 'stat' }, el('strong', { text: `${done} de ${total}` }), `días registrados (${pct} %)`),
      el('div', { class: 'bar', 'aria-hidden': 'true' }, el('span', { style: `width:${pct}%` }))
    );
  }

  /* ======================================================================
     7. Resumen semanal
     ====================================================================== */

  function renderWeek() {
    const t = today();
    const start = startOfWeek(state.weekRef);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const elapsed = days.filter((d) => d <= t);
    const isCurrent = days.includes(t);

    $('#week-label').textContent = `${isCurrent ? 'Esta semana · ' : ''}${fmtShort.format(fromISO(days[0]))} – ${fmtShort.format(fromISO(days[6]))}`;
    $('#week-next').disabled = isCurrent;

    const body = $('#week-body');
    body.replaceChildren(progressCard('Cumplimiento del registro', elapsed.filter(isDone).length, elapsed.length));

    for (const h of state.habits) {
      const withValue = elapsed.filter((d) => picks(h, d).length).length;
      body.append(el('section', { class: 'card' },
        el('h3', { text: h.name }),
        el('p', { class: 'hint', text: `Con dato ${withValue} de ${elapsed.length} ${elapsed.length === 1 ? 'día' : 'días'}` }),
        el('ol', { class: 'week-strip' }, days.map((iso, i) => el('li', null,
          el('span', { class: 'dow', 'aria-hidden': 'true', text: DOW_SHORT[i] }),
          dayCell(h, iso, { showNumber: true })
        ))),
        breakdown(h, elapsed)
      ));
    }
    if (!state.habits.length) body.append(el('p', { class: 'empty', text: 'No hay hábitos que resumir todavía.' }));
  }

  /* ======================================================================
     8. Resumen mensual (calendario)
     ====================================================================== */

  function renderMonth() {
    const t = today();
    const ref = fromISO(state.monthRef);
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const count = new Date(year, month + 1, 0).getDate();
    const offset = (new Date(year, month, 1).getDay() + 6) % 7;
    const days = Array.from({ length: count }, (_, i) => toISO(new Date(year, month, i + 1)));
    const elapsed = days.filter((d) => d <= t);
    const isCurrent = days.includes(t);

    $('#month-label').textContent = fmtMonth.format(ref);
    $('#month-next').disabled = isCurrent;

    // Selector: registro general o un hábito concreto
    const select = $('#month-habit');
    if (state.monthHabit !== 'all' && !state.habits.some((h) => h.id === state.monthHabit)) state.monthHabit = 'all';
    select.replaceChildren(
      el('option', { value: 'all', text: 'Días registrados' }),
      ...state.habits.map((h) => el('option', { value: h.id, text: h.name }))
    );
    select.value = state.monthHabit;
    const habit = state.habits.find((h) => h.id === state.monthHabit) || null;

    // Calendario como tabla: 7 columnas, lunes primero
    const cells = [...Array(offset).fill(null), ...days];
    while (cells.length % 7) cells.push(null);
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) {
      rows.push(el('tr', null, cells.slice(i, i + 7).map((iso) =>
        el('td', null, iso && dayCell(habit, iso, { showNumber: true })))));
    }
    const table = el('table', { class: 'calendar' },
      el('caption', { class: 'sr-only', text: `${habit ? habit.name : 'Días registrados'}, ${fmtMonth.format(ref)}` }),
      el('thead', null, el('tr', null, DOW_SHORT.map((d, i) =>
        el('th', { scope: 'col', abbr: DOW_LONG[i] }, el('span', { 'aria-hidden': 'true', text: d }), el('span', { class: 'sr-only', text: DOW_LONG[i] }))))),
      el('tbody', null, rows)
    );

    const body = $('#month-body');
    body.replaceChildren(
      el('section', { class: 'card' }, table),
      progressCard('Registro del mes', elapsed.filter(isDone).length, elapsed.length)
    );
    if (habit) {
      body.append(el('section', { class: 'card' }, el('h3', { text: `Tendencia: ${habit.name}` }), breakdown(habit, elapsed)));
    } else {
      state.habits.forEach((h) => body.append(el('section', { class: 'card' }, el('h3', { text: h.name }), breakdown(h, elapsed))));
    }
  }

  /* ======================================================================
     9. Ajustes y gestión dinámica de hábitos
     ====================================================================== */

  function renderSettings() {
    // Lista de hábitos
    const list = $('#settings-habits');
    list.replaceChildren(...state.habits.map((h) => el('li', null,
      el('div', { class: 'info' },
        el('strong', { text: h.name }),
        el('span', { text: h.options.map((o) => o.label).join(' · ') + (h.multi ? ' (varias a la vez)' : '') })),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn small', 'aria-label': `Editar ${h.name}`, onclick: () => openHabitDialog(h) }, 'Editar'),
        el('button', { type: 'button', class: 'btn small danger', 'aria-label': `Eliminar ${h.name}`, onclick: () => deleteHabit(h) }, 'Eliminar'))
    )));
    if (!state.habits.length) list.append(el('li', null, el('span', { class: 'hint', text: 'No tienes hábitos todavía.' })));

    // Sincronización
    $('#sync-panel').hidden = !CLOUD;
    $('#sync-help').textContent = CLOUD
      ? 'No hay usuario ni contraseña: los dispositivos que comparten este código ven y editan los mismos datos. Trátalo como una contraseña.'
      : 'La nube no está configurada: los datos se guardan solo en este dispositivo. Rellena config.js con tu proyecto de Supabase para sincronizar.';
    $('#space-code').value = prettyCode(state.space);

    renderNotifications();
  }

  /* ----- Diálogo de hábito ----- */

  let editingId = null;

  function optionRow(option) {
    const input = el('input', { type: 'text', maxlength: '40', autocomplete: 'off', value: option ? option.label : '', placeholder: 'Nombre de la opción' });
    if (option) input.dataset.id = option.id;
    const row = el('li', null, input,
      el('button', {
        type: 'button', class: 'btn small',
        onclick: () => {
          if ($$('#option-rows li').length <= 1) { input.value = ''; input.focus(); return; }
          row.remove();
          labelOptionRows();
          $('#option-add').focus();
        }
      }, 'Quitar'));
    return row;
  }

  // Nombres accesibles numerados para cada fila de opción.
  function labelOptionRows() {
    $$('#option-rows li').forEach((row, i) => {
      $('input', row).setAttribute('aria-label', `Opción ${i + 1}`);
      $('button', row).setAttribute('aria-label', `Quitar opción ${i + 1}`);
    });
  }

  function openHabitDialog(habit) {
    editingId = habit ? habit.id : null;
    $('#habit-dialog-title').textContent = habit ? 'Editar hábito' : 'Nuevo hábito';
    $('#habit-name').value = habit ? habit.name : '';
    $('#habit-multi').checked = habit ? habit.multi : false;
    $('#habit-error').textContent = '';
    const rows = habit ? habit.options.map(optionRow) : [optionRow(), optionRow()];
    $('#option-rows').replaceChildren(...rows);
    labelOptionRows();
    $('#habit-dialog').showModal();
    $('#habit-name').focus();
  }

  function submitHabit(event) {
    event.preventDefault();
    const name = $('#habit-name').value.trim();
    const options = $$('#option-rows input')
      .map((input) => ({ id: input.dataset.id || shortId(), label: input.value.trim() }))
      .filter((o) => o.label);
    const labels = options.map((o) => o.label.toLowerCase());

    let error = '';
    if (!name) error = 'Escribe un nombre para el hábito.';
    else if (!options.length) error = 'Añade al menos una opción.';
    else if (new Set(labels).size !== labels.length) error = 'Hay opciones repetidas.';
    if (error) {
      $('#habit-error').textContent = error;
      (name ? $('#option-rows input') : $('#habit-name')).focus();
      return;
    }

    const multi = $('#habit-multi').checked;
    let habit = state.habits.find((h) => h.id === editingId);
    if (habit) {
      Object.assign(habit, { name, multi, options });
    } else {
      const position = state.habits.reduce((max, h) => Math.max(max, h.position), -1) + 1;
      habit = { id: uuid(), name, multi, options, position };
      state.habits.push(habit);
    }
    queue('habit', habit.id);
    persist();
    $('#habit-dialog').close();
    if (!state.dirty) loadDraft();
    render();
    toast(editingId ? 'Hábito actualizado.' : 'Hábito creado.');
    syncNow();
  }

  function deleteHabit(habit) {
    if (!confirm(`¿Eliminar «${habit.name}»? Dejará de aparecer en el registro y en los resúmenes.`)) return;
    state.habits = state.habits.filter((h) => h.id !== habit.id);
    delete state.draft[habit.id];
    queue('habit-del', habit.id);
    persist();
    render();
    $('#habit-new').focus();
    toast('Hábito eliminado.');
    syncNow();
  }

  /* ======================================================================
     10. Notificaciones
     Tres vías, de más a menos fiable:
       a) Push del servidor (Edge Function + cron): llega aunque la app esté cerrada.
       b) Periodic Background Sync: el navegador despierta al service worker.
       c) Aviso dentro de la app al abrirla (banner de la vista diaria).
     ====================================================================== */

  const NOTIF_SUPPORTED = 'Notification' in window && 'serviceWorker' in navigator;

  // El service worker no puede leer localStorage: se le deja el contexto en IndexedDB.
  function updateSwContext() {
    if (!self.KV) return;
    const t = today();
    const recent = Array.from({ length: 10 }, (_, i) => addDays(t, -i)).filter(isDone);
    KV.set('ctx', {
      url: CLOUD ? CFG.SUPABASE_URL : null,
      key: CLOUD ? CFG.SUPABASE_ANON_KEY : null,
      space: state.space,
      hour: state.prefs.hour,
      enabled: state.prefs.notif,
      recent
    }).catch(() => {});
  }

  function savePrefs() {
    LS.set('prefs', state.prefs);
    updateSwContext();
  }

  function vapidKeyToBytes(base64) {
    const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  // (a) Suscripción push: se guarda en Supabase junto a la hora y la zona horaria.
  async function subscribePush() {
    if (!CLOUD || !CFG.VAPID_PUBLIC_KEY || !navigator.onLine) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!reg.pushManager) return false;
      const sub = (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyToBytes(CFG.VAPID_PUBLIC_KEY) }));
      const json = sub.toJSON();
      await rpc('habitos_save_push', {
        p_space: state.space,
        p_endpoint: json.endpoint,
        p_p256dh: json.keys.p256dh,
        p_auth: json.keys.auth,
        p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid',
        p_hour: state.prefs.hour
      });
      return true;
    } catch (err) {
      console.error('[Hábitos] No se pudo activar el push:', err);
      return false;
    }
  }

  async function unsubscribePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = reg.pushManager && (await reg.pushManager.getSubscription());
      if (!sub) return;
      if (CLOUD) await rpc('habitos_delete_push', { p_endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    } catch (_) { /* nada que deshacer */ }
  }

  // (b) Comprobación periódica en segundo plano (Chrome/Edge con la PWA instalada).
  async function registerPeriodicSync() {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!('periodicSync' in reg)) return false;
      const permission = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (permission.state !== 'granted') return false;
      await reg.periodicSync.register('morning-check', { minInterval: 6 * 60 * 60 * 1000 });
      return true;
    } catch (_) { return false; }
  }

  async function enableNotifications() {
    if (!NOTIF_SUPPORTED) { toast('Este navegador no admite notificaciones.'); return; }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Permiso denegado. Puedes cambiarlo en los ajustes del navegador.');
      renderNotifications();
      return;
    }
    state.prefs.notif = true;
    const [push, periodic] = await Promise.all([subscribePush(), registerPeriodicSync()]);
    state.prefs.mode = push ? 'push' : periodic ? 'periodic' : 'none';
    savePrefs();
    renderNotifications();
    toast('Recordatorio matutino activado.');
  }

  async function disableNotifications() {
    state.prefs.notif = false;
    state.prefs.mode = 'none';
    savePrefs();
    await unsubscribePush();
    try {
      const reg = await navigator.serviceWorker.ready;
      if ('periodicSync' in reg) await reg.periodicSync.unregister('morning-check');
    } catch (_) { /* no estaba registrado */ }
    renderNotifications();
    toast('Recordatorio desactivado.');
  }

  async function testNotification() {
    if (!NOTIF_SUPPORTED) { toast('Este navegador no admite notificaciones.'); return; }
    if (Notification.permission !== 'granted') { toast('Activa primero el recordatorio para dar permiso.'); return; }
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('Hábitos: ayer quedó sin registrar', {
      body: 'Así verás el recordatorio matutino. Toca para abrir el registro de ayer.',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: 'prueba',
      data: { day: addDays(today(), -1) }
    });
  }

  function renderNotifications() {
    const select = $('#notif-hour');
    if (!select.options.length) {
      for (let h = 5; h <= 12; h += 1) select.append(el('option', { value: String(h), text: `${h}:00` }));
    }
    select.value = String(state.prefs.hour);

    const active = state.prefs.notif && NOTIF_SUPPORTED && Notification.permission === 'granted';
    const toggle = $('#notif-toggle');
    toggle.textContent = active ? 'Desactivar recordatorio' : 'Activar recordatorio';
    toggle.classList.toggle('primary', !active);
    $('#notif-test').hidden = !active;

    let status;
    if (!NOTIF_SUPPORTED) {
      status = 'Este navegador no admite notificaciones. En iPhone y iPad, instala antes la app en la pantalla de inicio.';
    } else if (Notification.permission === 'denied') {
      status = 'Las notificaciones están bloqueadas para esta app. Permítelas en los ajustes del navegador.';
    } else if (!active) {
      status = 'Recordatorio desactivado.';
    } else if (state.prefs.mode === 'push') {
      status = `Activo: recibirás un aviso sobre las ${state.prefs.hour}:00 aunque la app esté cerrada.`;
    } else if (state.prefs.mode === 'periodic') {
      status = `Activo mediante comprobación en segundo plano del navegador: la hora del aviso es aproximada (a partir de las ${state.prefs.hour}:00).`;
    } else {
      status = 'Permiso concedido, pero este dispositivo solo puede avisarte al abrir la app. Para avisos con la app cerrada configura el push del servidor (ver README).';
    }
    $('#notif-status').textContent = status;
  }

  /* ======================================================================
     11. Navegación, eventos e inicio
     ====================================================================== */

  function render() {
    VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== state.view; });
    $$('.tabs a').forEach((a) => {
      if (a.dataset.view === state.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${VIEW_TITLES[state.view]} · Hábitos`;
    if (state.view === 'dia') renderDay();
    else if (state.view === 'semana') renderWeek();
    else if (state.view === 'mes') renderMonth();
    else renderSettings();
  }

  // Rutas: #dia, #semana, #mes, #ajustes, #dia=AAAA-MM-DD y #join=CÓDIGO
  function route({ focus } = {}) {
    const hash = location.hash.slice(1);
    const [name, value] = hash.split('=');

    if (name === 'join' && value) {
      history.replaceState(null, '', '#ajustes');
      state.view = 'ajustes';
      render();
      if (!state.space) return; // lo gestiona el diálogo de bienvenida
      if (confirm('¿Conectar este dispositivo con el espacio del enlace? Los datos locales se sustituirán por los de ese espacio.')) joinSpace(value);
      return;
    }

    const view = VIEWS.includes(name) ? name : 'dia';
    if (view !== 'dia' && state.view === 'dia' && state.dirty) {
      toast('Tienes cambios sin guardar en el registro diario.');
    }
    state.view = view;
    if (name === 'dia' && value) {
      history.replaceState(null, '', '#dia');
      changeDate(value);
    }
    render();
    if (focus) {
      window.scrollTo(0, 0);
      $(`#t-${view}`).focus({ preventScroll: true });
    }
  }

  function bindEvents() {
    window.addEventListener('hashchange', () => route({ focus: true }));

    // Vista diaria
    $('#day-prev').addEventListener('click', () => changeDate(addDays(state.date, -1)));
    $('#day-next').addEventListener('click', () => changeDate(addDays(state.date, 1)));
    $('#day-today').addEventListener('click', () => changeDate(today()));
    $('#day-input').addEventListener('change', (e) => changeDate(e.target.value));
    $('#yesterday-go').addEventListener('click', () => changeDate(addDays(today(), -1)));
    $('#day-form').addEventListener('submit', saveDay);

    // Semana y mes
    $('#week-prev').addEventListener('click', () => { state.weekRef = addDays(state.weekRef, -7); renderWeek(); });
    $('#week-next').addEventListener('click', () => { state.weekRef = addDays(state.weekRef, 7); renderWeek(); });
    $('#month-prev').addEventListener('click', () => { state.monthRef = addMonths(state.monthRef, -1); renderMonth(); });
    $('#month-next').addEventListener('click', () => { state.monthRef = addMonths(state.monthRef, 1); renderMonth(); });
    $('#month-habit').addEventListener('change', (e) => { state.monthHabit = e.target.value; renderMonth(); });

    // Hábitos
    $('#habit-new').addEventListener('click', () => openHabitDialog(null));
    $('#habit-form').addEventListener('submit', submitHabit);
    $('#habit-form').addEventListener('input', () => { $('#habit-error').textContent = ''; });
    $('#habit-cancel').addEventListener('click', () => $('#habit-dialog').close());
    $('#option-add').addEventListener('click', () => {
      const row = optionRow();
      $('#option-rows').append(row);
      labelOptionRows();
      $('input', row).focus();
    });

    // Sincronización
    $('#space-copy').addEventListener('click', () => copyText(state.space, 'Código copiado.'));
    $('#space-link').addEventListener('click', () =>
      copyText(`${location.origin}${location.pathname}#join=${state.space}`, 'Enlace copiado. Ábrelo en el otro dispositivo.'));
    $('#sync-now').addEventListener('click', async () => { await syncNow(); toast(SYNC_TEXT[state.sync]); });
    $('#join-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#join-code').value;
      if (!normalizeCode(code)) { $('#join-code').focus(); return; }
      if (!confirm('Los datos de este dispositivo se sustituirán por los del otro espacio. ¿Continuar?')) return;
      if (await joinSpace(code)) $('#join-code').value = '';
    });

    // Notificaciones
    $('#notif-toggle').addEventListener('click', () => {
      const active = state.prefs.notif && NOTIF_SUPPORTED && Notification.permission === 'granted';
      if (active) disableNotifications(); else enableNotifications();
    });
    $('#notif-test').addEventListener('click', testNotification);
    $('#notif-hour').addEventListener('change', async (e) => {
      state.prefs.hour = Number(e.target.value);
      savePrefs();
      if (state.prefs.notif && state.prefs.mode === 'push') await subscribePush();
      renderNotifications();
    });

    // Bienvenida (primera vez con la nube configurada)
    const welcome = $('#welcome-dialog');
    welcome.addEventListener('cancel', (e) => e.preventDefault()); // hay que elegir una opción
    $('#welcome-new').addEventListener('click', () => { createSpace(); welcome.close(); render(); });
    $('#welcome-join').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (await joinSpace($('#welcome-code').value)) welcome.close();
    });

    // Instalación de la PWA
    let installEvent = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      $('#install-card').hidden = false;
    });
    $('#install-btn').addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      await installEvent.userChoice;
      installEvent = null;
      $('#install-card').hidden = true;
    });
    window.addEventListener('appinstalled', () => { $('#install-card').hidden = true; });

    // Resincronizar al recuperar la conexión o volver a la app
    window.addEventListener('online', syncNow);
    window.addEventListener('offline', () => setSync(CLOUD ? 'offline' : 'local'));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      syncNow();
      if (state.view === 'dia' && !state.dirty) renderDay(); // por si ha cambiado el día con la app abierta
    });
    window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });

    // El service worker pide abrir un día al tocar una notificación
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'open-day') location.hash = e.data.day ? `dia=${e.data.day}` : 'dia';
      });
    }
  }

  function init() {
    bindEvents();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js')
        .catch((err) => console.error('[Hábitos] No se pudo registrar el service worker:', err));
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    const joinMatch = location.hash.match(/^#join=(.+)$/);

    if (!state.space) {
      if (CLOUD) {
        // Primera vez: empezar de cero o conectar con un espacio existente.
        if (joinMatch) $('#welcome-code').value = joinMatch[1];
        $('#welcome-dialog').showModal();
      } else {
        createSpace();
      }
    } else {
      subscribeChannel();
    }

    loadDraft();
    updateSwContext();
    route();
    syncNow();
  }

  init();
})();
