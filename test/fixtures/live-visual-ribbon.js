(() => {
  const meter = document.querySelector('#mic-input-meter');
  if (!meter) return;
  const levels = [
    [0.15,.32,.72,.55,.18], [.1,.38,.88,.62,.22], [.14,.5,.94,.75,.28],
    [.1,.44,.8,.72,.33], [.18,.6,1,.66,.24], [.12,.48,.82,.58,.18],
    [.2,.66,.96,.54,.15], [.12,.54,.78,.46,.11], [.16,.7,.9,.48,.12], [.1,.42,.62,.36,.08],
  ];

  meter.replaceChildren();
  levels.forEach((bands, index) => {
    const floor = Math.min(...bands);
    let weights = bands.map((value) => Math.max(0, value - floor));
    let total = weights.reduce((sum, value) => sum + value, 0);
    if (total <= 1e-6) {
      weights = bands;
      total = weights.reduce((sum, value) => sum + value, 0);
    }
    const centroid = weights.reduce((sum, value, band) => sum + value * (band / 4), 0) / total;
    const variance = weights.reduce((sum, value, band) => sum + value * ((band / 4 - centroid) ** 2), 0) / total;
    const presence = Math.max(...bands);
    const center = Math.max(.2, Math.min(.8, .76 - centroid * .52));
    const height = Math.max(.18, Math.min(.58, .18 + Math.sqrt(variance) * 1.05 + presence * .09));
    const top = Math.max(0, Math.min(1 - height, center - height / 2));

    const slice = document.createElement('span');
    slice.className = 'voice-presence-slice';
    slice.style.opacity = String(.28 + index / 9 * .72);
    const shape = document.createElement('span');
    shape.className = 'voice-presence-shape';
    shape.style.top = `${top * 100}%`;
    shape.style.height = `${height * 100}%`;
    shape.style.opacity = String(.035 + presence * .93);
    slice.append(shape);
    meter.append(slice);
  });
})();
