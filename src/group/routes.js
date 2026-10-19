// Group scoreboard: managers, HQ and admin.

const express = require('express');
const calc = require('../calc');
const fmt = require('../scoreboard/format');
const { scoreboardAccess } = require('../scoreboard/routes');
const { weekChoices, pickWeek } = require('../lib/weeks');
const { buildGroup } = require('./data');
const { sheetYearCard } = require('../sales/data');

// 19 Oct: everyone sees the group scoreboard (staff and HQ staff without links into branches).
const canSeeGroup = (user) => ['branch_staff', 'branch_manager', 'hq', 'hq_staff', 'admin'].includes(user.role);

function groupRoutes(db, { now, trackerStart }) {
  const router = express.Router();

  router.get('/group', async (req, res, next) => {
    try {
      if (!canSeeGroup(req.user)) {
        return res.status(403).render('message', { title: 'Group scoreboard', message: 'The group scoreboard is for branch managers, HQ and admin.' });
      }
      const today = calc.todayInMalaysia(now());
      const start = await trackerStart();
      const weeks = weekChoices(start, today);
      const current = weeks[weeks.length - 1];
      const week = pickWeek(req.query.week, weeks, current);
      const group = await buildGroup(db, { week, today, trackerStart: start });

      // Links into a branch only where this login may open it (managers: their own branch).
      const branchIds = new Map((await db.query('SELECT id, code FROM branches')).rows.map((b) => [b.code, b.id]));
      const canOpen = (code) => scoreboardAccess(req.user, { id: branchIds.get(code) }) === null;
      const qs = (code) => (req.user.role === 'branch_manager' ? '' : `&branch=${encodeURIComponent(code)}`);

      const yearCard = await sheetYearCard(db, { today });
      res.render('group', {
        title: 'Group scoreboard', group, fmt, today, week, canOpen, qs, yearCard,
        pills: weeks.map((w) => ({ href: `/group?week=${w}`, current: w === week, label: w === current ? 'This week' : fmt.weekLabel(w, calc.addDays(w, 6)) })),
      });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { groupRoutes, canSeeGroup };
