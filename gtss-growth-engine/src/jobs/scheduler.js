const cron = require('node-cron');
const logger = require('../utils/logger');

function registerJobs() {
  cron.schedule('0 8 * * *', () => {
    logger.info('Daily growth automation window opened');
  });
}

module.exports = {
  registerJobs
};
