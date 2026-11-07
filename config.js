/**
 * config.js — single place to set the backend URL
 * Render deployment: https://resume-portal-v03n.onrender.com
 */
window.TTP_BACKEND = window.TTP_BACKEND
  || localStorage.getItem('ttp_backend')
  || 'https://resume-portal-v03n.onrender.com';
