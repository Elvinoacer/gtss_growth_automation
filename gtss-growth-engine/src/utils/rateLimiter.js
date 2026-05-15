const limits = require('../config/limits');
const { getDb, getDailyActionCount } = require('../db/database');

function getLimit(platform, actionType) {
  return limits[platform] && limits[platform][actionType];
}

function getUsage(platform, actionType) {
  return getDailyActionCount(platform, actionType);
}

function canPerform(platform, actionType, amount = 1) {
  const limit = getLimit(platform, actionType);
  if (typeof limit !== 'number') {
    return { allowed: false, reason: 'Unknown platform action limit' };
  }

  const used = getUsage(platform, actionType);
  return {
    allowed: used + amount <= limit,
    used,
    remaining: Math.max(limit - used, 0),
    limit
  };
}

function recordAction(platform, actionType, amount = 1) {
  const check = canPerform(platform, actionType, amount);
  if (!check.allowed) {
    return check;
  }

  const insert = getDb().prepare(
    `INSERT INTO daily_actions (platform, action_type, outcome)
     VALUES (?, ?, ?)`
  );

  const transaction = getDb().transaction(() => {
    for (let index = 0; index < amount; index += 1) {
      insert.run(platform, actionType, 'sent');
    }
  });

  transaction();

  return canPerform(platform, actionType, 0);
}

module.exports = {
  canPerform,
  recordAction,
  getUsage
};
