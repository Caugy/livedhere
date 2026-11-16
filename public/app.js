(() => {
  function paintStars(group) {
    const checked = group.querySelector('input[type="radio"]:checked');
    const value = checked ? Number(checked.value) : 0;
    group.querySelectorAll('.star-opt').forEach((label) => {
      const input = label.querySelector('input');
      label.classList.toggle('is-on', Number(input.value) <= value && value > 0);
    });
    const clear = group.querySelector('.star-clear');
    if (clear) clear.hidden = value === 0;
  }

  document.querySelectorAll('.star-input').forEach((group) => {
    paintStars(group);
    group.addEventListener('change', () => paintStars(group));
    group.addEventListener('mouseover', (event) => {
      const opt = event.target.closest('.star-opt');
      if (!opt) return;
      const hoverVal = Number(opt.querySelector('input').value);
      group.querySelectorAll('.star-opt').forEach((label) => {
        label.classList.toggle('is-on', Number(label.querySelector('input').value) <= hoverVal);
      });
    });
    group.addEventListener('mouseleave', () => paintStars(group));
  });

  document.querySelectorAll('.star-clear').forEach((button) => {
    button.addEventListener('click', () => {
      const name = button.getAttribute('data-clear');
      document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
        input.checked = false;
      });
      const group = button.closest('.star-input') || button.closest('.segmented-wrap');
      if (group && group.classList.contains('star-input')) paintStars(group);
      group?.querySelectorAll('.segmented label')?.forEach((label) => label.classList.remove('is-selected'));
    });
  });

  document.querySelectorAll('.segmented').forEach((group) => {
    group.addEventListener('change', () => {
      group.querySelectorAll('label').forEach((label) => {
        label.classList.toggle('is-selected', label.querySelector('input').checked);
      });
    });
  });

  function syncOccupancy(form) {
    if (!form) return;
    const selected = form.querySelector('input[name="occupancy_type"]:checked');
    const occupancy = selected ? selected.value : form.getAttribute('data-occupancy') || '';
    if (occupancy) form.setAttribute('data-occupancy', occupancy);
    form.querySelectorAll('[data-show-if], .show-if-rented, .show-if-owned').forEach((block) => {
      const showIf = block.getAttribute('data-show-if') || (block.classList.contains('show-if-owned') ? 'owned' : block.classList.contains('show-if-rented') ? 'rented' : '');
      const show = !occupancy || !showIf || showIf === occupancy;
      block.hidden = !show;
      block.querySelectorAll('input, select, textarea').forEach((input) => {
        input.disabled = !show;
      });
    });
  }

  function syncStillLiving(form) {
    if (!form) return;
    const checked = form.querySelector('input[name="still_living"]')?.checked;
    const until = form.querySelector('select[name="year_to"]');
    if (until) until.disabled = Boolean(checked);
  }

  document.querySelectorAll('.review-form, .auth-form, .form-block').forEach((form) => {
    form.addEventListener('change', (event) => {
      if (event.target.name === 'occupancy_type') syncOccupancy(form);
      if (event.target.name === 'still_living') syncStillLiving(form);
    });
    syncOccupancy(form);
    syncStillLiving(form);
  });

  document.querySelectorAll('.js-confirm-delete').forEach((formEl) => {
    formEl.addEventListener('submit', (event) => {
      const message = formEl.getAttribute('data-confirm') || 'Delete this review? This cannot be undone.';
      if (!window.confirm(message)) event.preventDefault();
    });
  });

  const dialog = document.getElementById('report-dialog');
  const reportForm = document.getElementById('report-form');
  const excerpt = document.getElementById('report-dialog-excerpt');
  document.querySelectorAll('.js-open-report').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-review-id');
      if (!dialog || !reportForm || !id) {
        window.location.href = `/reviews/${id}/report`;
        return;
      }
      reportForm.setAttribute('action', `/reviews/${id}/report`);
      if (excerpt) excerpt.textContent = button.getAttribute('data-review-excerpt') || '';
      reportForm.reset();
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else window.location.href = `/reviews/${id}/report`;
    });
  });
  document.querySelectorAll('.js-close-dialog').forEach((button) => {
    button.addEventListener('click', () => dialog?.close());
  });
})();
