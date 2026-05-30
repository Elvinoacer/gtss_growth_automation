/**
 * pipelinesPage.js — Page route for /pipelines
 */
const express = require('express');
const { renderPage } = require('./pageRenderer');

const router = express.Router();

router.get('/pipelines', (req, res) => {
  renderPage(res, {
    title: 'Pipelines',
    primaryHeading: 'Pipeline Scheduler',
    primaryCopy: 'Configure and monitor automated pipelines for outreach and content posting.',
  });
});

module.exports = router;
