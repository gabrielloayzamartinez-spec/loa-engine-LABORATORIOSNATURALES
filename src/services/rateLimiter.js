// src/services/rateLimiter.js
// Centralised rate limiting for external APIs (vTiger, commercial_engine, GHL)
// Uses Bottleneck to enforce 30‑60 RPS (default 45 RPS) per service.

const Bottleneck = require('bottleneck');

function rpsToMinTime(rps) {
  const safeRps = Number(rps) || 45; // fallback to 45 RPS if not set
  return Math.round(1000 / safeRps);
}

// vTiger limiter
const vtigerLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: rpsToMinTime(process.env.VTIGER_RPS || 45)
});

// Commercial engine limiter
const commercialLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: rpsToMinTime(process.env.COMMERCIAL_RPS || 45)
});

// GHL limiter
const ghlLimiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: rpsToMinTime(process.env.GHL_RPS || 45)
});

module.exports = { vtigerLimiter, commercialLimiter, ghlLimiter };
