// Stock turnover = weekly COGS ÷ ((Monday stock value + Sunday stock value) ÷ 2)
// Days of stock  = 7 ÷ turnover.  Target 0.23 a week (higher turnover is better).

const { statusFor, percentOf } = require('./status');

function stockTurnover({ weeklyCogs, openingStock, closingStock, target = 0.23 }) {
  const nums = [weeklyCogs, openingStock, closingStock];
  if (nums.some((n) => n === null || n === undefined || n === '')) {
    return { turnover: null, daysOfStock: null, averageStock: null, pct: null, status: 'no_data' };
  }
  const averageStock = (Number(openingStock) + Number(closingStock)) / 2;
  const turnover = averageStock > 0 ? Number(weeklyCogs) / averageStock : null;
  const daysOfStock = turnover > 0 ? 7 / turnover : null;
  const pct = percentOf(turnover, target);
  return { turnover, daysOfStock, averageStock, pct, status: statusFor(pct, { hasTarget: target !== null }) };
}

module.exports = { stockTurnover };
