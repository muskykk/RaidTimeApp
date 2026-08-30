(function () {
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  var DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
  var DEFAULT_COLOR = 'gray';

  var today = new Date();
  var viewDate = new Date(today.getFullYear(), today.getMonth(), 1);

  var DEFAULT_SETTINGS = { timeFormat: '24h', dateFormat: 'MM/DD/YYYY', startWithWindows: true };

  /** @type {{ events: any[], bundles: any[], settings: any }} */
  var state = { events: [], bundles: [], settings: Object.assign({}, DEFAULT_SETTINGS) };

  // ---------- helpers ----------

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function keyFor(date) { return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()); }
  function addDays(date, n) { var d = new Date(date); d.setDate(d.getDate() + n); return d; }
  function uid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }
  function formatDateHuman(k) {
    var parts = k.split('-').map(Number);
    var y = parts[0], mo = pad(parts[1]), d = pad(parts[2]);
    switch (state.settings.dateFormat) {
      case 'DD/MM/YYYY': return d + '/' + mo + '/' + y;
      case 'YYYY/MM/DD': return y + '/' + mo + '/' + d;
      default: return mo + '/' + d + '/' + y; // MM/DD/YYYY
    }
  }

  // Reformats a canonical 24h "HH:MM" string for the user's time-format
  // setting. Used both for read-only display text (pills, summaries,
  // notifications) and as the displayed value of the custom time-field
  // input (see createTimeField) — that field's own .value is never
  // canonical, only what this produces / what parseLocalizedTime accepts.
  function formatTimeDisplay(hhmm) {
    if (state.settings.timeFormat !== '12h') return hhmm;
    var parts = hhmm.split(':').map(Number);
    var period = parts[0] >= 12 ? 'PM' : 'AM';
    var h12 = parts[0] % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ':' + pad(parts[1]) + ' ' + period;
  }

  var DATE_FIELD_ORDER = {
    'MM/DD/YYYY': ['M', 'D', 'Y'],
    'DD/MM/YYYY': ['D', 'M', 'Y'],
    'YYYY/MM/DD': ['Y', 'M', 'D'],
  };

  // Strict inverse of formatDateHuman: a displayed date string -> canonical
  // 'YYYY-MM-DD', or null if it doesn't parse or isn't a real calendar date.
  // Rejects overflow (e.g. "02/30/2026") via a Date round-trip instead of
  // letting native Date silently roll it into March.
  function parseLocalizedDate(text, fmt) {
    text = String(text || '').trim();
    var parts = text.split('/');
    if (parts.length !== 3) return null;
    if (!parts.every(function (p) { return /^\d+$/.test(p); })) return null;

    var order = DATE_FIELD_ORDER[fmt] || DATE_FIELD_ORDER['MM/DD/YYYY'];
    var y, mo, d;
    order.forEach(function (token, i) {
      var n = Number(parts[i]);
      if (token === 'Y') y = n;
      else if (token === 'M') mo = n;
      else d = n;
    });
    if (String(y).length !== 4) return null;

    var date = new Date(y, mo - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return y + '-' + pad(mo) + '-' + pad(d);
  }

  // Strict inverse of formatTimeDisplay: a displayed time string -> canonical
  // 24h 'HH:MM', or null if it doesn't parse / is out of range.
  function parseLocalizedTime(text, fmt) {
    text = String(text || '').trim();
    if (fmt === '12h') {
      var m12 = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(text);
      if (!m12) return null;
      var h12 = Number(m12[1]), min12 = Number(m12[2]);
      if (h12 < 1 || h12 > 12 || min12 > 59) return null;
      var period = m12[3].toUpperCase();
      var h24 = h12 % 12;
      if (period === 'PM') h24 += 12;
      return pad(h24) + ':' + pad(min12);
    }
    var m24 = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!m24) return null;
    var h = Number(m24[1]), min = Number(m24[2]);
    if (h > 23 || min > 59) return null;
    return pad(h) + ':' + pad(min);
  }

  // Live input mask for a date field: strips everything but digits, caps at
  // the format's total digit count (2+2+4), and auto-inserts '/' as soon as
  // the next segment starts. So typing "12121232" straight through becomes
  // "12/12/1232" as you go, instead of growing as a flat, unbounded digit
  // string — a 9th digit is simply dropped, not appended. This only
  // constrains *shape*; parseLocalizedDate still does real semantic
  // validation (calendar-date correctness) on commit.
  function maskDateInputValue(rawValue, fmt) {
    var order = DATE_FIELD_ORDER[fmt] || DATE_FIELD_ORDER['MM/DD/YYYY'];
    var lengths = { M: 2, D: 2, Y: 4 };
    var totalDigits = lengths[order[0]] + lengths[order[1]] + lengths[order[2]];
    var digits = rawValue.replace(/\D/g, '').slice(0, totalDigits);

    var segs = [];
    var idx = 0;
    order.forEach(function (token) {
      var len = lengths[token];
      var seg = digits.slice(idx, idx + len);
      idx += len;
      if (seg) segs.push(seg);
    });
    return segs.join('/');
  }

  // Live input mask for a time field: caps at 4 digits (HHMM), auto-inserts
  // ':' once minute digits start, and (12h only) appends a normalized AM/PM
  // suffix built from whichever a/p/m letters were typed — so "20:00123"
  // can't happen, the 5th+ digit is simply dropped rather than appended.
  function maskTimeInputValue(rawValue, fmt) {
    var digits = rawValue.replace(/\D/g, '').slice(0, 4);
    var out = digits.length > 2 ? digits.slice(0, 2) + ':' + digits.slice(2) : digits;

    if (fmt === '12h') {
      var letters = rawValue.replace(/[^apmAPM]/g, '').toUpperCase().slice(0, 2);
      if (letters && letters[0] !== 'A' && letters[0] !== 'P') letters = '';
      if (letters.length === 2 && letters[1] !== 'M') letters = letters[0];
      if (letters) out += (out ? ' ' : '') + letters;
    }
    return out;
  }

  function getBundle(id) {
    if (!id) return null;
    for (var i = 0; i < state.bundles.length; i++) {
      if (state.bundles[i].id === id) return state.bundles[i];
    }
    return null;
  }

  function eventsForBundle(bundleId) {
    return state.events.filter(function (e) { return e.bundleId === bundleId; });
  }

  function effectiveTitle(ev) {
    if (ev.title != null) return ev.title;
    var b = getBundle(ev.bundleId);
    return b ? b.title : '';
  }
  function effectiveDescription(ev) {
    if (ev.description != null) return ev.description;
    var b = getBundle(ev.bundleId);
    return b ? b.description : '';
  }
  // Color is never overridable per-event: a bundled event always uses its
  // bundle's color, and only a standalone event carries its own.
  function effectiveColor(ev) {
    if (ev.bundleId) {
      var b = getBundle(ev.bundleId);
      return (b && b.color) || DEFAULT_COLOR;
    }
    return ev.color || DEFAULT_COLOR;
  }
  function isOverridden(ev) { return ev.title != null; }

  function renderColorSwatches(container, selected, onSelect) {
    container.innerHTML = '';
    COLORS.forEach(function (c) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch color-' + c + (c === selected ? ' selected' : '');
      btn.title = c.charAt(0).toUpperCase() + c.slice(1);
      btn.addEventListener('click', function () { onSelect(c); });
      container.appendChild(btn);
    });
  }

  // Shifts a "HH:MM" time of day by a whole-hour offset, wrapping within
  // the same calendar day. Used for the bundle-level DST/timezone correction.
  function applyHourOffset(timeStr, offsetHours) {
    if (!offsetHours) return timeStr;
    var parts = timeStr.split(':').map(Number);
    var total = (((parts[0] * 60 + parts[1] + offsetHours * 60) % 1440) + 1440) % 1440;
    return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
  }

  function bundleOffset(ev) {
    var b = getBundle(ev.bundleId);
    return b ? (b.hourOffset || 0) : 0;
  }

  function effectiveStartTime(ev) { return applyHourOffset(ev.startTime, bundleOffset(ev)); }
  function effectiveEndTime(ev) { return applyHourOffset(ev.endTime, bundleOffset(ev)); }

  function scheduleSummary(ev) {
    var start = formatTimeDisplay(effectiveStartTime(ev));
    var end = formatTimeDisplay(effectiveEndTime(ev));
    if (ev.kind === 'punctual') {
      return formatDateHuman(ev.date) + ' · ' + start + '–' + end;
    }
    var days = ev.recurrence.daysOfWeek.slice().sort().map(function (d) { return DAY_NAMES[d]; }).join(', ');
    var range = 'from ' + formatDateHuman(ev.recurrence.startDate);
    if (ev.recurrence.endDate) range += ' to ' + formatDateHuman(ev.recurrence.endDate);
    return 'Every ' + days + ' · ' + start + '–' + end + ' (' + range + ')';
  }

  function getEventsForDate(dateObj) {
    var k = keyFor(dateObj);
    var dow = dateObj.getDay();
    return state.events.filter(function (ev) {
      if (ev.active === false) return false;
      if (ev.kind === 'punctual') return ev.date === k;
      if (!ev.recurrence.daysOfWeek.includes(dow)) return false;
      if (k < ev.recurrence.startDate) return false;
      if (ev.recurrence.endDate && k > ev.recurrence.endDate) return false;
      return true;
    }).sort(function (a, b) { return effectiveStartTime(a).localeCompare(effectiveStartTime(b)); });
  }

  // ---------- conflict detection ----------
  // Reasons about whether two events (an unsaved candidate + a saved Event,
  // or two saved Events) could ever collide, without expanding either into
  // concrete calendar-day occurrences. Two questions, kept separate:
  // (a) can they ever land on the same calendar day (domainsCanShareDay),
  // (b) given that, do their effective time windows overlap same-day
  // (timeWindowsOverlap). Deliberately does NOT detect a conflict where one
  // event spans past midnight into a different event scheduled early the
  // next calendar day — see .specs/features/small-improvements/spec.md.

  // Local (not UTC) day-of-week for a 'YYYY-MM-DD' string — distinct from
  // weekdayOfDateStr below, which is UTC-only and used solely by export/import.
  function localWeekdayOfDateStr(s) {
    var p = s.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]).getDay();
  }

  function dateRangesOverlap(aStart, aEnd, bStart, bEnd) {
    if (aEnd && bStart > aEnd) return false;
    if (bEnd && aStart > bEnd) return false;
    return true;
  }

  function eventDomain(ev) {
    return ev.kind === 'punctual'
      ? { once: ev.date }
      : { days: ev.recurrence.daysOfWeek, start: ev.recurrence.startDate, end: ev.recurrence.endDate };
  }

  function domainsCanShareDay(a, b) {
    if (a.once && b.once) return a.once === b.once;
    if (a.once) return domainsCanShareDay(b, a);
    if (b.once) {
      return b.once >= a.start && (!a.end || b.once <= a.end) &&
        a.days.indexOf(localWeekdayOfDateStr(b.once)) !== -1;
    }
    if (!dateRangesOverlap(a.start, a.end, b.start, b.end)) return false;
    return a.days.some(function (d) { return b.days.indexOf(d) !== -1; });
  }

  function timeToMinutes(t) {
    var p = t.split(':').map(Number);
    return p[0] * 60 + p[1];
  }

  function timeWindowsOverlap(aStart, aEnd, bStart, bEnd) {
    var as = timeToMinutes(aStart), ae = timeToMinutes(aEnd);
    var bs = timeToMinutes(bStart), be = timeToMinutes(bEnd);
    if (ae <= as) ae += 1440;
    if (be <= bs) be += 1440;
    return as < be && bs < ae;
  }

  // candidate: { kind, date, recurrence, startTime, endTime } (unsaved form
  // values or an imported item's parsed schedule); existing: a saved Event.
  function eventsConflict(candidate, candidateOffset, existing) {
    if (!domainsCanShareDay(eventDomain(candidate), eventDomain(existing))) return false;
    var exOffset = bundleOffset(existing);
    return timeWindowsOverlap(
      applyHourOffset(candidate.startTime, candidateOffset),
      applyHourOffset(candidate.endTime, candidateOffset),
      applyHourOffset(existing.startTime, exOffset),
      applyHourOffset(existing.endTime, exOffset)
    );
  }

  function findConflicts(candidate, candidateOffset, excludeId) {
    return state.events.filter(function (ev) {
      if (ev.active === false) return false;
      if (excludeId && ev.id === excludeId) return false;
      return eventsConflict(candidate, candidateOffset, ev);
    });
  }

  // ---------- persistence ----------

  function persist() {
    window.api.saveData({ version: 1, events: state.events, bundles: state.bundles, settings: state.settings });
  }

  async function loadData() {
    var loaded = null;
    try {
      loaded = await window.api.loadData();
    } catch (e) {
      loaded = null;
    }
    if (loaded && loaded.events && loaded.bundles) {
      state.events = loaded.events;
      state.bundles = loaded.bundles;
      state.settings = Object.assign({}, DEFAULT_SETTINGS, loaded.settings || {});
      // Migrate a pre-settings data.json by writing the defaults back —
      // safe here specifically because we just confirmed a real, successful
      // read with actual events/bundles. Never persist on a failed/null
      // load below: that would silently overwrite real data on disk with
      // an empty state on nothing more than a transient read hiccup.
      if (!loaded.settings) persist();
    } else {
      state.events = [];
      state.bundles = [];
      state.settings = Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  // ---------- calendar rendering ----------

  var monthYearEl = document.getElementById('monthYear');
  var weekdaysEl = document.getElementById('weekdays');
  var gridEl = document.getElementById('grid');

  function renderWeekdays() {
    weekdaysEl.innerHTML = '';
    DAY_NAMES.forEach(function (name) {
      var el = document.createElement('div');
      el.className = 'weekday';
      el.textContent = name;
      weekdaysEl.appendChild(el);
    });
  }

  function renderCalendar() {
    monthYearEl.textContent = MONTH_NAMES[viewDate.getMonth()] + ' ' + viewDate.getFullYear();
    gridEl.innerHTML = '';

    var firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    var startOffset = firstOfMonth.getDay();
    var startDate = addDays(firstOfMonth, -startOffset);

    for (var i = 0; i < 42; i++) {
      var cellDate = addDays(startDate, i);
      var cell = document.createElement('div');
      cell.className = 'day-cell';
      if (cellDate.getMonth() !== viewDate.getMonth()) cell.classList.add('outside');
      if (keyFor(cellDate) === keyFor(today)) cell.classList.add('today');

      var num = document.createElement('div');
      num.className = 'day-num';
      num.textContent = String(cellDate.getDate());
      cell.appendChild(num);

      var dayEvents = getEventsForDate(cellDate);
      var eventsWrap = document.createElement('div');
      eventsWrap.className = 'events';

      dayEvents.slice(0, 3).forEach(function (ev) {
        var pill = document.createElement('div');
        pill.className = 'event color-' + effectiveColor(ev);
        pill.textContent = formatTimeDisplay(effectiveStartTime(ev)) + ' - ' +
          formatTimeDisplay(effectiveEndTime(ev)) + ' ' + effectiveTitle(ev);
        pill.addEventListener('click', function () { openEventEditModal(ev.id); });
        eventsWrap.appendChild(pill);
      });

      if (dayEvents.length > 3) {
        var more = document.createElement('div');
        more.className = 'event-more';
        more.textContent = '+' + (dayEvents.length - 3) + ' more';
        eventsWrap.appendChild(more);
      }

      cell.appendChild(eventsWrap);
      gridEl.appendChild(cell);
    }
  }

  function goToMonth(delta) {
    viewDate.setMonth(viewDate.getMonth() + delta);
    renderCalendar();
  }

  document.getElementById('prevBtn').addEventListener('click', function () { goToMonth(-1); });
  document.getElementById('nextBtn').addEventListener('click', function () { goToMonth(1); });
  document.getElementById('todayBtn').addEventListener('click', function () {
    viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
    renderCalendar();
  });

  // Scroll wheel over the calendar browses months. Throttled so a single
  // scroll gesture (especially trackpads, which fire many small deltas)
  // only moves one month at a time.
  var lastWheelNav = 0;
  document.querySelector('.app').addEventListener('wheel', function (e) {
    var now = Date.now();
    if (now - lastWheelNav < 350) return;
    lastWheelNav = now;
    goToMonth(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  // ---------- generic modal open/close ----------

  function openModal(overlay) { overlay.classList.add('open'); }
  function closeModal(overlay) { overlay.classList.remove('open'); }

  [
    ['eventModalOverlay', ['eventModalClose', 'eventCancelBtn']],
    ['bundleModalOverlay', ['bundleModalClose', 'bundleCancelBtn']],
    ['bundlesListModalOverlay', ['bundlesListModalClose', 'bundlesListCloseBtn']],
    ['bundleDetailModalOverlay', ['bundleDetailModalClose', 'bundleDetailCloseBtn']],
    ['exportModalOverlay', ['exportModalClose', 'exportCloseBtn']],
    ['importModalOverlay', ['importModalClose', 'importCancelBtn']],
    ['settingsModalOverlay', ['settingsModalClose', 'settingsCancelBtn']],
    ['upcomingModalOverlay', ['upcomingModalClose', 'upcomingCloseBtn']],
  ].forEach(function (pair) {
    var overlay = document.getElementById(pair[0]);
    pair[1].forEach(function (btnId) {
      document.getElementById(btnId).addEventListener('click', function () { closeModal(overlay); });
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal(overlay);
    });
  });

  // ---------- conflict result rendering (shared: event modal + import modal) ----------

  function setConflictResultState(el, stateClass) {
    el.hidden = false;
    el.classList.remove('ok', 'has-conflicts');
    if (stateClass) el.classList.add(stateClass);
  }

  // conflicts: array of existing Event objects that collide with one candidate.
  function renderSingleConflictResult(el, conflicts) {
    el.innerHTML = '';
    if (conflicts.length === 0) {
      setConflictResultState(el, 'ok');
      el.textContent = 'No conflicts found.';
      return;
    }
    setConflictResultState(el, 'has-conflicts');
    el.appendChild(document.createTextNode('Conflicts with:'));
    var ul = document.createElement('ul');
    conflicts.forEach(function (ev) {
      var li = document.createElement('li');
      li.textContent = effectiveTitle(ev) + ' — ' + scheduleSummary(ev);
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }

  // results: array of { label, conflicts: Event[] } — one per candidate event.
  function renderBatchConflictResult(el, results) {
    el.innerHTML = '';
    var conflicting = results.filter(function (r) { return r.conflicts.length > 0; });
    if (conflicting.length === 0) {
      setConflictResultState(el, 'ok');
      el.textContent = 'No conflicts found.';
      return;
    }
    setConflictResultState(el, 'has-conflicts');
    el.appendChild(document.createTextNode(conflicting.length + ' of ' + results.length + ' event(s) conflict:'));
    var ul = document.createElement('ul');
    conflicting.forEach(function (r) {
      var li = document.createElement('li');
      var names = r.conflicts.map(function (ev) { return effectiveTitle(ev); }).join(', ');
      li.textContent = r.label + ' — overlaps with ' + names;
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }

  // ---------- shared date-picker popup ----------
  // One popup, portaled outside every modal (see index.html) and reused by
  // whichever date field opened it — only one can ever be open at a time.
  // See .specs/features/custom-date-time-inputs/design.md.

  var datePickerPopup = document.getElementById('datePickerPopup');
  var datePickerMonthYearEl = document.getElementById('datePickerMonthYear');
  var datePickerWeekdaysEl = document.getElementById('datePickerWeekdays');
  var datePickerGridEl = document.getElementById('datePickerGrid');
  var datePickerPrevBtn = document.getElementById('datePickerPrevBtn');
  var datePickerNextBtn = document.getElementById('datePickerNextBtn');
  var eventModalBodyEl = document.querySelector('#eventModalOverlay .modal-body');

  var datePickerViewDate = new Date(today.getFullYear(), today.getMonth(), 1);
  var datePickerActiveField = null;
  var datePickerAnchorEl = null;
  var datePickerSelected = null;

  DAY_NAMES.forEach(function (name) {
    var el = document.createElement('span');
    el.textContent = name.slice(0, 2);
    datePickerWeekdaysEl.appendChild(el);
  });

  function renderDatePickerGrid() {
    datePickerMonthYearEl.textContent = MONTH_NAMES[datePickerViewDate.getMonth()] + ' ' + datePickerViewDate.getFullYear();
    datePickerGridEl.innerHTML = '';

    var firstOfMonth = new Date(datePickerViewDate.getFullYear(), datePickerViewDate.getMonth(), 1);
    var startDate = addDays(firstOfMonth, -firstOfMonth.getDay());
    var todayKeyStr = keyFor(today);
    var cellDates = [];
    for (var i = 0; i < 42; i++) cellDates.push(addDays(startDate, i));

    cellDates.forEach(function (cellDate) {
      var k = keyFor(cellDate);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'date-picker-day';
      if (cellDate.getMonth() !== datePickerViewDate.getMonth()) btn.classList.add('outside');
      if (k === todayKeyStr) btn.classList.add('today');
      if (k === datePickerSelected) btn.classList.add('selected');
      btn.textContent = String(cellDate.getDate());
      btn.addEventListener('click', function () {
        if (datePickerActiveField) datePickerActiveField.selectFromPopup(k);
        closeDatePickerPopup();
      });
      datePickerGridEl.appendChild(btn);
    });
  }

  datePickerPrevBtn.addEventListener('click', function () {
    datePickerViewDate.setMonth(datePickerViewDate.getMonth() - 1);
    renderDatePickerGrid();
  });
  datePickerNextBtn.addEventListener('click', function () {
    datePickerViewDate.setMonth(datePickerViewDate.getMonth() + 1);
    renderDatePickerGrid();
  });

  // .modal-body is overflow-y:auto and .modal is overflow:hidden, so the
  // popup can't live inside either without being clipped/scrolled away —
  // it's fixed-positioned from the icon button's real screen position instead.
  function positionDatePickerPopup(anchorEl) {
    var rect = anchorEl.getBoundingClientRect();
    var popupWidth = datePickerPopup.offsetWidth;
    var popupHeight = datePickerPopup.offsetHeight;
    var top = rect.bottom + 6;
    if (top + popupHeight > window.innerHeight) {
      top = rect.top - popupHeight - 6;
    }
    var left = rect.right - popupWidth;
    if (left < 8) left = 8;
    datePickerPopup.style.top = Math.max(8, top) + 'px';
    datePickerPopup.style.left = left + 'px';
  }

  function handleDatePickerOutsideClick(e) {
    if (datePickerPopup.hidden) return;
    if (datePickerPopup.contains(e.target)) return;
    if (datePickerAnchorEl && datePickerAnchorEl.contains(e.target)) return;
    closeDatePickerPopup();
  }

  function handleDatePickerKeydown(e) {
    if (e.key === 'Escape') closeDatePickerPopup();
  }

  function openDatePickerPopup(field, anchorEl, initialValue) {
    datePickerActiveField = field;
    datePickerAnchorEl = anchorEl;
    datePickerSelected = initialValue || null;

    var base = today;
    if (initialValue) {
      var p = initialValue.split('-').map(Number);
      base = new Date(p[0], p[1] - 1, p[2]);
    }
    datePickerViewDate = new Date(base.getFullYear(), base.getMonth(), 1);

    datePickerPopup.hidden = false;
    renderDatePickerGrid();
    positionDatePickerPopup(anchorEl);

    document.addEventListener('mousedown', handleDatePickerOutsideClick, true);
    document.addEventListener('keydown', handleDatePickerKeydown, true);
    window.addEventListener('resize', closeDatePickerPopup);
    if (eventModalBodyEl) eventModalBodyEl.addEventListener('scroll', closeDatePickerPopup);
  }

  function closeDatePickerPopup() {
    datePickerPopup.hidden = true;
    datePickerActiveField = null;
    datePickerAnchorEl = null;
    document.removeEventListener('mousedown', handleDatePickerOutsideClick, true);
    document.removeEventListener('keydown', handleDatePickerKeydown, true);
    window.removeEventListener('resize', closeDatePickerPopup);
    if (eventModalBodyEl) eventModalBodyEl.removeEventListener('scroll', closeDatePickerPopup);
  }

  // ---------- custom date/time field controllers ----------
  // Presentation-layer wrappers around plain <input type="text">: display
  // and accept the localized dateFormat/timeFormat, while every other call
  // site keeps talking in canonical 'YYYY-MM-DD' / 24h 'HH:MM' via
  // getValue()/setValue(). getValue() re-parses the field's current text
  // (not a cached value) so it's always accurate even before blur.
  // getValue() returns: the canonical string if valid, null if empty AND
  // optional, or undefined if empty-but-required / invalid (callers treat
  // undefined as "can't proceed, error is already shown inline").

  function createDateField(opts) {
    var canonical = null;
    var controller;

    function render() {
      opts.inputEl.value = canonical ? formatDateHuman(canonical) : '';
    }
    function showError(msg) {
      opts.errorEl.textContent = msg;
      opts.errorEl.hidden = false;
      opts.inputEl.classList.add('invalid');
    }
    function clearFieldError() {
      opts.errorEl.hidden = true;
      opts.inputEl.classList.remove('invalid');
    }
    function setValue(v) {
      canonical = v || null;
      clearFieldError();
      render();
    }
    function getValue() {
      var text = opts.inputEl.value.trim();
      if (!text) {
        clearFieldError();
        canonical = null;
        return opts.required ? undefined : null;
      }
      var parsed = parseLocalizedDate(text, state.settings.dateFormat);
      if (parsed === null) {
        showError('Enter a valid date (' + state.settings.dateFormat + ').');
        return undefined;
      }
      clearFieldError();
      canonical = parsed;
      return parsed;
    }

    opts.inputEl.addEventListener('blur', function () {
      var v = getValue();
      if (v !== undefined) render();
    });
    opts.inputEl.addEventListener('input', function () {
      var masked = maskDateInputValue(opts.inputEl.value, state.settings.dateFormat);
      if (masked !== opts.inputEl.value) {
        opts.inputEl.value = masked;
        opts.inputEl.setSelectionRange(masked.length, masked.length);
      }
    });

    opts.iconBtnEl.addEventListener('click', function () {
      getValue();
      openDatePickerPopup(controller, opts.iconBtnEl, canonical);
    });

    controller = {
      getValue: getValue,
      setValue: setValue,
      selectFromPopup: function (dateStr) { setValue(dateStr); },
    };
    return controller;
  }

  function createTimeField(opts) {
    var canonical = null;

    function render() {
      opts.inputEl.value = canonical ? formatTimeDisplay(canonical) : '';
    }
    function showError(msg) {
      opts.errorEl.textContent = msg;
      opts.errorEl.hidden = false;
      opts.inputEl.classList.add('invalid');
    }
    function clearFieldError() {
      opts.errorEl.hidden = true;
      opts.inputEl.classList.remove('invalid');
    }
    function setValue(v) {
      canonical = v || null;
      clearFieldError();
      render();
    }
    function getValue() {
      var text = opts.inputEl.value.trim();
      if (!text) {
        clearFieldError();
        canonical = null;
        return undefined;
      }
      var parsed = parseLocalizedTime(text, state.settings.timeFormat);
      if (parsed === null) {
        showError(state.settings.timeFormat === '12h' ? 'Enter a valid time (e.g. 8:00 PM).' : 'Enter a valid time (e.g. 20:00).');
        return undefined;
      }
      clearFieldError();
      canonical = parsed;
      return parsed;
    }

    opts.inputEl.addEventListener('blur', function () {
      var v = getValue();
      if (v !== undefined) render();
    });
    opts.inputEl.addEventListener('input', function () {
      var masked = maskTimeInputValue(opts.inputEl.value, state.settings.timeFormat);
      if (masked !== opts.inputEl.value) {
        opts.inputEl.value = masked;
        opts.inputEl.setSelectionRange(masked.length, masked.length);
      }
    });

    return { getValue: getValue, setValue: setValue };
  }

  // ---------- undo-on-delete toast ----------
  // Second safety net alongside (not instead of) the existing
  // window.confirm() dialogs for all three delete actions (event delete,
  // event delete from Bundle Detail, bundle delete): confirming still
  // deletes immediately, but a 10s undo window follows. Only one pending
  // undo is ever live — a second delete finalizes the first (nothing to
  // restore for it anymore, matching e.g. Gmail's "undo send").
  // See .specs/features/undo-delete-toast/design.md.

  var UNDO_TOAST_MS = 10000;
  var undoToastEl = document.getElementById('undoToast');
  var undoToastMessageEl = document.getElementById('undoToastMessage');
  var undoToastBtn = document.getElementById('undoToastBtn');
  var undoToastCloseBtn = document.getElementById('undoToastCloseBtn');
  var undoToastBarEl = document.getElementById('undoToastBar');
  var pendingUndo = null;
  var undoToastTimeoutId = null;

  function finalizeUndoToast() {
    pendingUndo = null;
    clearTimeout(undoToastTimeoutId);
    undoToastEl.hidden = true;
  }

  function showUndoToast(message, restoreFn) {
    if (pendingUndo) finalizeUndoToast();
    pendingUndo = { restore: restoreFn };

    undoToastMessageEl.textContent = message;
    undoToastEl.hidden = false;

    undoToastBarEl.style.transition = 'none';
    undoToastBarEl.style.transform = 'scaleX(1)';
    // eslint-disable-next-line no-unused-expressions
    undoToastBarEl.offsetHeight; // force reflow so the transition below actually animates
    undoToastBarEl.style.transition = 'transform ' + (UNDO_TOAST_MS / 1000) + 's linear';
    undoToastBarEl.style.transform = 'scaleX(0)';

    undoToastTimeoutId = setTimeout(finalizeUndoToast, UNDO_TOAST_MS);
  }

  undoToastBtn.addEventListener('click', function () {
    if (!pendingUndo) return;
    var restore = pendingUndo.restore;
    pendingUndo = null;
    clearTimeout(undoToastTimeoutId);
    undoToastEl.hidden = true;
    restore();
  });
  undoToastCloseBtn.addEventListener('click', finalizeUndoToast);

  // ---------- event modal ----------

  var eventModalOverlay = document.getElementById('eventModalOverlay');
  var eventModalTitleEl = document.getElementById('eventModalTitle');
  var eventBundleContext = document.getElementById('eventBundleContext');
  var eventBundleNameEl = document.getElementById('eventBundleName');
  var eventOverrideToggle = document.getElementById('eventOverrideToggle');
  var eventTitleInput = document.getElementById('eventTitle');
  var eventDescriptionInput = document.getElementById('eventDescription');
  var eventColorFieldEl = document.getElementById('eventColorField');
  var eventColorSwatchesEl = document.getElementById('eventColorSwatches');
  var kindPunctualBtn = document.getElementById('kindPunctualBtn');
  var kindRecurringBtn = document.getElementById('kindRecurringBtn');
  var punctualFields = document.getElementById('punctualFields');
  var recurringFields = document.getElementById('recurringFields');
  var daysRow = document.getElementById('daysRow');
  var eventNotifySelect = document.getElementById('eventNotify');

  var eventDateField = createDateField({
    inputEl: document.getElementById('eventDate'),
    iconBtnEl: document.querySelector('.date-field-icon-btn[data-field="eventDate"]'),
    errorEl: document.getElementById('eventDateError'),
    required: true,
  });
  var eventRecurStartField = createDateField({
    inputEl: document.getElementById('eventRecurStart'),
    iconBtnEl: document.querySelector('.date-field-icon-btn[data-field="eventRecurStart"]'),
    errorEl: document.getElementById('eventRecurStartError'),
    required: true,
  });
  var eventRecurEndField = createDateField({
    inputEl: document.getElementById('eventRecurEnd'),
    iconBtnEl: document.querySelector('.date-field-icon-btn[data-field="eventRecurEnd"]'),
    errorEl: document.getElementById('eventRecurEndError'),
    required: false,
  });
  var eventStartTimeField = createTimeField({
    inputEl: document.getElementById('eventStartTime'),
    errorEl: document.getElementById('eventStartTimeError'),
  });
  var eventEndTimeField = createTimeField({
    inputEl: document.getElementById('eventEndTime'),
    errorEl: document.getElementById('eventEndTimeError'),
  });
  var eventFormError = document.getElementById('eventFormError');
  var eventConflictResult = document.getElementById('eventConflictResult');
  var eventDeleteBtn = document.getElementById('eventDeleteBtn');
  var eventCheckConflictsBtn = document.getElementById('eventCheckConflictsBtn');
  var eventSaveBtn = document.getElementById('eventSaveBtn');

  var eventModalEditingId = null;
  var eventModalBundleId = null;
  var eventModalKind = 'punctual';
  var eventModalSelectedColor = DEFAULT_COLOR;

  function renderEventColorSwatches() {
    renderColorSwatches(eventColorSwatchesEl, eventModalSelectedColor, function (c) {
      eventModalSelectedColor = c;
      renderEventColorSwatches();
    });
  }

  function setEventOwnFieldsEnabled(enabled) {
    eventTitleInput.disabled = !enabled;
    eventDescriptionInput.disabled = !enabled;
  }

  function setKind(kind) {
    eventModalKind = kind;
    kindPunctualBtn.classList.toggle('active', kind === 'punctual');
    kindRecurringBtn.classList.toggle('active', kind === 'recurring');
    punctualFields.hidden = kind !== 'punctual';
    recurringFields.hidden = kind !== 'recurring';
  }
  kindPunctualBtn.addEventListener('click', function () { setKind('punctual'); });
  kindRecurringBtn.addEventListener('click', function () { setKind('recurring'); });

  eventOverrideToggle.addEventListener('change', function () {
    if (eventOverrideToggle.checked) {
      setEventOwnFieldsEnabled(true);
    } else {
      var b = getBundle(eventModalBundleId);
      if (b) {
        eventTitleInput.value = b.title;
        eventDescriptionInput.value = b.description || '';
      }
      setEventOwnFieldsEnabled(false);
    }
  });

  function resetEventForm() {
    eventFormError.hidden = true;
    eventConflictResult.hidden = true;
    eventTitleInput.value = '';
    eventDescriptionInput.value = '';
    eventModalSelectedColor = DEFAULT_COLOR;
    renderEventColorSwatches();
    setKind('punctual');
    eventDateField.setValue(keyFor(today));
    Array.prototype.forEach.call(daysRow.querySelectorAll('input[type=checkbox]'), function (cb) { cb.checked = false; });
    eventRecurStartField.setValue(keyFor(today));
    eventRecurEndField.setValue(null);
    eventStartTimeField.setValue('20:00');
    eventEndTimeField.setValue('22:00');
    eventNotifySelect.value = '0';
    setEventOwnFieldsEnabled(true);
    eventOverrideToggle.checked = false;
  }

  function openEventCreateModal(bundleId) {
    eventModalEditingId = null;
    eventModalBundleId = bundleId || null;
    resetEventForm();
    eventModalTitleEl.textContent = 'New Event';
    eventDeleteBtn.hidden = true;

    var b = getBundle(eventModalBundleId);
    if (b) {
      eventBundleContext.hidden = false;
      eventBundleNameEl.textContent = b.title;
      eventTitleInput.value = b.title;
      eventDescriptionInput.value = b.description || '';
      eventOverrideToggle.checked = false;
      setEventOwnFieldsEnabled(false);
      eventColorFieldEl.hidden = true;
    } else {
      eventBundleContext.hidden = true;
      eventColorFieldEl.hidden = false;
    }
    openModal(eventModalOverlay);
  }

  function openEventEditModal(eventId) {
    var ev = state.events.find(function (e) { return e.id === eventId; });
    if (!ev) return;
    eventModalEditingId = eventId;
    eventModalBundleId = ev.bundleId;
    eventFormError.hidden = true;
    eventConflictResult.hidden = true;
    eventModalTitleEl.textContent = 'Edit Event';
    eventDeleteBtn.hidden = false;

    eventTitleInput.value = effectiveTitle(ev);
    eventDescriptionInput.value = effectiveDescription(ev) || '';

    var b = getBundle(ev.bundleId);
    if (b) {
      eventBundleContext.hidden = false;
      eventBundleNameEl.textContent = b.title;
      eventOverrideToggle.checked = isOverridden(ev);
      setEventOwnFieldsEnabled(isOverridden(ev));
      eventColorFieldEl.hidden = true;
    } else {
      eventBundleContext.hidden = true;
      setEventOwnFieldsEnabled(true);
      eventColorFieldEl.hidden = false;
      eventModalSelectedColor = ev.color || DEFAULT_COLOR;
      renderEventColorSwatches();
    }

    setKind(ev.kind);
    if (ev.kind === 'punctual') {
      eventDateField.setValue(ev.date);
      eventRecurStartField.setValue(keyFor(today));
      eventRecurEndField.setValue(null);
      Array.prototype.forEach.call(daysRow.querySelectorAll('input[type=checkbox]'), function (cb) { cb.checked = false; });
    } else {
      eventDateField.setValue(keyFor(today));
      Array.prototype.forEach.call(daysRow.querySelectorAll('input[type=checkbox]'), function (cb) {
        cb.checked = ev.recurrence.daysOfWeek.indexOf(Number(cb.value)) !== -1;
      });
      eventRecurStartField.setValue(ev.recurrence.startDate);
      eventRecurEndField.setValue(ev.recurrence.endDate || null);
    }
    eventStartTimeField.setValue(ev.startTime);
    eventEndTimeField.setValue(ev.endTime);
    eventNotifySelect.value = String(ev.notifyMinutesBefore || 0);

    openModal(eventModalOverlay);
  }

  document.getElementById('newEventBtn').addEventListener('click', function () { openEventCreateModal(null); });
  eventSaveBtn.addEventListener('click', function () {
    var isBundled = !!eventModalBundleId;
    var needsOwnFields = !isBundled || eventOverrideToggle.checked;

    if (needsOwnFields && !eventTitleInput.value.trim()) {
      eventFormError.textContent = 'Title is required.';
      eventFormError.hidden = false;
      return;
    }

    var startTime = eventStartTimeField.getValue();
    var endTime = eventEndTimeField.getValue();
    if (startTime === undefined || endTime === undefined) {
      eventFormError.textContent = 'Enter a valid start and end time (see field(s) above).';
      eventFormError.hidden = false;
      return;
    }
    if (endTime === startTime) {
      eventFormError.textContent = 'Start and end time cannot be the same.';
      eventFormError.hidden = false;
      return;
    }

    var payload = {
      kind: eventModalKind,
      startTime: startTime,
      endTime: endTime,
      notifyMinutesBefore: Number(eventNotifySelect.value),
    };

    if (eventModalKind === 'punctual') {
      var date = eventDateField.getValue();
      if (date === undefined) {
        eventFormError.textContent = 'Enter a valid date.';
        eventFormError.hidden = false;
        return;
      }
      payload.date = date;
      payload.recurrence = null;
    } else {
      var days = Array.prototype.filter.call(daysRow.querySelectorAll('input[type=checkbox]'), function (cb) { return cb.checked; })
        .map(function (cb) { return Number(cb.value); });
      if (days.length === 0) {
        eventFormError.textContent = 'Select at least one day of the week.';
        eventFormError.hidden = false;
        return;
      }
      var recurStart = eventRecurStartField.getValue();
      if (recurStart === undefined) {
        eventFormError.textContent = 'Enter a valid start date for recurring events.';
        eventFormError.hidden = false;
        return;
      }
      var recurEnd = eventRecurEndField.getValue();
      if (recurEnd === undefined) {
        eventFormError.textContent = 'Enter a valid end date, or clear it.';
        eventFormError.hidden = false;
        return;
      }
      payload.date = null;
      payload.recurrence = {
        daysOfWeek: days,
        startDate: recurStart,
        endDate: recurEnd,
      };
    }

    if (needsOwnFields) {
      payload.title = eventTitleInput.value.trim();
      payload.description = eventDescriptionInput.value.trim();
    } else {
      payload.title = null;
      payload.description = null;
    }
    // Color is bundle-wide only: standalone events carry their own,
    // bundled events always inherit the bundle's and never get one.
    if (!isBundled) {
      payload.color = eventModalSelectedColor;
    }

    if (eventModalEditingId) {
      var idx = state.events.findIndex(function (e) { return e.id === eventModalEditingId; });
      if (idx !== -1) {
        state.events[idx] = Object.assign({}, state.events[idx], payload);
      }
    } else {
      state.events.push(Object.assign({ id: uid(), bundleId: eventModalBundleId, active: true }, payload));
    }

    persist();
    closeModal(eventModalOverlay);
    renderCalendar();
    if (bundleDetailModalOverlay.classList.contains('open') && currentDetailBundleId) {
      renderBundleDetail(currentDetailBundleId);
    }
  });

  eventDeleteBtn.addEventListener('click', function () {
    if (!eventModalEditingId) return;
    if (!window.confirm('Delete this event?')) return;
    var deleted = state.events.find(function (e) { return e.id === eventModalEditingId; });
    if (!deleted) return;
    var deletedBundleId = currentDetailBundleId;
    state.events = state.events.filter(function (e) { return e.id !== eventModalEditingId; });
    persist();
    closeModal(eventModalOverlay);
    renderCalendar();
    if (bundleDetailModalOverlay.classList.contains('open') && deletedBundleId) {
      renderBundleDetail(deletedBundleId);
    }
    showUndoToast(effectiveTitle(deleted) + ' deleted', function () {
      state.events.push(deleted);
      persist();
      renderCalendar();
      if (bundleDetailModalOverlay.classList.contains('open') && deletedBundleId) {
        renderBundleDetail(deletedBundleId);
      }
    });
  });

  // Reads the event modal's current unsaved field values into a candidate
  // suitable for findConflicts. Returns null if the schedule fields aren't
  // filled in enough to check yet (mirrors eventSaveBtn's own validation,
  // but non-blocking — just declines to check rather than showing an error).
  function getEventFormCandidate() {
    var startTime = eventStartTimeField.getValue();
    var endTime = eventEndTimeField.getValue();
    if (startTime === undefined || endTime === undefined) return null;
    if (eventModalKind === 'punctual') {
      var date = eventDateField.getValue();
      if (date === undefined) return null;
      return {
        kind: 'punctual',
        date: date,
        recurrence: null,
        startTime: startTime,
        endTime: endTime,
      };
    }
    var days = Array.prototype.filter.call(daysRow.querySelectorAll('input[type=checkbox]'), function (cb) { return cb.checked; })
      .map(function (cb) { return Number(cb.value); });
    var recurStart = eventRecurStartField.getValue();
    var recurEnd = eventRecurEndField.getValue();
    if (days.length === 0 || recurStart === undefined || recurEnd === undefined) return null;
    return {
      kind: 'recurring',
      date: null,
      recurrence: {
        daysOfWeek: days,
        startDate: recurStart,
        endDate: recurEnd,
      },
      startTime: startTime,
      endTime: endTime,
    };
  }

  eventCheckConflictsBtn.addEventListener('click', function () {
    var candidate = getEventFormCandidate();
    if (!candidate) {
      eventConflictResult.innerHTML = '';
      setConflictResultState(eventConflictResult, null);
      eventConflictResult.textContent = 'Fill in the date/time fields first.';
      return;
    }
    var offset = eventModalBundleId ? bundleOffset({ bundleId: eventModalBundleId }) : 0;
    var conflicts = findConflicts(candidate, offset, eventModalEditingId);
    renderSingleConflictResult(eventConflictResult, conflicts);
  });

  // ---------- bundle modal (create/edit bundle info) ----------

  var bundleModalOverlay = document.getElementById('bundleModalOverlay');
  var bundleModalTitleEl = document.getElementById('bundleModalTitle');
  var bundleTitleInput = document.getElementById('bundleTitle');
  var bundleDescriptionInput = document.getElementById('bundleDescription');
  var bundleColorSwatchesEl = document.getElementById('bundleColorSwatches');
  var bundleFormError = document.getElementById('bundleFormError');
  var bundleModalEditingId = null;
  var bundleModalSelectedColor = DEFAULT_COLOR;

  function renderBundleColorSwatches() {
    renderColorSwatches(bundleColorSwatchesEl, bundleModalSelectedColor, function (c) {
      bundleModalSelectedColor = c;
      renderBundleColorSwatches();
    });
  }

  function openBundleCreateModal() {
    bundleModalEditingId = null;
    bundleModalTitleEl.textContent = 'New Bundle';
    bundleFormError.hidden = true;
    bundleTitleInput.value = '';
    bundleDescriptionInput.value = '';
    bundleModalSelectedColor = DEFAULT_COLOR;
    renderBundleColorSwatches();
    openModal(bundleModalOverlay);
  }

  function openBundleEditModal(bundleId) {
    var b = getBundle(bundleId);
    if (!b) return;
    bundleModalEditingId = bundleId;
    bundleModalTitleEl.textContent = 'Edit Bundle';
    bundleFormError.hidden = true;
    bundleTitleInput.value = b.title;
    bundleDescriptionInput.value = b.description || '';
    bundleModalSelectedColor = b.color || DEFAULT_COLOR;
    renderBundleColorSwatches();
    openModal(bundleModalOverlay);
  }

  document.getElementById('newBundleBtn').addEventListener('click', function () {
    closeModal(bundlesListModalOverlay);
    openBundleCreateModal();
  });

  document.getElementById('bundleSaveBtn').addEventListener('click', function () {
    if (!bundleTitleInput.value.trim()) {
      bundleFormError.textContent = 'Title is required.';
      bundleFormError.hidden = false;
      return;
    }
    var payload = {
      title: bundleTitleInput.value.trim(),
      description: bundleDescriptionInput.value.trim(),
      color: bundleModalSelectedColor,
    };

    if (bundleModalEditingId) {
      var idx = state.bundles.findIndex(function (b) { return b.id === bundleModalEditingId; });
      if (idx !== -1) state.bundles[idx] = Object.assign({}, state.bundles[idx], payload);
      persist();
      closeModal(bundleModalOverlay);
      renderCalendar();
      if (currentDetailBundleId === bundleModalEditingId) renderBundleDetail(currentDetailBundleId);
    } else {
      var newBundle = Object.assign({ id: uid(), hourOffset: 0 }, payload);
      state.bundles.push(newBundle);
      persist();
      closeModal(bundleModalOverlay);
      openBundleDetailModal(newBundle.id);
    }
  });

  document.getElementById('bundleModalBackBtn').addEventListener('click', function () {
    closeModal(bundleModalOverlay);
    // New bundles are only created from the Bundles list; editing is only
    // entered from a bundle's detail view — back returns to whichever one.
    if (bundleModalEditingId) {
      openBundleDetailModal(bundleModalEditingId);
    } else {
      openBundlesListModal();
    }
  });

  // ---------- bundles list modal ----------

  var bundlesListModalOverlay = document.getElementById('bundlesListModalOverlay');
  var bundlesListEl = document.getElementById('bundlesList');
  var bundlesListEmpty = document.getElementById('bundlesListEmpty');

  function openBundlesListModal() {
    bundlesListEl.innerHTML = '';
    bundlesListEmpty.hidden = state.bundles.length > 0;
    state.bundles.forEach(function (b) {
      var li = document.createElement('li');
      var count = eventsForBundle(b.id).length;
      var info = document.createElement('div');
      info.className = 'item-info';
      var title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = b.title;
      var sub = document.createElement('div');
      sub.className = 'item-sub';
      sub.textContent = count + (count === 1 ? ' event' : ' events');
      info.appendChild(title);
      info.appendChild(sub);
      var dot = document.createElement('i');
      dot.className = 'dot color-' + (b.color || DEFAULT_COLOR);
      li.appendChild(dot);
      li.appendChild(info);
      li.addEventListener('click', function () {
        closeModal(bundlesListModalOverlay);
        openBundleDetailModal(b.id);
      });
      bundlesListEl.appendChild(li);
    });
    openModal(bundlesListModalOverlay);
  }

  document.getElementById('bundlesBtn').addEventListener('click', openBundlesListModal);

  // ---------- bundle detail modal ----------

  var bundleDetailModalOverlay = document.getElementById('bundleDetailModalOverlay');
  var bundleDetailTitleEl = document.getElementById('bundleDetailTitle');
  var bundleDetailMetaEl = document.getElementById('bundleDetailMeta');
  var bundleEventListEl = document.getElementById('bundleEventList');
  var bundleOffsetValueEl = document.getElementById('bundleOffsetValue');
  var currentDetailBundleId = null;

  function renderBundleDetail(bundleId) {
    var b = getBundle(bundleId);
    if (!b) return;
    bundleDetailTitleEl.innerHTML = '';
    var titleDot = document.createElement('i');
    titleDot.className = 'dot color-' + (b.color || DEFAULT_COLOR);
    titleDot.style.marginRight = '8px';
    bundleDetailTitleEl.appendChild(titleDot);
    bundleDetailTitleEl.appendChild(document.createTextNode(b.title));
    bundleDetailMetaEl.textContent = b.description || '';

    var offset = b.hourOffset || 0;
    bundleOffsetValueEl.textContent = (offset > 0 ? '+' : '') + offset + 'h';

    var events = eventsForBundle(bundleId).slice().sort(function (a, c) {
      var da = a.kind === 'punctual' ? a.date : a.recurrence.startDate;
      var dc = c.kind === 'punctual' ? c.date : c.recurrence.startDate;
      return da.localeCompare(dc);
    });

    bundleEventListEl.innerHTML = '';
    if (events.length === 0) {
      var li = document.createElement('li');
      li.className = 'hint-text';
      li.textContent = 'No events yet. Add one with "+ Add Event".';
      bundleEventListEl.appendChild(li);
    }
    events.forEach(function (ev) {
      var li = document.createElement('li');
      if (ev.active === false) li.classList.add('inactive');
      var dot = document.createElement('i');
      dot.className = 'dot color-' + effectiveColor(ev);
      var info = document.createElement('div');
      info.className = 'item-info';
      var title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = effectiveTitle(ev) + (isOverridden(ev) ? ' (customized)' : '');
      var sub = document.createElement('div');
      sub.className = 'item-sub';
      sub.textContent = scheduleSummary(ev);
      info.appendChild(title);
      info.appendChild(sub);

      var toggleLabel = document.createElement('label');
      toggleLabel.className = 'toggle-switch';
      toggleLabel.title = 'Active';
      var toggleInput = document.createElement('input');
      toggleInput.type = 'checkbox';
      toggleInput.checked = ev.active !== false;
      var toggleSlider = document.createElement('span');
      toggleSlider.className = 'toggle-slider';
      toggleInput.addEventListener('change', function () {
        ev.active = toggleInput.checked;
        persist();
        renderBundleDetail(bundleId);
        renderCalendar();
      });
      toggleLabel.appendChild(toggleInput);
      toggleLabel.appendChild(toggleSlider);

      var editBtn = document.createElement('button');
      editBtn.className = 'btn btn-ghost';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', function () { openEventEditModal(ev.id); });

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', function () {
        if (!window.confirm('Delete this event from the bundle?')) return;
        state.events = state.events.filter(function (e) { return e.id !== ev.id; });
        persist();
        renderBundleDetail(bundleId);
        renderCalendar();
        showUndoToast(effectiveTitle(ev) + ' deleted', function () {
          state.events.push(ev);
          persist();
          renderBundleDetail(bundleId);
          renderCalendar();
        });
      });

      li.appendChild(dot);
      li.appendChild(info);
      li.appendChild(toggleLabel);
      li.appendChild(editBtn);
      li.appendChild(deleteBtn);
      bundleEventListEl.appendChild(li);
    });
  }

  function openBundleDetailModal(bundleId) {
    currentDetailBundleId = bundleId;
    renderBundleDetail(bundleId);
    openModal(bundleDetailModalOverlay);
  }

  document.getElementById('bundleDetailBackBtn').addEventListener('click', function () {
    closeModal(bundleDetailModalOverlay);
    openBundlesListModal();
  });

  document.getElementById('bundleEditBtn').addEventListener('click', function () {
    if (currentDetailBundleId) openBundleEditModal(currentDetailBundleId);
  });
  function adjustBundleOffset(delta) {
    var b = getBundle(currentDetailBundleId);
    if (!b) return;
    b.hourOffset = (b.hourOffset || 0) + delta;
    persist();
    renderBundleDetail(currentDetailBundleId);
    renderCalendar();
  }
  document.getElementById('bundleOffsetMinusBtn').addEventListener('click', function () { adjustBundleOffset(-1); });
  document.getElementById('bundleOffsetPlusBtn').addEventListener('click', function () { adjustBundleOffset(1); });
  document.getElementById('bundleAddEventBtn').addEventListener('click', function () {
    if (currentDetailBundleId) openEventCreateModal(currentDetailBundleId);
  });
  document.getElementById('bundleDeleteBtn').addEventListener('click', function () {
    if (!currentDetailBundleId) return;
    if (!window.confirm('Delete this bundle and all of its events?')) return;
    var bundleId = currentDetailBundleId;
    var deletedBundle = getBundle(bundleId);
    var deletedEvents = eventsForBundle(bundleId);
    state.events = state.events.filter(function (e) { return e.bundleId !== bundleId; });
    state.bundles = state.bundles.filter(function (b) { return b.id !== bundleId; });
    persist();
    closeModal(bundleDetailModalOverlay);
    renderCalendar();
    showUndoToast(deletedBundle.title + ' deleted', function () {
      state.bundles.push(deletedBundle);
      state.events = state.events.concat(deletedEvents);
      persist();
      renderCalendar();
    });
  });

  // ---------- upcoming summary modal ----------

  var upcomingModalOverlay = document.getElementById('upcomingModalOverlay');
  var upcomingListEl = document.getElementById('upcomingList');
  var upcomingEmptyEl = document.getElementById('upcomingEmpty');
  var upcomingWindowDays = 3;

  var UPCOMING_DAY_BUTTONS = [
    [3, document.getElementById('upcoming3Btn')],
    [5, document.getElementById('upcoming5Btn')],
    [7, document.getElementById('upcoming7Btn')],
  ];

  function setUpcomingWindowDays(n) {
    upcomingWindowDays = n;
    UPCOMING_DAY_BUTTONS.forEach(function (pair) {
      pair[1].classList.toggle('active', pair[0] === n);
    });
    renderUpcoming();
  }
  UPCOMING_DAY_BUTTONS.forEach(function (pair) {
    pair[1].addEventListener('click', function () { setUpcomingWindowDays(pair[0]); });
  });

  function renderUpcoming() {
    upcomingListEl.innerHTML = '';
    var anyDay = false;

    for (var i = 0; i < upcomingWindowDays; i++) {
      var d = addDays(today, i);
      var dayEvents = getEventsForDate(d);
      if (dayEvents.length === 0) continue;
      anyDay = true;

      var headerLi = document.createElement('li');
      headerLi.className = 'hint-text';
      headerLi.style.marginTop = i === 0 ? '0' : '10px';
      headerLi.textContent = formatDateHuman(keyFor(d)) + (keyFor(d) === keyFor(today) ? ' (Today)' : '');
      upcomingListEl.appendChild(headerLi);

      dayEvents.forEach(function (ev) {
        var li = document.createElement('li');
        var dot = document.createElement('i');
        dot.className = 'dot color-' + effectiveColor(ev);
        var info = document.createElement('div');
        info.className = 'item-info';
        var title = document.createElement('div');
        title.className = 'item-title';
        title.textContent = formatTimeDisplay(effectiveStartTime(ev)) + ' - ' +
          formatTimeDisplay(effectiveEndTime(ev)) + ' ' + effectiveTitle(ev);
        info.appendChild(title);
        if (ev.bundleId) {
          var b = getBundle(ev.bundleId);
          if (b) {
            var sub = document.createElement('div');
            sub.className = 'item-sub';
            sub.textContent = b.title;
            info.appendChild(sub);
          }
        }
        li.appendChild(dot);
        li.appendChild(info);
        li.addEventListener('click', function () {
          closeModal(upcomingModalOverlay);
          openEventEditModal(ev.id);
        });
        upcomingListEl.appendChild(li);
      });
    }

    upcomingEmptyEl.hidden = anyDay;
    if (!anyDay) {
      upcomingEmptyEl.textContent = 'No events in the next ' + upcomingWindowDays + ' days.';
    }
  }

  document.getElementById('upcomingBtn').addEventListener('click', function () {
    setUpcomingWindowDays(upcomingWindowDays);
    openModal(upcomingModalOverlay);
  });

  // ---------- UTC conversion helpers ----------
  // The export/import format standardizes every date and time to UTC so a
  // file produced on one computer means the same real-world moment when
  // read on another, regardless of each machine's local timezone/DST rules.

  var WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  // Day-of-week for a plain 'YYYY-MM-DD' calendar date, independent of any timezone.
  function weekdayOfDateStr(s) {
    var p = s.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }

  function shiftDateStr(s, days) {
    var p = s.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  // A timezone offset is always under 24h, so converting a local moment to/from
  // UTC can only ever shift the calendar day by -1, 0, or +1.
  function normalizeDayDelta(n) {
    n = ((n % 7) + 7) % 7;
    if (n === 6) return -1;
    if (n === 1) return 1;
    return 0;
  }

  // Local 'YYYY-MM-DD' + 'HH:MM' -> the same instant described in UTC.
  function toUtcDateTimeParts(localDateStr, localTimeStr) {
    var dp = localDateStr.split('-').map(Number);
    var tp = localTimeStr.split(':').map(Number);
    var d = new Date(dp[0], dp[1] - 1, dp[2], tp[0], tp[1], 0, 0);
    return {
      iso: d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      dateStr: d.toISOString().slice(0, 10),
      timeStr: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()),
      weekday: d.getUTCDay(),
    };
  }

  // UTC 'YYYY-MM-DD' + 'HH:MM' -> the same instant described in this computer's local time.
  function fromUtcDateTimeParts(utcDateStr, utcTimeStr) {
    var dp = utcDateStr.split('-').map(Number);
    var tp = utcTimeStr.split(':').map(Number);
    var d = new Date(Date.UTC(dp[0], dp[1] - 1, dp[2], tp[0], tp[1], 0, 0));
    return {
      dateStr: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      timeStr: pad(d.getHours()) + ':' + pad(d.getMinutes()),
      weekday: d.getDay(),
    };
  }

  function normalizeColor(c) {
    c = String(c || '').toLowerCase();
    return COLORS.indexOf(c) !== -1 ? c : DEFAULT_COLOR;
  }

  function normalizeNotify(n) {
    n = Number(n);
    return [0, 5, 10, 15, 30].indexOf(n) !== -1 ? n : 0;
  }

  // ---------- export ----------

  function exportSchedule(ev) {
    // Bake the bundle's manual DST correction into the exported time, since
    // that's the real-world moment the event is meant to represent.
    var offset = bundleOffset(ev);
    var startTime = applyHourOffset(ev.startTime, offset);
    var endTime = applyHourOffset(ev.endTime, offset);

    if (ev.kind === 'punctual') {
      var s = toUtcDateTimeParts(ev.date, startTime);
      var e = toUtcDateTimeParts(ev.date, endTime);
      return { scheduleType: 'oneTime', startsAtUtc: s.iso, endsAtUtc: e.iso };
    }

    var anchorDate = ev.recurrence.startDate;
    var localAnchorWeekday = weekdayOfDateStr(anchorDate);
    var utcAnchor = toUtcDateTimeParts(anchorDate, startTime);
    var delta = normalizeDayDelta(utcAnchor.weekday - localAnchorWeekday);
    var utcDays = ev.recurrence.daysOfWeek.slice().sort().map(function (d) { return (d + delta + 7) % 7; });
    var utcEndTime = toUtcDateTimeParts(anchorDate, endTime).timeStr;

    return {
      scheduleType: 'weekly',
      repeatsOnWeekdaysUtc: utcDays.map(function (d) { return WEEKDAY_NAMES[d]; }),
      startTimeUtc: utcAnchor.timeStr,
      endTimeUtc: utcEndTime,
      activeFromDateUtc: shiftDateStr(anchorDate, delta),
      activeUntilDateUtc: ev.recurrence.endDate ? shiftDateStr(ev.recurrence.endDate, delta) : null,
    };
  }

  function exportBundleEvent(ev) {
    var out = {
      active: ev.active !== false,
      notifyMinutesBeforeStart: ev.notifyMinutesBefore || 0,
    };
    // Only include these when the event overrides the bundle's own title/
    // description, so a re-import preserves which events inherit vs.
    // customize. Color is never per-event; it's always the bundle's.
    if (isOverridden(ev)) {
      out.title = ev.title;
      out.description = ev.description || '';
    }
    out.schedule = exportSchedule(ev);
    return out;
  }

  function buildBundleExportPayload(bundleId) {
    var b = getBundle(bundleId);
    if (!b) return null;
    return {
      raidTimeAppExport: {
        formatVersion: 1,
        exportedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        bundle: {
          title: b.title,
          description: b.description || '',
          color: b.color || DEFAULT_COLOR,
          events: eventsForBundle(b.id).map(exportBundleEvent),
        },
      },
    };
  }

  // ---------- import ----------

  function importSchedule(schedule) {
    if (!schedule) throw new Error('missing schedule');

    if (schedule.scheduleType === 'oneTime') {
      var s = new Date(schedule.startsAtUtc);
      var e = new Date(schedule.endsAtUtc);
      if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new Error('invalid date');
      return {
        kind: 'punctual',
        date: keyFor(s),
        recurrence: null,
        startTime: pad(s.getHours()) + ':' + pad(s.getMinutes()),
        endTime: pad(e.getHours()) + ':' + pad(e.getMinutes()),
      };
    }

    if (schedule.scheduleType === 'weekly') {
      var utcDays = (schedule.repeatsOnWeekdaysUtc || [])
        .map(function (name) { return WEEKDAY_NAMES.indexOf(String(name).toLowerCase()); })
        .filter(function (n) { return n >= 0; });
      if (utcDays.length === 0) throw new Error('no weekdays');

      var anchorUtcDate = schedule.activeFromDateUtc;
      var utcAnchorWeekday = weekdayOfDateStr(anchorUtcDate);
      var localAnchor = fromUtcDateTimeParts(anchorUtcDate, schedule.startTimeUtc);
      var delta = normalizeDayDelta(localAnchor.weekday - utcAnchorWeekday);
      var localDays = utcDays.map(function (d) { return (d + delta + 7) % 7; });
      var localEndTime = fromUtcDateTimeParts(anchorUtcDate, schedule.endTimeUtc).timeStr;

      return {
        kind: 'recurring',
        date: null,
        recurrence: {
          daysOfWeek: localDays,
          startDate: shiftDateStr(anchorUtcDate, delta),
          endDate: schedule.activeUntilDateUtc ? shiftDateStr(schedule.activeUntilDateUtc, delta) : null,
        },
        startTime: localAnchor.timeStr,
        endTime: localEndTime,
      };
    }

    throw new Error('unknown scheduleType');
  }

  // Shared shape validation for a parsed import payload — used by both the
  // real import and the conflict-check preview, so the two can never
  // disagree about what counts as "a valid RaidTimeApp bundle export."
  function extractBundleFromPayload(payload) {
    var root = payload && payload.raidTimeAppExport;
    var b = root && root.bundle;
    if (!b || !Array.isArray(b.events)) {
      throw new Error('Not a valid RaidTimeApp bundle export.');
    }
    return b;
  }

  // Parses every event's schedule (without importing anything) and checks
  // each against existing active events. Invalid entries are silently
  // skipped, same as the real import — that one already reports a "skipped"
  // count, this preview only needs to answer the conflict question.
  function previewImportConflicts(payload) {
    var b = extractBundleFromPayload(payload);
    var results = [];
    b.events.forEach(function (item) {
      var schedule;
      try {
        schedule = importSchedule(item.schedule);
      } catch (e) {
        return;
      }
      var label = item.title != null ? item.title : (b.title || 'Untitled Bundle');
      results.push({ label: label, conflicts: findConflicts(schedule, 0, null) });
    });
    return results;
  }

  function applyImportPayload(payload) {
    var b = extractBundleFromPayload(payload);

    var importedEvents = 0;
    var skipped = 0;

    var bundleId = uid();
    state.bundles.push({
      id: bundleId,
      title: b.title || 'Untitled Bundle',
      description: b.description || '',
      color: normalizeColor(b.color),
      hourOffset: 0,
    });

    b.events.forEach(function (item) {
      try {
        var schedule = importSchedule(item.schedule);
        state.events.push(Object.assign({
          id: uid(),
          bundleId: bundleId,
          title: item.title != null ? item.title : null,
          description: item.description != null ? item.description : null,
          active: item.active !== false,
          notifyMinutesBefore: normalizeNotify(item.notifyMinutesBeforeStart),
        }, schedule));
        importedEvents++;
      } catch (e) { skipped++; }
    });

    return { bundleTitle: state.bundles[state.bundles.length - 1].title, importedEvents: importedEvents, skipped: skipped };
  }

  var exportModalOverlay = document.getElementById('exportModalOverlay');
  var exportTextarea = document.getElementById('exportTextarea');
  var importModalOverlay = document.getElementById('importModalOverlay');
  var importTextarea = document.getElementById('importTextarea');
  var importFormError = document.getElementById('importFormError');
  var importConflictResult = document.getElementById('importConflictResult');

  document.getElementById('bundleExportBtn').addEventListener('click', function () {
    if (!currentDetailBundleId) return;
    var payload = buildBundleExportPayload(currentDetailBundleId);
    if (!payload) return;
    exportTextarea.value = JSON.stringify(payload);
    openModal(exportModalOverlay);
    exportTextarea.focus();
    exportTextarea.select();
  });

  document.getElementById('exportCopyBtn').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(exportTextarea.value);
    } catch (e) {
      exportTextarea.focus();
      exportTextarea.select();
      document.execCommand('copy');
    }
  });

  document.getElementById('importBundleBtn').addEventListener('click', function () {
    importTextarea.value = '';
    importFormError.hidden = true;
    importConflictResult.hidden = true;
    openModal(importModalOverlay);
    importTextarea.focus();
  });

  document.getElementById('importCheckConflictsBtn').addEventListener('click', function () {
    importFormError.hidden = true;
    importConflictResult.hidden = true;
    var text = importTextarea.value.trim();
    if (!text) {
      importFormError.textContent = 'Paste a bundle export JSON first.';
      importFormError.hidden = false;
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      importFormError.textContent = 'That is not valid JSON.';
      importFormError.hidden = false;
      return;
    }
    var results;
    try {
      results = previewImportConflicts(parsed);
    } catch (e) {
      importFormError.textContent = e.message || 'That is not a valid RaidTimeApp bundle export.';
      importFormError.hidden = false;
      return;
    }
    renderBatchConflictResult(importConflictResult, results);
  });

  document.getElementById('importConfirmBtn').addEventListener('click', function () {
    importFormError.hidden = true;
    var text = importTextarea.value.trim();
    if (!text) {
      importFormError.textContent = 'Paste a bundle export JSON first.';
      importFormError.hidden = false;
      return;
    }
    var parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      importFormError.textContent = 'That is not valid JSON.';
      importFormError.hidden = false;
      return;
    }
    var summary;
    try {
      summary = applyImportPayload(parsed);
    } catch (e) {
      importFormError.textContent = e.message || 'That is not a valid RaidTimeApp bundle export.';
      importFormError.hidden = false;
      return;
    }
    persist();
    renderCalendar();
    closeModal(importModalOverlay);
    if (bundlesListModalOverlay.classList.contains('open')) openBundlesListModal();
    var msg = 'Imported bundle "' + summary.bundleTitle + '" with ' + summary.importedEvents + ' event(s).';
    if (summary.skipped) msg += ' Skipped ' + summary.skipped + ' invalid entr' + (summary.skipped === 1 ? 'y' : 'ies') + '.';
    window.alert(msg);
  });

  // ---------- settings ----------

  var settingsModalOverlay = document.getElementById('settingsModalOverlay');
  var timeFormat24Btn = document.getElementById('timeFormat24Btn');
  var timeFormat12Btn = document.getElementById('timeFormat12Btn');
  var dateFormatSelect = document.getElementById('dateFormatSelect');
  var startWithWindowsToggle = document.getElementById('startWithWindowsToggle');
  var settingsModalTimeFormat = '24h';

  function setSettingsModalTimeFormat(fmt) {
    settingsModalTimeFormat = fmt;
    timeFormat24Btn.classList.toggle('active', fmt === '24h');
    timeFormat12Btn.classList.toggle('active', fmt === '12h');
  }
  timeFormat24Btn.addEventListener('click', function () { setSettingsModalTimeFormat('24h'); });
  timeFormat12Btn.addEventListener('click', function () { setSettingsModalTimeFormat('12h'); });

  document.getElementById('settingsBtn').addEventListener('click', async function () {
    setSettingsModalTimeFormat(state.settings.timeFormat);
    dateFormatSelect.value = state.settings.dateFormat;
    var liveLoginItemStatus = null;
    try {
      liveLoginItemStatus = await window.api.getLoginItemStatus();
    } catch (e) {
      liveLoginItemStatus = null;
    }
    startWithWindowsToggle.checked = liveLoginItemStatus != null ? liveLoginItemStatus : state.settings.startWithWindows;
    openModal(settingsModalOverlay);
  });

  document.getElementById('settingsSaveBtn').addEventListener('click', function () {
    state.settings = {
      timeFormat: settingsModalTimeFormat,
      dateFormat: dateFormatSelect.value,
      startWithWindows: startWithWindowsToggle.checked,
    };
    persist();
    renderCalendar();
    closeModal(settingsModalOverlay);
  });

  // ---------- init ----------

  renderWeekdays();
  loadData().then(renderCalendar);
})();
