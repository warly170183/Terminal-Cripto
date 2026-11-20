const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/**
 * Standard normal probability density function φ(x).
 */
export function normPDF(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/**
 * Standard normal cumulative distribution function N(x).
 * Abramowitz & Stegun rational approximation (max error < 7.5e-8).
 */
export function normCDF(x: number): number {
  if (!Number.isFinite(x)) {
    return x > 0 ? 1 : 0;
  }
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * absX);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * erf);
}

/**
 * Computes Black-Scholes delta and gamma (1 / $) for European options with r = 0.
 */
export function bsDeltaGamma(
  S: number,
  K: number,
  T: number,
  iv: number,
  type: 'C' | 'P'
): { delta: number; gamma: number } {
  if (S <= 0 || K <= 0 || T <= 1e-7 || iv <= 1e-5) {
    const itmCall = S > K ? 1 : S < K ? 0 : 0.5;
    return {
      delta: type === 'C' ? itmCall : itmCall - 1,
      gamma: 0,
    };
  }
  const sqrtT = Math.sqrt(T);
  const volSqrtT = iv * sqrtT;
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / volSqrtT;
  const nd1 = normCDF(d1);
  const delta = type === 'C' ? nd1 : nd1 - 1;
  const gamma = normPDF(d1) / (S * volSqrtT);
  return { delta, gamma };
}
