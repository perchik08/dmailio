function dayUnit(days) {
  const lastTwo = days % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return "дней";
  if (days % 10 === 1) return "день";
  if (days % 10 >= 2 && days % 10 <= 4) return "дня";
  return "дней";
}

export function updateSequenceDelay(steps, index, rawValue) {
  const days = Number(rawValue);
  if (
    !Number.isInteger(index) ||
    index < 1 ||
    index >= steps.length ||
    !Number.isInteger(days) ||
    days < 0 ||
    days > 365
  )
    return false;
  steps[index].delay = days;
  return true;
}

export function renderSequenceSidebar(steps, selectedIndex, editable, escape) {
  return steps
    .map((step, index) => {
      const delay = Number(step.delay) || 0;
      const delayRow = index
        ? `<label class="step-delay"><span>Отправить через</span><input data-step-delay="${index}" type="number" min="0" max="365" step="1" value="${escape(delay)}" ${editable ? "" : "disabled"}><span>${dayUnit(delay)}</span></label>`
        : "";
      return `${delayRow}<div class="step ${index === selectedIndex ? "selected" : ""}"><button type="button" data-step="${index}">Письмо ${index + 1}</button><p>${escape(step.subject || (index ? "Тема предыдущего письма" : "Начало цепочки"))}</p></div>`;
    })
    .join("");
}
