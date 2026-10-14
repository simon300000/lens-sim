const clampHour = (hour) => Math.min(24, Math.max(0, Number(hour) || 0));

/** Display the endpoint as 24:00, preserving the slider's full-day range. */
export function formatTime(hour) {
  const minutes = Math.round(clampHour(hour) * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function createTimeControls({ onChange, initialHour = 16.5, initialDate = '2026-09-26' } = {}) {
  const panel = document.querySelector('#time-controls');
  const slider = panel.querySelector('#time-slider');
  const dateInput = panel.querySelector('#time-date');
  const timeOutput = panel.querySelector('#time-output');
  const periodOutput = panel.querySelector('#time-period');
  const readout = panel.querySelector('#time-readout');
  const presetButtons = [...panel.querySelectorAll('[data-hour]')];
  let hour = clampHour(initialHour);
  let date = initialDate;

  function renderTime() {
    const label = formatTime(hour);
    slider.value = String(hour);
    slider.style.setProperty('--time-progress', `${hour / 24 * 100}%`);
    slider.setAttribute('aria-valuetext', `${label}，日本标准时间`);
    timeOutput.value = label;
    timeOutput.textContent = label;
    dateInput.value = date;
    for (const button of presetButtons) {
      button.setAttribute('aria-pressed', String(Math.abs(Number(button.dataset.hour) - hour) < 1 / 120));
    }
  }

  function emitChange() {
    renderTime();
    onChange?.({ hour, date });
  }

  slider.addEventListener('input', () => {
    hour = clampHour(slider.value);
    emitChange();
  });
  dateInput.addEventListener('change', () => {
    // A cleared date cannot define a physical sky; keep the last valid date.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput.value) || !dateInput.validity.valid) {
      dateInput.value = date;
      return;
    }
    date = dateInput.value;
    emitChange();
  });
  for (const button of presetButtons) {
    button.addEventListener('click', () => {
      hour = Number(button.dataset.hour);
      emitChange();
    });
  }

  renderTime();

  return {
    getValue() { return { hour, date }; },
    setHour(nextHour) {
      hour = clampHour(nextHour);
      emitChange();
    },
    update(state = {}) {
      if (Number.isFinite(state.hour)) hour = clampHour(state.hour);
      if (state.date) date = state.date;
      renderTime();
      if (state.periodLabel) periodOutput.textContent = state.periodLabel;
      if (Number.isFinite(state.nightFactor)) {
        document.body.dataset.night = String(state.nightFactor > 0.55);
      }
      if (state.periodLabel) document.body.dataset.period = state.periodLabel;
      const hasAltitudes = Number.isFinite(state.sunAltitude) && Number.isFinite(state.moonAltitude);
      if (hasAltitudes) {
        const altitude = (value) => `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(0)}°`;
        readout.textContent = `日 ${altitude(state.sunAltitude)} · 月 ${altitude(state.moonAltitude)}`;
        const detail = [`太阳高度 ${state.sunAltitude.toFixed(1)}°`, `月亮高度 ${state.moonAltitude.toFixed(1)}°`];
        if (Number.isFinite(state.sunKelvin)) detail.push(`日光色温 ${Math.round(state.sunKelvin)} K`);
        if (state.phaseName) detail.push(state.phaseName);
        if (Number.isFinite(state.moonIllumination)) detail.push(`月面照明 ${Math.round(state.moonIllumination * 100)}%`);
        readout.title = detail.join(' · ');
        readout.setAttribute('aria-label', detail.join('，'));
      }
    },
  };
}
