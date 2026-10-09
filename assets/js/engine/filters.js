// One Euro filter (Casiez et al., 2012): low jitter when still, low lag when moving fast.
// Used to smooth joint angles before they drive the rep counter.

function smoothingFactor(cutoff, dtSeconds) {
  const r = 2 * Math.PI * cutoff * dtSeconds;
  return r / (r + 1);
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.02, derivativeCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.reset();
  }

  reset() {
    this.prevValue = null;
    this.prevDerivative = 0;
    this.prevTime = null;
  }

  filter(value, timeMs) {
    if (this.prevValue === null || this.prevTime === null || timeMs <= this.prevTime) {
      this.prevValue = value;
      this.prevTime = timeMs;
      return value;
    }
    const dt = (timeMs - this.prevTime) / 1000;
    const derivative = (value - this.prevValue) / dt;
    const aD = smoothingFactor(this.derivativeCutoff, dt);
    const smoothedDerivative = aD * derivative + (1 - aD) * this.prevDerivative;
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    const a = smoothingFactor(cutoff, dt);
    const smoothed = a * value + (1 - a) * this.prevValue;

    this.prevValue = smoothed;
    this.prevDerivative = smoothedDerivative;
    this.prevTime = timeMs;
    return smoothed;
  }
}
