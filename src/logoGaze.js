const MAX_GAZE_SVG_UNITS = 34;
const FULL_GAZE_DISTANCE_PX = 320;
const GAZE_EASING = 0.2;
const GAZE_EPSILON = 0.08;

/**
 * Convert a viewport pointer position into a bounded gaze offset.
 * The response ramps up near the logo, then caps for a restrained parallax.
 *
 * @param {number} clientX - Pointer x coordinate in CSS pixels.
 * @param {number} clientY - Pointer y coordinate in CSS pixels.
 * @param {{left:number, top:number, width:number, height:number}} rect - Logo bounds.
 * @param {number} [maxOffset=MAX_GAZE_SVG_UNITS] - Maximum SVG-space translation.
 * @returns {{x:number, y:number}}
 */
export function calculateLogoGaze(
  clientX,
  clientY,
  rect,
  maxOffset = MAX_GAZE_SVG_UNITS,
) {
  const values = [
    clientX,
    clientY,
    rect?.left,
    rect?.top,
    rect?.width,
    rect?.height,
    maxOffset,
  ];
  if (
    !values.every(Number.isFinite) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    maxOffset < 0
  ) {
    return { x: 0, y: 0 };
  }

  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };

  const strength = Math.min(distance / FULL_GAZE_DISTANCE_PX, 1);
  const scale = (maxOffset * strength) / distance;
  return { x: dx * scale, y: dy * scale };
}

/**
 * Make every raster logo marked with `data-logo-gaze` follow the pointer with
 * subtle parallax. Returns a cleanup callback.
 *
 * @param {Document|Element} [root=document] - DOM root to search.
 * @returns {() => void}
 */
export function initLogoGaze(root = document) {
  if (typeof window === 'undefined' || !root?.querySelectorAll) return () => {};

  const logos = [...root.querySelectorAll('[data-logo-gaze]')];
  if (!logos.length) return () => {};

  const reducedMotion = window.matchMedia?.(
    '(prefers-reduced-motion: reduce)',
  ).matches;
  const states = logos.map((element) => ({
    element,
    visual: element.querySelector('img'),
    currentX: 0,
    currentY: 0,
    targetX: 0,
    targetY: 0,
  }));
  let animationFrame = 0;

  const applyTransform = (state) => {
    if (!state.visual) return;
    const x = state.currentX / 6;
    const y = state.currentY / 6;
    state.visual.style.setProperty('--logo-gaze-x', `${x.toFixed(2)}px`);
    state.visual.style.setProperty('--logo-gaze-y', `${y.toFixed(2)}px`);
    state.visual.style.setProperty(
      '--logo-tilt-x',
      `${(-y * 0.45).toFixed(2)}deg`,
    );
    state.visual.style.setProperty(
      '--logo-tilt-y',
      `${(x * 0.45).toFixed(2)}deg`,
    );
  };

  const animate = () => {
    animationFrame = 0;
    let keepAnimating = false;

    for (const state of states) {
      const deltaX = state.targetX - state.currentX;
      const deltaY = state.targetY - state.currentY;

      if (
        Math.abs(deltaX) <= GAZE_EPSILON &&
        Math.abs(deltaY) <= GAZE_EPSILON
      ) {
        state.currentX = state.targetX;
        state.currentY = state.targetY;
      } else {
        state.currentX += deltaX * GAZE_EASING;
        state.currentY += deltaY * GAZE_EASING;
        keepAnimating = true;
      }
      applyTransform(state);
    }

    if (keepAnimating) animationFrame = window.requestAnimationFrame(animate);
  };

  const scheduleAnimation = () => {
    if (!animationFrame) animationFrame = window.requestAnimationFrame(animate);
  };

  for (const state of states) applyTransform(state);

  const onPointerMove = (event) => {
    if (reducedMotion || event.pointerType === 'touch') return;
    for (const state of states) {
      const gaze = calculateLogoGaze(
        event.clientX,
        event.clientY,
        state.element.getBoundingClientRect(),
      );
      state.targetX = gaze.x;
      state.targetY = gaze.y;
    }
    scheduleAnimation();
  };

  const resetGaze = () => {
    for (const state of states) {
      state.targetX = 0;
      state.targetY = 0;
    }
    scheduleAnimation();
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('blur', resetGaze);
  document.documentElement.addEventListener('pointerleave', resetGaze);

  return () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('blur', resetGaze);
    document.documentElement.removeEventListener('pointerleave', resetGaze);
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
  };
}
