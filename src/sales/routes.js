// The Sales page: the sales sheet's daily totals and the year table, as HQ sees them in Google.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { buildSalesView } = require('./data');

const canSeeSales = (user) => ['branch_manager', 'hq', 'hq_staff', 'admin'].includes(user.role);

function salesRoutes(db, { now, salesSheet = null }) {
  const router = express.Router();

  router.get('/sales', async (req, res, next) => {
    try {
      if (!canSeeSales(req.user)) {
        return res.status(403).render('message', { title: 'Sales', message: 'The sales view is for branch managers, HQ and admin.' });
      }
      const today = calc.todayInMalaysia(now());
      const thisMonth = today.slice(0, 7);
      const year = today.slice(0, 4);
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || '') && req.query.month <= thisMonth && req.query.month.startsWith(year)
        ? req.query.month : thisMonth;
      const chart = typeof req.query.chart === 'string' ? req.query.chart : 'TOTAL';
      const view = await buildSalesView(db, { today, month, chart });
      const sheet = salesSheet ? await salesSheet.status() : null;
      const months = [];
      for (let m = 1; m <= Number(thisMonth.slice(5)); m++) months.push(`${year}-${String(m).padStart(2, '0')}`);
      res.render('sales', { title: 'Sales', view, fmt, today, month, months, sheet });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { salesRoutes, canSeeSales };
