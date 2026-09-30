/**
 * Rounds down to the nearest exchange step/tick — Binance rejects orders that don't
 * align exactly to LOT_SIZE/PRICE_FILTER, and rounding up could overspend/oversell.
 * Works in integer space (scaled by the step's decimal precision) to avoid float
 * division artifacts like 0.1 / 0.001 = 99.999999999999.
 */
export function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const decimals = countDecimals(step);
  const factor = 10 ** decimals;
  const scaledStep = Math.round(step * factor);
  // Epsilon guards against float artifacts like 0.1 * 1000 = 100.00000000000001.
  const steps = Math.floor((value * factor + 1e-9) / scaledStep);
  return Number(((steps * scaledStep) / factor).toFixed(decimals));
}

export function meetsMinNotional(qty: number, price: number, minNotional: number): boolean {
  if (minNotional <= 0) return true;
  return qty * price >= minNotional;
}

function countDecimals(value: number): number {
  const str = value.toString();
  if (!str.includes('.')) return 0;
  return str.split('.')[1].replace(/0+$/, '').length;
}
